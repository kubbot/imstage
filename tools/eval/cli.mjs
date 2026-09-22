#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_MAX_DIFF_RATIO } from './src/constants.mjs';
import { REPO_ROOT, atomicWriteJson, readJsonFile } from './src/util.mjs';
import { validateBundle } from './src/validate.mjs';
import { evaluateGolden, renderMarkdown, validateActualManifest, writeErrorReport } from './src/core.mjs';
import { buildHarness, buildStarterCases } from './src/fixtures.mjs';

function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(token);
    }
  }
  return { flags, positionals };
}

function printHelp() {
  console.log(`IMStage eval CLI

用法:
  node cli.mjs evaluate --gold GOLD.json --actual ACTUAL.json --out DIR
  node cli.mjs selftest [--out DIR]
  node cli.mjs starter --out DIR
  node cli.mjs help

evaluate:
  GOLD.json   由标注实验室导出的 imstage-eval-golden-bundle（金标集合）。
  ACTUAL.json imstage-eval-actual-manifest，逐条给出 caseId、inputFingerprint 与 PNG。
  --out DIR   报告与差异图输出目录（默认 .local/eval-out）。
  任一用例失败/缺失/损坏/过期，或金标集合为空时，退出码非零。
`);
}

async function cmdEvaluate(flags) {
  const goldPath = flags.gold;
  const actualPath = flags.actual;
  const outDir = path.resolve(flags.out ?? path.join(REPO_ROOT, '.local', 'eval-out'));
  if (!goldPath || !actualPath) {
    const report = await writeErrorReport({ outDir, error: 'evaluate 需要 --gold 与 --actual' });
    console.error(renderMarkdown(report));
    process.exitCode = 1;
    return;
  }
  try {
    const goldRaw = await readJsonFile(path.resolve(goldPath));
    const goldBundle = validateBundle(goldRaw);
    const actualRaw = await readJsonFile(path.resolve(actualPath));
    const actualManifest = validateActualManifest(actualRaw, path.dirname(path.resolve(actualPath)));
    const { report } = await evaluateGolden({ goldBundle, actualManifest, outDir });
    console.log(renderMarkdown(report));
    console.log(`报告已写入: ${path.join(outDir, 'report.json')}`);
    process.exitCode = report.ok ? 0 : 1;
  } catch (err) {
    // Always leave a machine-readable diagnostic even for unreadable input.
    const report = await writeErrorReport({ outDir, error: err && err.message ? err.message : String(err) });
    console.error(renderMarkdown(report));
    console.error(`[imstage-eval] ${report.error}`);
    process.exitCode = 1;
  }
}

async function runScenario(name, { goldBundle, actualManifest }, workDir, expect) {
  const outDir = path.join(workDir, name);
  const { report } = await evaluateGolden({
    goldBundle,
    actualManifest,
    outDir,
    writeArtifacts: true,
  });
  const checks = [];
  const detail = [];
  const record = (label, value, expected) => {
    const ok = value === expected;
    checks.push(ok);
    detail.push(`${label}=${value}${ok ? '' : ` (期望 ${expected})`}`);
  };
  record('ok', report.ok, expect.ok);
  if (expect.status !== undefined) record('status', report.results[0]?.status, expect.status);
  if (expect.reason !== undefined) record('reason', report.results[0]?.reason, expect.reason);
  if (expect.emptyGoldenSet !== undefined) record('emptyGoldenSet', report.emptyGoldenSet, expect.emptyGoldenSet);
  if (expect.diffFile !== undefined) {
    const diffFile = report.results[0]?.diffFile ?? null;
    record('diffWritten', diffFile !== null, expect.diffFile);
    if (diffFile) {
      const absolute = path.resolve(outDir, diffFile);
      const inside = absolute.startsWith(`${path.resolve(outDir)}${path.sep}`);
      record('diffInsideOutDir', inside, true);
    }
  }
  return { name, ok: checks.every(Boolean), detail, report };
}

async function cmdSelftest(flags) {
  const outDir = path.resolve(flags.out ?? path.join(REPO_ROOT, '.local', 'eval-report'));
  const workDir = path.join(outDir, '_work');
  const started = new Date().toISOString();
  const scenarios = [];
  let ok = true;
  try {
    await fs.promises.rm(workDir, { recursive: true, force: true });
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

    const goldBundle = validateBundle(harness.goldBundle);
    const emptyBundle = validateBundle(harness.emptyBundle);
    const load = (name) => validateActualManifest(JSON.parse(fs.readFileSync(path.join(workDir, name), 'utf8')), workDir);

    const cases = [
      ['identical-pass', { goldBundle, actualManifest: load('actual-identical.json') }, { ok: true, status: 'pass', reason: 'within_tolerance' }],
      ['altered-fail', { goldBundle, actualManifest: load('actual-altered.json') }, { ok: false, status: 'fail', reason: 'pixel_difference', diffFile: true }],
      ['missing-fail', { goldBundle, actualManifest: load('actual-missing.json') }, { ok: false, status: 'missing', reason: 'actual_missing' }],
      ['dimension-mismatch-fail', { goldBundle, actualManifest: load('actual-dims.json') }, { ok: false, status: 'fail', reason: 'dimension_mismatch' }],
      ['stale-input-fail', { goldBundle, actualManifest: load('actual-stale.json') }, { ok: false, status: 'stale', reason: 'input_fingerprint_mismatch' }],
      ['malformed-fail', { goldBundle, actualManifest: load('actual-malformed.json') }, { ok: false, status: 'malformed' }],
      ['empty-golden-set-fail', { goldBundle: emptyBundle, actualManifest: load('actual-identical.json') }, { ok: false, emptyGoldenSet: true }],
    ];
    for (const [name, input, expect] of cases) {
      const result = await runScenario(name, input, workDir, expect);
      scenarios.push(result);
      if (!result.ok) ok = false;
    }
    // Extra invariant: identical candidate used twice stays PASS (deterministic).
    const repeat = await evaluateGolden({
      goldBundle,
      actualManifest: load('actual-identical.json'),
      outDir: path.join(workDir, 'identical-repeat'),
    });
    const deterministic = repeat.report.ok === true && repeat.report.summary.pass === 1;
    scenarios.push({ name: 'deterministic-repeat', ok: deterministic, detail: [`ok=${repeat.report.ok}`] });
    if (!deterministic) ok = false;

    // The harness must never be mistaken for a product evaluation.
    scenarios.push({
      name: 'harness-labeled-synthetic',
      ok:
        harness.goldBundle.cases.every((c) => c.synthetic === true) &&
        harness.goldBundle.infrastructureOnly === true &&
        /infrastructure-only/.test(String(harness.goldBundle.notice)),
      detail: ['golden cases marked synthetic; harness labelled infrastructure-only'],
    });
  } catch (err) {
    ok = false;
    scenarios.push({ name: 'selftest-internal-error', ok: false, detail: [err.message] });
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }

  const summary = {
    kind: 'imstage-eval-selftest',
    startedAt: started,
    finishedAt: new Date().toISOString(),
    outDir,
    ok,
    threshold: 0.1,
    defaultMaxDiffRatio: DEFAULT_MAX_DIFF_RATIO,
    scenarios: scenarios.map((s) => ({ name: s.name, ok: s.ok, detail: s.detail })),
  };
  await fs.promises.mkdir(outDir, { recursive: true });
  await atomicWriteJson(path.join(outDir, 'selftest-report.json'), summary);
  const lines = [
    '# IMStage eval 自检报告',
    '',
    `- 时间: ${summary.finishedAt}`,
    `- 结论: ${ok ? 'PASS' : 'FAIL'}`,
    `- 说明: 使用独立生成的 harness 合成夹具，不代表真实模型或渲染器评测。`,
    '',
    '| 场景 | 结果 | 细节 |',
    '| --- | --- | --- |',
    ...summary.scenarios.map((s) => `| ${s.name} | ${s.ok ? 'PASS' : 'FAIL'} | ${s.detail.join('; ')} |`),
    '',
  ];
  await fs.promises.writeFile(path.join(outDir, 'selftest-report.md'), lines.join('\n'));
  console.log(lines.join('\n'));
  console.log(`自检报告已写入: ${outDir}`);
  process.exitCode = ok ? 0 : 1;
  return ok;
}

async function cmdStarter(flags) {
  const outDir = path.resolve(flags.out ?? path.join(REPO_ROOT, '.local', 'eval-starters'));
  await fs.promises.mkdir(outDir, { recursive: true });
  const starters = buildStarterCases();
  const manifest = {
    kind: 'imstage-eval-synthetic-starters',
    notice: '合成示例：几何占位图，不是真实 IM UI，也不是已批准的 golden。加载后均处于未评审状态。',
    generatedAt: new Date().toISOString(),
    cases: starters.map(({ case: c }) => ({
      id: c.id,
      question: c.question,
      inputLanguage: c.inputLanguage,
      targetIM: c.targetIM,
      surface: c.surface,
      outputKind: c.outputKind,
      width: c.width,
      height: c.height,
      pngFile: `${c.id}.png`,
      synthetic: true,
    })),
  };
  for (const { case: c, candidateBuffer } of starters) {
    await fs.promises.writeFile(path.join(outDir, `${c.id}.png`), candidateBuffer);
  }
  await atomicWriteJson(path.join(outDir, 'starter-cases.json'), manifest);
  console.log(`已写出 ${starters.length} 个合成起始用例到 ${outDir}`);
  console.log('注意：这些是合成几何占位图，必须逐条评审后才能成为 golden。');
}

async function main() {
  const { flags, positionals } = parseArgs(process.argv.slice(2));
  const command = flags.command && typeof flags.command === 'string' ? flags.command : positionals[0];
  if (!command || command === 'help') {
    printHelp();
    return;
  }
  if (command === 'evaluate') return cmdEvaluate(flags);
  if (command === 'selftest') return cmdSelftest(flags);
  if (command === 'starter') return cmdStarter(flags);
  throw new Error(`未知命令: ${command}`);
}

main().catch((err) => {
  console.error(`[imstage-eval] ${err && err.message ? err.message : String(err)}`);
  process.exitCode = 1;
});
