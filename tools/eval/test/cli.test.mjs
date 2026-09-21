import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { buildHarness, HARNESS_GOLD_ID } from '../src/fixtures.mjs';
import { MAX_PNG_BYTES } from '../src/constants.mjs';
import { PACKAGE_DIR, atomicWriteJson } from '../src/util.mjs';
import { cleanupDir, tempDataDir } from './helpers.mjs';

const execFileAsync = promisify(execFile);
const CLI = path.join(PACKAGE_DIR, 'cli.mjs');

async function runCli(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd: PACKAGE_DIR,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

async function writeHarness(workDir) {
  await fs.promises.mkdir(workDir, { recursive: true });
  const harness = buildHarness();
  await atomicWriteJson(path.join(workDir, 'gold.json'), harness.goldBundle);
  await atomicWriteJson(path.join(workDir, 'gold-empty.json'), harness.emptyBundle);
  await atomicWriteJson(path.join(workDir, 'actual-identical.json'), harness.actual.identical);
  await atomicWriteJson(path.join(workDir, 'actual-altered.json'), harness.actual.altered);
  await atomicWriteJson(path.join(workDir, 'actual-missing.json'), harness.actual.missing);
  await atomicWriteJson(path.join(workDir, 'actual-dims.json'), harness.actual.dimensionMismatch);
  await atomicWriteJson(path.join(workDir, 'actual-stale.json'), harness.actual.stale);
  await atomicWriteJson(path.join(workDir, 'actual-malformed.json'), harness.actual.malformed);
  return harness;
}

test('selftest exits zero and writes a report', async () => {
  const outDir = tempDataDir('cli-selftest');
  try {
    const result = await runCli(['selftest', '--out', outDir]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const report = JSON.parse(await fs.promises.readFile(path.join(outDir, 'selftest-report.json'), 'utf8'));
    assert.equal(report.ok, true);
    for (const scenario of report.scenarios) {
      assert.equal(scenario.ok, true, `${scenario.name}: ${scenario.detail}`);
    }
    const names = report.scenarios.map((s) => s.name);
    for (const expected of [
      'identical-pass',
      'altered-fail',
      'missing-fail',
      'dimension-mismatch-fail',
      'stale-input-fail',
      'empty-golden-set-fail',
    ]) {
      assert.ok(names.includes(expected), `缺少场景 ${expected}`);
    }
  } finally {
    await cleanupDir(outDir);
  }
});

test('evaluate exits zero for an identical candidate', async () => {
  const workDir = tempDataDir('cli-pass');
  try {
    await writeHarness(workDir);
    const outDir = path.join(workDir, 'out');
    const result = await runCli(['evaluate', '--gold', path.join(workDir, 'gold.json'), '--actual', path.join(workDir, 'actual-identical.json'), '--out', outDir]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const report = JSON.parse(await fs.promises.readFile(path.join(outDir, 'report.json'), 'utf8'));
    assert.equal(report.ok, true);
    assert.equal(report.summary.pass, 1);
    assert.ok(fs.existsSync(path.join(outDir, 'report.md')));
  } finally {
    await cleanupDir(workDir);
  }
});

for (const [name, manifest, expectedStatus] of [
  ['altered', 'actual-altered.json', 'fail'],
  ['missing', 'actual-missing.json', 'missing'],
  ['dimension mismatch', 'actual-dims.json', 'fail'],
  ['stale input', 'actual-stale.json', 'stale'],
  ['malformed', 'actual-malformed.json', 'malformed'],
]) {
  test(`evaluate exits nonzero for a ${name} candidate`, async () => {
    const workDir = tempDataDir(`cli-${expectedStatus}-${name.replaceAll(' ', '-')}`);
    try {
      await writeHarness(workDir);
      const outDir = path.join(workDir, 'out');
      const result = await runCli([
        'evaluate',
        '--gold',
        path.join(workDir, 'gold.json'),
        '--actual',
        path.join(workDir, manifest),
        '--out',
        outDir,
      ]);
      assert.equal(result.code, 1, result.stdout + result.stderr);
      const report = JSON.parse(await fs.promises.readFile(path.join(outDir, 'report.json'), 'utf8'));
      assert.equal(report.ok, false);
      assert.equal(report.results[0].status, expectedStatus);
    } finally {
      await cleanupDir(workDir);
    }
  });
}

test('evaluate exits nonzero for an empty golden set', async () => {
  const workDir = tempDataDir('cli-empty');
  try {
    await writeHarness(workDir);
    const outDir = path.join(workDir, 'out');
    const result = await runCli([
      'evaluate',
      '--gold',
      path.join(workDir, 'gold-empty.json'),
      '--actual',
      path.join(workDir, 'actual-identical.json'),
      '--out',
      outDir,
    ]);
    assert.equal(result.code, 1);
    const report = JSON.parse(await fs.promises.readFile(path.join(outDir, 'report.json'), 'utf8'));
    assert.equal(report.emptyGoldenSet, true);
    assert.equal(report.summary.total, 0);
  } finally {
    await cleanupDir(workDir);
  }
});

test('evaluate exits nonzero for malformed gold JSON but still writes a report', async () => {
  const workDir = tempDataDir('cli-badgold');
  try {
    await fs.promises.mkdir(workDir, { recursive: true });
    await fs.promises.writeFile(path.join(workDir, 'gold.json'), '{ not json');
    await fs.promises.writeFile(path.join(workDir, 'actual.json'), '{}');
    const outDir = path.join(workDir, 'out');
    const result = await runCli([
      'evaluate',
      '--gold',
      path.join(workDir, 'gold.json'),
      '--actual',
      path.join(workDir, 'actual.json'),
      '--out',
      outDir,
    ]);
    assert.equal(result.code, 1);
    assert.match(result.stderr + result.stdout, /JSON 解析失败/);
    const report = JSON.parse(await fs.promises.readFile(path.join(outDir, 'report.json'), 'utf8'));
    assert.equal(report.ok, false);
    assert.match(report.error, /JSON 解析失败/);
    assert.ok(fs.existsSync(path.join(outDir, 'report.md')));
  } finally {
    await cleanupDir(workDir);
  }
});

test('evaluate writes a failure report for malformed actual JSON', async () => {
  const workDir = tempDataDir('cli-badactual');
  try {
    await writeHarness(workDir);
    await fs.promises.writeFile(path.join(workDir, 'actual.json'), '{ broken');
    const outDir = path.join(workDir, 'out');
    const result = await runCli([
      'evaluate',
      '--gold',
      path.join(workDir, 'gold.json'),
      '--actual',
      path.join(workDir, 'actual.json'),
      '--out',
      outDir,
    ]);
    assert.equal(result.code, 1);
    const report = JSON.parse(await fs.promises.readFile(path.join(outDir, 'report.json'), 'utf8'));
    assert.match(report.error, /JSON 解析失败/);
  } finally {
    await cleanupDir(workDir);
  }
});

test('evaluate flags an oversized pngPath without reading it into memory', async () => {
  const workDir = tempDataDir('cli-bigpng');
  try {
    const harness = await writeHarness(workDir);
    const bigPath = path.join(workDir, 'big.png');
    await fs.promises.writeFile(bigPath, '');
    await fs.promises.truncate(bigPath, MAX_PNG_BYTES + 1);
    await atomicWriteJson(path.join(workDir, 'actual-big.json'), {
      schemaVersion: 1,
      kind: 'imstage-eval-actual-manifest',
      cases: [
        {
          caseId: HARNESS_GOLD_ID,
          inputFingerprint: harness.inputFingerprint,
          pngPath: 'big.png',
        },
      ],
    });
    const outDir = path.join(workDir, 'out');
    const result = await runCli([
      'evaluate',
      '--gold',
      path.join(workDir, 'gold.json'),
      '--actual',
      path.join(workDir, 'actual-big.json'),
      '--out',
      outDir,
    ]);
    assert.equal(result.code, 1);
    const report = JSON.parse(await fs.promises.readFile(path.join(outDir, 'report.json'), 'utf8'));
    assert.equal(report.results[0].status, 'malformed');
    assert.equal(report.results[0].reason, 'actual_too_large');
  } finally {
    await cleanupDir(workDir);
  }
});

test('diff output never escapes the designated output directory', async () => {
  const workDir = tempDataDir('cli-escape');
  try {
    const harness = await writeHarness(workDir);
    const evilBundle = structuredClone(harness.goldBundle);
    evilBundle.cases[0].bundleCaseId = '../escape';
    await atomicWriteJson(path.join(workDir, 'evil-gold.json'), evilBundle);
    const evilActual = structuredClone(harness.actual.altered);
    evilActual.cases[0].caseId = '../escape';
    await atomicWriteJson(path.join(workDir, 'evil-actual.json'), evilActual);

    const outDir = path.join(workDir, 'out');
    const result = await runCli([
      'evaluate',
      '--gold',
      path.join(workDir, 'evil-gold.json'),
      '--actual',
      path.join(workDir, 'evil-actual.json'),
      '--out',
      outDir,
    ]);
    assert.equal(result.code, 1);
    const report = JSON.parse(await fs.promises.readFile(path.join(outDir, 'report.json'), 'utf8'));
    assert.equal(report.results[0].diffSkipped, 'unsafe_case_id');
    assert.equal(report.results[0].diffFile, null);
    assert.equal(fs.existsSync(path.join(workDir, 'escape.png')), false);
    assert.equal(fs.existsSync(path.join(workDir, 'out', '..', 'escape.png')), false);
  } finally {
    await cleanupDir(workDir);
  }
});
