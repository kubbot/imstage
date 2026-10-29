import importlib.util
import json
import pathlib
import plistlib
import sqlite3
import subprocess
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('macos', pathlib.Path(__file__).parents[1] / 'deploy/macos.py')
macos = importlib.util.module_from_spec(spec)
spec.loader.exec_module(macos)


class MacReleaseTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name).resolve()
        self.revision = 'a' * 40
        self.release = self.root / 'releases' / self.revision
        (self.release / 'deploy').mkdir(parents=True)
        (self.release / 'deploy/macos.py').write_text('# fixture updater')
        (self.root / 'data').mkdir()
        with sqlite3.connect(self.root / 'data/imstage.db') as db:
            db.execute('CREATE TABLE evidence(value TEXT)')
            db.execute("INSERT INTO evidence VALUES ('existing-user-data')")
        self.plist = self.root / 'service.plist'
        self.old_plist = plistlib.dumps({'Label': 'com.imstage.web', 'ProgramArguments': ['old-server'], 'EnvironmentVariables': {'IMSTAGE_APP_ORIGIN': 'https://old.example'}})
        self.plist.write_bytes(self.old_plist)
        smoke = self.root / 'smoke.json'
        smoke.write_text(json.dumps({'email': 'fixture@example.com', 'password': 'private-fixture-password'}))
        smoke.chmod(0o600)
        self.cfg = {'stateDir': str(self.root / 'state'), 'releaseRoot': str(self.root / 'releases'), 'sourceRoot': str(self.root / 'source'), 'dataDir': str(self.root / 'data'), 'servicePlist': str(self.plist), 'label': 'com.imstage.web', 'node': '/fixture/node', 'gh': '/fixture/gh', 'appOrigin': 'https://app.example', 'webPort': 4417, 'environmentFiles': ['/private/provider.env'], 'smokeFile': str(smoke)}
        self.commands = []
        self.fail_smoke = False
        disk = patch.object(macos.shutil, 'disk_usage', return_value=types.SimpleNamespace(free=64 * 1024**3))
        disk.start()
        self.addCleanup(disk.stop)

    def command(self, command, **kwargs):
        self.commands.append(command)
        if command[0] == '/fixture/node':
            payload = json.loads(kwargs['input'])
            self.assertEqual(payload['expectedRevision'], self.revision)
            if self.fail_smoke:
                raise subprocess.CalledProcessError(1, command)
        return subprocess.CompletedProcess(command, 0, stdout='')

    def activate(self):
        with patch.object(macos.subprocess, 'run', side_effect=self.command), patch.object(macos, 'wait_ready'):
            macos.activate(self.cfg, self.release, self.revision)

    def test_activation_keeps_existing_database_and_commits_only_after_smoke(self):
        self.activate()
        active = json.loads((self.root / 'state/active.json').read_text())
        self.assertEqual(active['revision'], self.revision)
        deployed = plistlib.loads(self.plist.read_bytes())
        self.assertEqual(deployed['EnvironmentVariables']['IMSTAGE_RELEASE_REVISION'], self.revision)
        self.assertEqual(deployed['EnvironmentVariables']['IMSTAGE_DATA_DIR'], self.cfg['dataDir'])
        self.assertEqual(deployed['EnvironmentVariables']['IMSTAGE_APP_ORIGIN'], 'https://app.example')
        backup = next((self.root / 'state/backups').glob('*.sqlite'))
        with sqlite3.connect(backup) as db:
            self.assertEqual(db.execute('SELECT value FROM evidence').fetchone()[0], 'existing-user-data')
        self.assertNotIn('private-fixture-password', json.dumps(self.commands))

    def test_failed_login_restores_exact_previous_launch_agent_and_does_not_commit(self):
        self.fail_smoke = True
        with self.assertRaises(subprocess.CalledProcessError):
            self.activate()
        self.assertEqual(self.plist.read_bytes(), self.old_plist)
        self.assertFalse((self.root / 'state/active.json').exists())
        self.assertTrue(any(command[1] == 'bootstrap' for command in self.commands if command[0] == 'launchctl'))

    def test_missing_database_stops_before_changing_the_running_service(self):
        self.cfg['dataDir'] = str(self.root / 'missing-data')
        with self.assertRaises(ValueError):
            self.activate()
        self.assertEqual(self.commands, [])
        self.assertEqual(self.plist.read_bytes(), self.old_plist)

    def test_signal_after_commit_does_not_restore_old_launch_agent(self):
        original = macos.atomic_write

        def committed_then_interrupted(path, value):
            original(path, value)
            if path.name == 'active.json':
                raise SystemExit('simulated signal')

        with patch.object(macos, 'atomic_write', side_effect=committed_then_interrupted):
            with self.assertRaises(SystemExit):
                self.activate()
        self.assertEqual(plistlib.loads(self.plist.read_bytes())['EnvironmentVariables']['IMSTAGE_RELEASE_REVISION'], self.revision)
        self.assertEqual(sum(c[1] == 'bootstrap' for c in self.commands if c[0] == 'launchctl'), 1)

    def test_only_successful_exact_main_push_ci_is_eligible(self):
        def output(command, **kwargs):
            if command[0] == '/fixture/gh':
                return subprocess.CompletedProcess(command, 0, stdout=json.dumps([{'headSha': self.revision, 'headBranch': 'main', 'event': 'pull_request', 'status': 'completed', 'conclusion': 'success'}]))
            value = 'https://github.com/kubbot/imstage.git' if 'remote' in command else self.revision
            return subprocess.CompletedProcess(command, 0, stdout=value)
        with patch.object(macos.subprocess, 'run', side_effect=output):
            self.assertIsNone(macos.checked_revision(self.cfg))

    def test_pause_marker_prevents_fetch_or_build(self):
        pause = self.root / 'pause'
        pause.touch()
        self.cfg['pauseFile'] = str(pause)
        with patch.object(macos.subprocess, 'run') as run:
            self.assertEqual(macos.update(self.cfg)['status'], 'paused')
            run.assert_not_called()

    def test_dependency_snapshot_survives_changes_and_removal_of_its_source(self):
        source, destination = self.root / 'dependencies', self.root / 'snapshot'
        source.mkdir()
        (source / 'module.js').write_text('verified dependency')
        macos.snapshot_dependencies(source, destination)
        (source / 'module.js').write_text('development changed')
        (source / 'module.js').unlink()
        self.assertFalse(destination.is_symlink())
        self.assertEqual((destination / 'module.js').read_text(), 'verified dependency')

    def test_unchanged_release_repairs_an_interrupted_updater_copy(self):
        state = self.root / 'state'
        state.mkdir()
        (state / 'active.json').write_text(json.dumps({'revision': self.revision}))
        with patch.object(macos, 'checked_revision', return_value=self.revision):
            self.assertEqual(macos.update(self.cfg)['status'], 'unchanged')
        self.assertEqual((state / 'updater.py').read_text(), '# fixture updater')

    def test_failed_revision_backs_off_without_restarting_the_service_again(self):
        self.fail_smoke = True
        with patch.object(macos, 'checked_revision', return_value=self.revision), patch.object(macos, 'prepare', return_value=self.release), patch.object(macos.subprocess, 'run', side_effect=self.command), patch.object(macos, 'wait_ready'):
            with self.assertRaises(subprocess.CalledProcessError):
                macos.update(self.cfg)
            count = len(self.commands)
            self.assertEqual(macos.update(self.cfg)['status'], 'backoff')
            self.assertEqual(len(self.commands), count)
        self.assertEqual(json.loads((self.root / 'state/last-failure.json').read_text())['attempts'], 1)


if __name__ == '__main__':
    unittest.main()
