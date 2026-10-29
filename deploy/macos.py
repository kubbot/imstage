#!/usr/bin/env python3
"""Publish checked main commits to the existing per-user macOS IMStage service."""
import argparse
import datetime
import fcntl
import json
import os
import pathlib
import plistlib
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid


def atomic_write(path, value):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name('.' + path.name + '-' + uuid.uuid4().hex)
    try:
        with temporary.open('xb') as handle:
            os.chmod(temporary, 0o600)
            handle.write(value)
        temporary.replace(path)
    finally:
        if temporary.exists():
            temporary.unlink()


def checked_revision(cfg):
    source = cfg['sourceRoot']
    remote = subprocess.run(['git', '-C', source, 'remote', 'get-url', 'origin'], check=True, capture_output=True, text=True).stdout.strip()
    if remote not in ['https://github.com/kubbot/imstage.git', 'git@github.com:kubbot/imstage.git']:
        raise ValueError('Unexpected source repository')
    subprocess.run(['git', '-C', source, 'fetch', 'origin', 'main'], check=True, capture_output=True)
    revision = subprocess.run(['git', '-C', source, 'rev-parse', 'origin/main'], check=True, capture_output=True, text=True).stdout.strip()
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('Invalid main revision')
    result = subprocess.run([cfg['gh'], 'run', 'list', '--repo', 'kubbot/imstage', '--workflow', 'frontend.yml', '--branch', 'main', '--commit', revision, '--event', 'push', '--limit', '1', '--json', 'headSha,headBranch,event,status,conclusion'], check=True, capture_output=True, text=True)
    runs = json.loads(result.stdout)
    if not runs:
        return None
    run = runs[0]
    return revision if (run.get('headSha'), run.get('headBranch'), run.get('event'), run.get('status'), run.get('conclusion')) == (revision, 'main', 'push', 'completed', 'success') else None


def wait_ready(cfg, revision=None):
    url = f"http://127.0.0.1:{int(cfg['webPort'])}/api/health"
    for _ in range(30):
        try:
            request = urllib.request.Request(url, headers={'User-Agent': 'IMStage-deploy/1.0'})
            with urllib.request.urlopen(request, timeout=2) as response:
                if json.load(response).get('status') == 'ready' and (not revision or response.headers.get('X-IMStage-Revision') == revision):
                    return
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError('The local service did not become ready')


def restart(cfg):
    domain = f'gui/{os.getuid()}'
    subprocess.run(['launchctl', 'bootout', domain + '/' + cfg['label']], capture_output=True, check=False)
    subprocess.run(['launchctl', 'bootstrap', domain, cfg['servicePlist']], capture_output=True, check=True)


def sync_updater(cfg, release):
    script = pathlib.Path(release) / 'deploy/macos.py'
    destination = pathlib.Path(cfg['stateDir']) / 'updater.py'
    value = script.read_bytes()
    if not destination.is_file() or destination.read_bytes() != value:
        atomic_write(destination, value)


def snapshot_dependencies(source, destination):
    # Clone file contents on APFS; never let development installs mutate a release.
    source, destination = pathlib.Path(source), pathlib.Path(destination)
    if sys.platform == 'darwin':
        result = subprocess.run(['cp', '-cRP', str(source), str(destination)], capture_output=True)
        if result.returncode == 0:
            return
        if destination.exists():
            shutil.rmtree(destination)
    shutil.copytree(source, destination, symlinks=True)


def bootstrap_account(cfg):
    """One-time, explicitly requested test account setup; never reset an account."""
    private = json.loads(pathlib.Path(cfg['smokeFile']).read_text())
    email = private['email'].strip().lower()
    database = pathlib.Path(cfg['dataDir']) / 'imstage.db'
    with sqlite3.connect('file:' + str(database) + '?mode=ro', uri=True) as db:
        if db.execute('SELECT 1 FROM users WHERE email = ?', (email,)).fetchone():
            return False
    headers = {'Origin': cfg['appOrigin'], 'Content-Type': 'application/json', 'X-Imstage-Request': '1', 'User-Agent': 'IMStage/0.2 deployment-bootstrap'}
    base = f"http://127.0.0.1:{int(cfg['webPort'])}"
    payload = json.dumps({'name': 'Deployment verification', 'email': email, 'password': private['password'], 'termsAccepted': True}).encode()
    request = urllib.request.Request(base + '/api/auth/register', data=payload, headers=headers, method='POST')
    with urllib.request.urlopen(request, timeout=20) as response:
        cookie = response.headers.get('Set-Cookie', '').split(';')[0]
        result = json.loads(response.read(65536))
    if result.get('user', {}).get('email') != email or not cookie.startswith('imstage_session='):
        raise RuntimeError('Test account setup could not be verified')
    logout = urllib.request.Request(base + '/api/auth/logout', data=b'{}', headers={**headers, 'Cookie': cookie}, method='POST')
    with urllib.request.urlopen(logout, timeout=20) as response:
        response.read(65536)
    return True


def activate(cfg, release, revision, bootstrap_test_account=False):
    release = pathlib.Path(release).resolve()
    if not re.fullmatch(r'[0-9a-f]{40}', revision) or release != pathlib.Path(cfg['releaseRoot']).resolve() / revision or cfg['label'] != 'com.imstage.web':
        raise ValueError('Unexpected release or service')
    database = pathlib.Path(cfg['dataDir']) / 'imstage.db'
    if not database.is_file():
        raise ValueError('Existing account database is required; refusing an empty replacement')
    state = pathlib.Path(cfg['stateDir'])
    backups = state / 'backups'
    backups.mkdir(parents=True, exist_ok=True, mode=0o700)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    with sqlite3.connect('file:' + str(database) + '?mode=ro', uri=True) as source, sqlite3.connect(backups / f'{revision}-{stamp}.sqlite') as target:
        source.backup(target)
        if target.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise RuntimeError('Database backup integrity check failed')
    plist_path = pathlib.Path(cfg['servicePlist'])
    old_plist = plist_path.read_bytes()
    atomic_write(backups / f'{revision}-{stamp}.plist', old_plist)
    smoke_path = pathlib.Path(cfg['smokeFile'])
    if smoke_path.stat().st_mode & 0o077:
        raise ValueError('Smoke credentials must have private file permissions')
    smoke_cfg = json.loads(smoke_path.read_text())
    private_input = json.dumps({**smoke_cfg, 'baseURL': cfg['appOrigin'], 'expectedRevision': revision})
    arguments = [cfg['node'], *['--env-file=' + file for file in cfg['environmentFiles']], str(release / 'tools/start-web.mjs')]
    environment = {'NODE_ENV': 'production', 'IMSTAGE_APP_ORIGIN': cfg['appOrigin'], 'IMSTAGE_DATA_DIR': cfg['dataDir'], 'IMSTAGE_WEB_PORT': str(cfg['webPort']), 'IMSTAGE_RELEASE_REVISION': revision, 'PATH': str(pathlib.Path(cfg['node']).parent) + ':' + os.environ.get('PATH', '/usr/bin:/bin')}
    if cfg.get('chromiumExecutable'):
        environment['IMSTAGE_CHROMIUM_EXECUTABLE'] = cfg['chromiumExecutable']
    new_plist = {'Label': cfg['label'], 'ProgramArguments': arguments, 'EnvironmentVariables': environment, 'WorkingDirectory': str(release), 'KeepAlive': True, 'RunAtLoad': True, 'ThrottleInterval': 10, 'StandardOutPath': str(state / 'web.log'), 'StandardErrorPath': str(state / 'web-error.log')}
    active_path = state / 'active.json'
    changed = False
    try:
        changed = True
        atomic_write(plist_path, plistlib.dumps(new_plist))
        restart(cfg)
        wait_ready(cfg, revision)
        if bootstrap_test_account:
            bootstrap_account(cfg)
        subprocess.run([cfg['node'], str(release / 'deploy/smoke.mjs')], input=private_input, text=True, check=True, capture_output=True)
        atomic_write(active_path, json.dumps({'revision': revision, 'release': str(release), 'verifiedAt': stamp}).encode())
        changed = False
    finally:
        committed = active_path.is_file() and json.loads(active_path.read_text()).get('revision') == revision
        if changed and not committed:
            handlers = {sig: signal.signal(sig, signal.SIG_IGN) for sig in [signal.SIGTERM, signal.SIGHUP, signal.SIGINT]}
            try:
                atomic_write(plist_path, old_plist)
                restart(cfg)
                wait_ready(cfg)
            finally:
                for sig, handler in handlers.items():
                    signal.signal(sig, handler)
    sync_updater(cfg, release)


def prepare(cfg, revision):
    root = pathlib.Path(cfg['releaseRoot'])
    root.mkdir(parents=True, exist_ok=True)
    release = root / revision
    if release.exists():
        if (release / '.built-revision').read_text().strip() != revision or not (release / 'dist/index.html').is_file():
            raise ValueError('Existing release is incomplete')
        return release
    state = pathlib.Path(cfg['stateDir'])
    with tempfile.TemporaryDirectory(prefix='.build-', dir=root) as folder:
        incoming = pathlib.Path(folder)
        archive = incoming / 'source.tar'
        subprocess.run(['git', '-C', cfg['sourceRoot'], 'archive', '--format=tar', '--output=' + str(archive), revision], check=True, capture_output=True)
        subprocess.run(['tar', '-xf', str(archive), '-C', str(incoming)], check=True, capture_output=True)
        archive.unlink()
        active_path = state / 'active.json'
        if active_path.is_file():
            previous_revision = json.loads(active_path.read_text()).get('revision', '')
            if re.fullmatch(r'[0-9a-f]{40}', previous_revision):
                previous = root / previous_revision
                if (previous / 'node_modules').is_dir() and not (previous / 'node_modules').is_symlink() and (previous / 'package-lock.json').read_bytes() == (incoming / 'package-lock.json').read_bytes():
                    snapshot_dependencies(previous / 'node_modules', incoming / 'node_modules')
        env = {**os.environ, 'PATH': str(pathlib.Path(cfg['node']).parent) + ':' + os.environ.get('PATH', '/usr/bin:/bin'), 'NPM_CONFIG_CACHE': cfg.get('npmCache', str(state / 'npm-cache'))}
        with (state / f'build-{revision}.log').open('ab') as log:
            if not (incoming / 'node_modules').exists():
                subprocess.run([cfg['npm'], 'ci', '--prefer-offline', '--no-audit', '--no-fund'], cwd=incoming, env=env, stdout=log, stderr=log, check=True)
            for script in ['build', 'build:mcp']:
                subprocess.run([cfg['npm'], 'run', script], cwd=incoming, env=env, stdout=log, stderr=log, check=True)
        (incoming / '.built-revision').write_text(revision + '\n')
        incoming.rename(release)
    return release


def update(cfg, retry_failed=False, bootstrap_test_account=False):
    if pathlib.Path(cfg.get('pauseFile', str(pathlib.Path.home() / '.agent-pause'))).exists():
        return {'status': 'paused'}
    state = pathlib.Path(cfg['stateDir'])
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    if shutil.disk_usage(state).free < 30 * 1024**3:
        return {'status': 'paused', 'reason': 'disk below 30 GiB'}
    with (state / 'update.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {'status': 'busy'}
        revision = checked_revision(cfg)
        if not revision:
            return {'status': 'waiting-for-ci'}
        active_path = state / 'active.json'
        if active_path.is_file() and json.loads(active_path.read_text()).get('revision') == revision:
            sync_updater(cfg, pathlib.Path(cfg['releaseRoot']) / revision)
            return {'status': 'unchanged', 'revision': revision}
        failure_path = state / 'last-failure.json'
        failure = json.loads(failure_path.read_text()) if failure_path.is_file() else {}
        if not retry_failed and failure.get('revision') == revision and failure.get('retryAfter', 0) > time.time():
            return {'status': 'backoff', 'revision': revision}
        try:
            release = prepare(cfg, revision)
            # A newer main must pass its own CI; never publish an obsolete build.
            if checked_revision(cfg) != revision:
                return {'status': 'superseded'}
            activate(cfg, release, revision, bootstrap_test_account=bootstrap_test_account)
        except BaseException as error:
            committed = active_path.is_file() and json.loads(active_path.read_text()).get('revision') == revision
            if not committed:
                attempts = failure.get('attempts', 0) + 1 if failure.get('revision') == revision else 1
                record = {'revision': revision, 'attempts': attempts, 'failedAt': time.time(), 'retryAfter': time.time() + min(21600, 300 * 2**min(attempts - 1, 7)), 'errorType': type(error).__name__}
                atomic_write(failure_path, json.dumps(record).encode())
                with (state / 'failures.jsonl').open('a') as log:
                    log.write(json.dumps(record) + '\n')
            raise
        if failure_path.exists():
            failure_path.unlink()
        return {'status': 'updated', 'revision': revision}


def install_timer(cfg, config_path):
    state = pathlib.Path(cfg['stateDir'])
    script = state / 'updater.py'
    if not script.is_file() or not (state / 'active.json').is_file():
        raise ValueError('Verify the first deployment before installing the updater')
    label = 'com.imstage.auto-deploy'
    path = pathlib.Path.home() / 'Library/LaunchAgents' / (label + '.plist')
    data = {'Label': label, 'ProgramArguments': [sys.executable, str(script), '--config', str(pathlib.Path(config_path).resolve())], 'EnvironmentVariables': {'PATH': os.environ.get('PATH', '/usr/bin:/bin')}, 'StartInterval': 120, 'RunAtLoad': True, 'ProcessType': 'Background', 'StandardOutPath': str(state / 'update.log'), 'StandardErrorPath': str(state / 'update-error.log')}
    atomic_write(path, plistlib.dumps(data))
    domain = f'gui/{os.getuid()}'
    subprocess.run(['launchctl', 'bootout', domain + '/' + label], capture_output=True, check=False)
    subprocess.run(['launchctl', 'bootstrap', domain, str(path)], capture_output=True, check=True)


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--install-timer', action='store_true')
    parser.add_argument('--retry-failed', action='store_true')
    parser.add_argument('--bootstrap-test-account', action='store_true')
    args = parser.parse_args()

    def interrupted(signum, _frame):
        raise SystemExit(f'Deploy interrupted by signal {signum}')

    for sig in [signal.SIGTERM, signal.SIGHUP, signal.SIGINT]:
        signal.signal(sig, interrupted)
    try:
        config = json.loads(pathlib.Path(args.config).read_text())
        result = update(config, retry_failed=args.retry_failed, bootstrap_test_account=args.bootstrap_test_account)
        if args.install_timer and result['status'] in ['updated', 'unchanged']:
            install_timer(config, args.config)
        if result['status'] not in ['unchanged', 'waiting-for-ci', 'busy', 'paused', 'backoff']:
            print(json.dumps(result))
    except Exception as error:
        print(f'IMStage deployment failed ({type(error).__name__}); inspect the private build and service logs', file=sys.stderr)
        sys.exit(1)
