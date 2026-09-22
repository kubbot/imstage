#!/usr/bin/env node
// IMStage screenshot-edit benchmark CLI.
//
//   node tools/eval/benchmark.mjs validate   --dataset DIR
//   node tools/eval/benchmark.mjs render-expected --dataset DIR --out DIR
//   node tools/eval/benchmark.mjs run        --dataset DIR --out DIR [--limit N] [--resume]
//   node tools/eval/benchmark.mjs report     --out DIR
//   node tools/eval/benchmark.mjs pack       --dataset DIR --bundle FILE
//   node tools/eval/benchmark.mjs unpack     --bundle FILE --out DIR
//
// Exit code 0 only when the requested operation fully passed. A `run` limited
// by --limit is explicitly marked subset:true and always exits non-zero; it is
// never reported as a full-suite pass.

import fs from 'node:fs';
import path from 'node:path';
import { readDataset } from './src/benchmark/dataset.mjs';
import { packDataset, unpackDataset } from './src/benchmark/crypto.mjs';
import { runDataset, renderExpectedDataset, writeFailureReport, safeErrorCode } from './src/benchmark/run.mjs';
import { toErrorMessage } from './src/util.mjs';

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
  console.log(`IMStage 截图编辑基准 CLI

用法:
  node tools/eval/benchmark.mjs validate        --dataset DIR
  node tools/eval/benchmark.mjs render-expected --dataset DIR --out DIR
  node tools/eval/benchmark.mjs run             --dataset DIR --out DIR [--limit N] [--resume]
  node tools/eval/benchmark.mjs report          --out DIR
  node tools/eval/benchmark.mjs pack            --dataset DIR --bundle FILE
  node tools/eval/benchmark.mjs unpack          --bundle FILE --out DIR

说明:
  validate        校验 manifest、路径安全、素材/源图哈希与尺寸。
  render-expected 用确定性渲染器离线生成 expected/<caseId>.png（proposed，非金标）。
  run             调用模型编辑截图并评分；--limit 限制调用数，子集绝不判为全套通过。
  report          读取 DIR/report.json 并打印摘要。
  pack/unpack     使用 IMSTAGE_EVAL_DATASET_KEY（32 字节 hex）加解密私有数据集。
`);
}

function requireFlag(flags, name) {
  const value = flags[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw Object.assign(new Error(`缺少 --${name}`), { code: 'missing_flag' });
  }
  return value;
}

async function cmdValidate(flags) {
  const dataset = await readDataset(requireFlag(flags, 'dataset'));
  console.log(
    `数据集有效: ${dataset.manifest.id} v${dataset.manifest.version} cases=${dataset.cases.length} assets=${dataset.manifest.assets.length}`,
  );
  console.log(`inputHash=${dataset.datasetInputHash}`);
}

async function cmdRenderExpected(flags) {
  const result = await renderExpectedDataset({
    datasetDir: requireFlag(flags, 'dataset'),
    outDir: requireFlag(flags, 'out'),
  });
  console.log(`expected 引用图: ${result.counts.rendered}/${result.counts.casesTotal} 已生成 (proposed，非金标)`);
  if (result.failures.length > 0) {
    console.error(`失败用例: ${result.failures.map((f) => `${f.caseId}:${f.errorCode}`).join(', ')}`);
  }
  process.exitCode = result.ok ? 0 : 1;
}

async function cmdRun(flags) {
  const datasetDir = requireFlag(flags, 'dataset');
  const outDir = requireFlag(flags, 'out');
  const limitRaw = flags.limit === undefined ? undefined : Number(flags.limit);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
  try {
    const report = await runDataset({
      datasetDir,
      outDir,
      limit,
      resume: flags.resume === true,
    });
    console.log(
      `用例: ${report.counts.casesPassed}/${report.counts.casesAttempted} 通过，共 ${report.counts.casesTotal}` +
        `；caseAgentRuns=${report.counts.providerCalls} resumeReused=${report.counts.resumeReused}`,
    );
    if (report.subset) console.log('注意: 本次为子集（--limit），绝不代表全套通过。');
    if (Object.keys(report.errorCodes).length > 0) {
      console.log(`错误码: ${Object.entries(report.errorCodes).map(([code, count]) => `${code}=${count}`).join(', ')}`);
    }
    console.log(`报告: ${path.join(report.outDir, 'report.json')}`);
    process.exitCode = report.ok ? 0 : 1;
  } catch (err) {
    const code = safeErrorCode(err);
    await writeFailureReport({ outDir, errorCode: code }).catch(() => {});
    console.error(`[benchmark] 运行失败: ${code}`);
    process.exitCode = 1;
  }
}

async function cmdReport(flags) {
  const outDir = requireFlag(flags, 'out');
  const reportPath = path.join(path.resolve(outDir), 'report.json');
  let report;
  try {
    report = JSON.parse(await fs.promises.readFile(reportPath, 'utf8'));
  } catch {
    console.error(`[benchmark] 找不到报告: ${reportPath}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `结论: ${report.ok ? 'PASS' : 'FAIL'}${report.subset ? ' (subset)' : ''}；` +
      `用例 ${report.counts?.casesPassed ?? 0}/${report.counts?.casesAttempted ?? 0} 通过，共 ${report.counts?.casesTotal ?? 0}`,
  );
  const codes = report.errorCodes ?? {};
  if (Object.keys(codes).length > 0) {
    console.log(`错误码: ${Object.entries(codes).map(([code, count]) => `${code}=${count}`).join(', ')}`);
  }
  process.exitCode = report.ok ? 0 : 1;
}

async function cmdPack(flags) {
  const result = await packDataset({
    datasetDir: requireFlag(flags, 'dataset'),
    outputFile: requireFlag(flags, 'bundle'),
  });
  console.log(`已打包 ${result.files} 个文件 -> ${result.outputFile} (${result.bytes} bytes)`);
}

async function cmdUnpack(flags) {
  const result = await unpackDataset({
    inputFile: requireFlag(flags, 'bundle'),
    outputDir: requireFlag(flags, 'out'),
  });
  console.log(`已解包 ${result.fileCount} 个文件 -> ${result.outputDir}`);
}

async function main() {
  const { flags, positionals } = parseArgs(process.argv.slice(2));
  const command = positionals[0];
  if (!command || command === 'help') {
    printHelp();
    return;
  }
  if (command === 'validate') return cmdValidate(flags);
  if (command === 'render-expected') return cmdRenderExpected(flags);
  if (command === 'run') return cmdRun(flags);
  if (command === 'report') return cmdReport(flags);
  if (command === 'pack') return cmdPack(flags);
  if (command === 'unpack') return cmdUnpack(flags);
  throw new Error(`未知命令: ${command}`);
}

main().catch((err) => {
  console.error(`[benchmark] ${safeErrorCode(err)}`);
  process.exitCode = 1;
});
