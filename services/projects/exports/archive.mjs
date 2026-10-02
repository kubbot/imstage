/**
 * Project export archive documents (transport-free, streaming).
 *
 * Builds the exact file set of a deterministic delivery package from a frozen
 * export snapshot, ADDING each file to the ZIP writer as soon as it is built so
 * the worker never aggregates all Scene/PNG buffers in memory (one scene and at
 * most one PNG are alive at a time):
 *
 *   project.json                       sanitized project + scenario mapping
 *   README.md                          human-readable orientation
 *   scenarios/<id>/scenario.json       frozen scenario contract
 *   cases.jsonl                        stable itemKey → scene/render mapping
 *   scenes/0001.scene.json             re-importable Scene JSON (data URIs kept)
 *   renders/<platform>/0001.png        real renderer output only
 *   assets/<sha256>.<ext>              verified inline images (decoded ext)
 *   records.jsonl/annotations.jsonl    evaluation_dataset deliverables
 *   manifest.json / validation.json    hashes + verification report
 *
 * Hard rules:
 *   - every path is server-generated ASCII; no user input is ever a path;
 *   - `project.json` omits userId, private paths, grant/token references and
 *     chat histories;
 *   - manifest hashes content files only (manifest/validation self-hash is
 *     explicitly excluded);
 *   - an inline asset is only extracted when its bitmap really decodes — a
 *     dummy/invalid/truncated data URI is reported in validation.json and never
 *     stored as a "valid binary asset";
 *   - validation never claims natural-language quality (no model judge).
 */

import sharp from 'sharp';

import { sha256Hex, stableStringify } from '../../mcp/util.mjs';

export const ARCHIVE_SCHEMA_VERSION = 1;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_ASSET_PIXELS = 4_000_000;

const DATA_URI_RE = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const FORMAT_EXT = { png: 'png', jpeg: 'jpg', jpg: 'jpg', webp: 'webp' };
const FORMAT_MIME = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', webp: 'image/webp' };

export function sceneContentHash(scene) {
  return sha256Hex(stableStringify(scene));
}

function pad4(ordinal) {
  return String(ordinal).padStart(4, '0');
}

function jsonl(lines) {
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

function safePlatform(value) {
  return /^[A-Za-z0-9_-]{1,40}$/.test(String(value ?? '')) ? String(value) : 'imstage';
}

/** Every inline image reference of one scene, with a stable source label. */
export function sceneAssetRefs(scene) {
  const refs = [];
  const push = (value, source) => {
    if (typeof value === 'string' && value !== '') refs.push({ value, source });
  };
  push(scene?.backgroundImage, 'backgroundImage');
  for (const [index, person] of (scene?.participants ?? []).entries()) {
    push(person?.avatar, `participants[${index}].avatar`);
  }
  for (const [index, message] of (scene?.messages ?? []).entries()) {
    push(message?.asset, `messages[${index}].asset`);
    for (const [position, item] of (message?.items ?? []).entries()) {
      push(item?.asset, `messages[${index}].items[${position}].asset`);
    }
  }
  return refs;
}

/**
 * Verify one inline data URI: base64 decode, byte cap, claimed MIME shape, then
 * a FULL bitmap decode (truncated pixel data must fail, not pass on metadata
 * alone). The verified extension/format comes from the decoded image, never
 * from the caller's claim.
 */
export async function verifyInlineAsset(value) {
  const match = typeof value === 'string' ? DATA_URI_RE.exec(value) : null;
  if (!match) {
    return { valid: false, reason: 'not_embedded_image' };
  }
  const [, claimed, base64] = match;
  let buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch {
    return { valid: false, reason: 'base64_decode_failed' };
  }
  if (buffer.length < 1 || buffer.length > MAX_ASSET_BYTES) {
    return { valid: false, reason: 'byte_limit' };
  }
  let meta;
  let decoded;
  try {
    const image = sharp(buffer, { limitInputPixels: MAX_ASSET_PIXELS });
    meta = await image.metadata();
    // Force a real pixel decode so truncated/corrupt bitmaps are rejected.
    decoded = await image.raw().toBuffer({ resolveWithObject: true });
  } catch {
    return { valid: false, reason: 'image_decode_failed' };
  }
  const format = meta?.format;
  if (!FORMAT_EXT[format]) {
    return { valid: false, reason: 'unsupported_format' };
  }
  const claimedFormat = claimed === 'jpg' ? 'jpeg' : claimed;
  const normalized = format === 'jpg' ? 'jpeg' : format;
  return {
    valid: true,
    buffer,
    format: normalized,
    ext: FORMAT_EXT[format],
    mime: FORMAT_MIME[format],
    width: decoded?.info?.width ?? meta.width ?? null,
    height: decoded?.info?.height ?? meta.height ?? null,
    sha256: sha256Hex(buffer),
    mimeMatches: claimedFormat === normalized,
  };
}

/**
 * Verify all inline assets of a scene (one scene at a time).
 * @returns {Promise<{valid: Array, invalid: Array}>}
 */
export async function verifySceneAssets(scene) {
  const valid = new Map();
  const invalid = [];
  for (const ref of sceneAssetRefs(scene)) {
    const result = await verifyInlineAsset(ref.value);
    if (!result.valid) {
      invalid.push({ source: ref.source, reason: result.reason });
      continue;
    }
    const key = result.sha256;
    if (!valid.has(key)) {
      valid.set(key, {
        sha256: key,
        ext: result.ext,
        mime: result.mime,
        buffer: result.buffer,
        width: result.width,
        height: result.height,
        mimeMatches: result.mimeMatches,
        sources: [ref.source],
      });
    } else {
      valid.get(key).sources.push(ref.source);
      valid.get(key).mimeMatches = valid.get(key).mimeMatches && result.mimeMatches;
    }
  }
  return { valid: [...valid.values()], invalid };
}

function sanitizeCast(cast, assetPathBySha) {
  if (!Array.isArray(cast)) return [];
  return cast.map((member) => {
    const entry = { name: member?.name ?? '', role: member?.role ?? '' };
    if (typeof member?.avatar === 'string' && member.avatar !== '') {
      const match = DATA_URI_RE.exec(member.avatar);
      const buffer = match ? Buffer.from(match[2], 'base64') : null;
      const sha = buffer ? sha256Hex(buffer) : null;
      const assetPath = sha ? assetPathBySha.get(sha) : null;
      if (assetPath) entry.avatarAsset = assetPath;
      else entry.avatarUnavailable = true;
    }
    return entry;
  });
}

function readmeFor({ project, scenarios, items, missingItemKeys, exportId, createdAt, partial }) {
  const lines = [
    `# ${project.name}`,
    '',
    `导出 ID：\`${exportId}\`，生成时间：${createdAt}。`,
    '',
    `- 项目类型：${project.type}（配方 v${project.recipeVersion}）`,
    `- 场景：${scenarios.map((s) => `${s.name}（${s.caseCount} 案例）`).join('、') || '（按 sceneIds 导出）'}`,
    `- 包含案例：${items.length}${missingItemKeys.length ? `（另有 ${missingItemKeys.length} 个计划案例未包含）` : ''}`,
    '',
    '## 文件说明',
    '',
    '- `project.json`：项目与场景映射（不含账号、令牌与聊天历史）。',
    '- `cases.jsonl`：每行一个案例（稳定 itemKey、目标、背景、场景与截图路径）。',
    '- `scenes/*.scene.json`：可直接重新导入的 Scene JSON（内嵌 data URI 素材保持原样）。',
    '- `renders/<platform>/*.png`：确定性渲染器生成的真实截图。',
    '- `assets/<sha256>.<ext>`：校验通过的内嵌图片（扩展名按解码结果标注）。',
    '- `manifest.json`：内容文件清单与 SHA-256；`validation.json`：校验报告。',
  ];
  if (scenarios.some((s) => s.recipeType === 'evaluation_dataset')) {
    lines.push('- `records.jsonl` / `annotations.jsonl`：评测数据集的结构化记录与调用方标注。');
  }
  lines.push(
    '',
    '## 声明',
    '',
    '- 所有对话内容由调用方（AI 或人工）提供，服务端只做确定性校验、渲染与打包，不再调用任何模型。',
    '- `validation.json` 只报告可确定性检查的项目（文件、引用、PNG 头、素材解码）；语义质量未做机器判定。',
  );
  if (partial) {
    lines.push('', '> 注意：这是部分导出（partial），未包含的计划案例记录在 `validation.json`。');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Stream the whole archive into `writer`, one file at a time.
 *
 * @param {object} input
 * @param {object} input.writer             zip writer ({add(path, buffer)})
 * @param {object} input.exportRow          persisted export row
 * @param {object} input.frozen             frozen project/scenario snapshot
 * @param {Array}  input.items              item SUMMARIES (no scene blobs), status done
 * @param {(itemId: string) => Promise<object>} input.loadScene  one scene at a time
 * @param {(itemId: string) => Promise<Buffer>} input.loadPng    one PNG at a time
 * @param {Array}  input.missingItems       planned but not included cases
 */
export async function writeArchive({ writer, exportRow, frozen, items, loadScene, loadPng, missingItems, rendererVersion, policyVersion, nowMs }) {
  const createdAt = new Date(nowMs).toISOString();
  const fileMeta = []; // small metadata only: path/mime/bytes/sha256
  const assetPathBySha = new Map();
  const assetValidations = [];
  const assetInvalid = [];
  const caseLines = [];
  const itemReports = [];
  const recordLines = [];
  const annotationLines = [];
  const brokenRefs = [];
  let sceneBufferPeak = 0;

  async function addFile(path, mime, buffer, kind = 'content') {
    await writer.add(path, buffer);
    fileMeta.push({ path, mime, bytes: buffer.length, sha256: sha256Hex(buffer), kind });
    return fileMeta[fileMeta.length - 1];
  }

  async function addVerifiedAsset(asset, origin) {
    if (assetPathBySha.has(asset.sha256)) return;
    const path = `assets/${asset.sha256}.${asset.ext}`;
    assetPathBySha.set(asset.sha256, path);
    await addFile(path, asset.mime, asset.buffer, 'asset');
    assetValidations.push({
      path,
      origin,
      sha256: asset.sha256,
      bytes: asset.buffer.length,
      mime: asset.mime,
      width: asset.width,
      height: asset.height,
      claimedMimeMatches: asset.mimeMatches,
    });
  }

  // ---- one item at a time: scene + assets + render ----
  for (const summary of items) {
    const scene = await loadScene(summary.itemId);
    const sceneJson = Buffer.from(`${JSON.stringify(scene, null, 2)}\n`, 'utf8');
    sceneBufferPeak = Math.max(sceneBufferPeak, sceneJson.length);

    const { valid, invalid } = await verifySceneAssets(scene);
    for (const asset of valid) await addVerifiedAsset(asset, `item ${summary.itemKey}`);
    for (const entry of invalid) assetInvalid.push({ itemKey: summary.itemKey, ...entry });

    const stem = pad4(summary.ordinal);
    const scenePath = `scenes/${stem}.scene.json`;
    const platform = safePlatform(scene?.platform);
    const renderPath = `renders/${platform}/${stem}.png`;
    await addFile(scenePath, 'application/json', sceneJson);

    let pngMeta = null;
    if (summary.png?.sha256) {
      const png = await loadPng(summary.itemId);
      await addFile(renderPath, 'image/png', png);
      pngMeta = {
        width: summary.png.width,
        height: summary.png.height,
        bytes: png.length,
        sha256: sha256Hex(png),
      };
    } else {
      brokenRefs.push({ itemKey: summary.itemKey, ref: renderPath, reason: 'render_missing' });
    }

    caseLines.push({
      itemId: summary.itemId,
      ordinal: summary.ordinal,
      itemKey: summary.itemKey,
      scenarioId: summary.scenarioId,
      name: summary.name,
      objective: summary.objective,
      context: summary.context,
      sceneId: summary.sceneId,
      sceneRevision: summary.sceneRevision,
      scene: scenePath,
      render: pngMeta ? renderPath : null,
      sceneHash: summary.sceneHash,
      renderSha256: pngMeta ? pngMeta.sha256 : null,
    });
    itemReports.push({
      itemKey: summary.itemKey,
      scenarioId: summary.scenarioId,
      scenePath,
      renderPath: pngMeta ? renderPath : null,
      sceneParses: true,
      png: pngMeta,
    });

    const recipeType = summary.recipeType ?? 'custom';
    recordLines.push({
        itemKey: summary.itemKey,
        scenarioId: summary.scenarioId,
        recipeType,
        platform: scene?.platform ?? null,
        objective: summary.objective,
        context: summary.context,
        // Honest provenance: content is caller-provided; the server never
        // invents a source (human/AI/synthetic) for the records.
        provenance: 'caller-provided',
        scene: scenePath,
        render: pngMeta ? renderPath : null,
        messages: (scene?.messages ?? []).map((message) => ({
          role: message.participantId === scene?.selfId ? 'self' : 'other',
          type: message.type,
          text: message.text ?? null,
        })),
    });
    if (Object.keys(summary.annotations?.labels ?? {}).length > 0) {
      annotationLines.push({
        itemKey: summary.itemKey,
        scenarioId: summary.scenarioId,
        sceneId: summary.sceneId,
        sceneRevision: summary.sceneRevision,
        labels: summary.annotations.labels,
        provenance: 'caller-provided',
      });
    }
  }

  // ---- cast avatars: project brief AND every frozen scenario cast ----
  // A frozen scenario keeps its own cast; the avatar must survive even if the
  // project cast later changed or was removed (freeze contract).
  const castSources = [
    ...((frozen.project?.brief?.cast ?? []).map((member) => ({ member, origin: 'brief.cast' }))),
    ...(frozen.scenarios ?? []).flatMap((scenario) =>
      (scenario.frozen?.cast ?? []).map((member) => ({ member, origin: `scenario ${scenario.id} cast` })),
    ),
  ];
  for (const { member, origin } of castSources) {
    if (typeof member?.avatar !== 'string' || member.avatar === '') continue;
    const result = await verifyInlineAsset(member.avatar);
    if (!result.valid) {
      assetInvalid.push({ source: `${origin}(${member.name}).avatar`, reason: result.reason });
      continue;
    }
    await addVerifiedAsset(result, `${origin}(${member.name}).avatar`);
  }

  // ---- project.json (sanitized) ----
  const projectDoc = {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    exportId: exportRow.id,
    projectId: frozen.project.id,
    name: frozen.project.name,
    type: frozen.project.type,
    recipeVersion: frozen.project.recipeVersion,
    rules: frozen.project.rules,
    platform: frozen.project.platform,
    watermarkEnabled: frozen.project.watermarkEnabled,
    brief: {
      ...(frozen.project.brief?.language ? { language: frozen.project.brief.language } : {}),
      ...(frozen.project.brief?.platform ? { platform: frozen.project.brief.platform } : {}),
      cast: sanitizeCast(frozen.project.brief?.cast, assetPathBySha),
    },
    scenarios: frozen.scenarios.map((scenario) => ({
      scenarioId: scenario.id,
      name: scenario.name,
      preset: scenario.preset,
      platform: scenario.platform,
      locale: scenario.locale,
      recipeType: scenario.recipeType,
      recipeVersion: scenario.recipeVersion,
      caseKeys: items.filter((item) => item.scenarioId === scenario.id).map((item) => item.itemKey),
    })),
    generatedAt: createdAt,
  };
  await addFile('project.json', 'application/json', Buffer.from(`${JSON.stringify(projectDoc, null, 2)}\n`, 'utf8'));

  // ---- per-scenario frozen scenario.json ----
  for (const scenario of frozen.scenarios) {
    const doc = {
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      scenarioId: scenario.id,
      projectId: frozen.project.id,
      name: scenario.name,
      brief: scenario.brief,
      preset: scenario.preset,
      caseCount: scenario.caseCount,
      platform: scenario.platform,
      locale: scenario.locale,
      recipeType: scenario.recipeType,
      recipeVersion: scenario.recipeVersion,
      frozen: {
        rules: scenario.frozen.rules,
        watermarkEnabled: scenario.frozen.watermarkEnabled,
        defaults: scenario.frozen.defaults,
        cast: sanitizeCast(scenario.frozen.cast, assetPathBySha),
      },
      cases: (scenario.plan?.cases ?? []).map((entry) => ({
        itemKey: entry.itemKey,
        ordinal: entry.ordinal,
        name: entry.name,
        objective: entry.objective,
        context: entry.context,
        variation: entry.guide?.variation ?? [],
      })),
    };
    await addFile(`scenarios/${scenario.id}/scenario.json`, 'application/json', Buffer.from(`${JSON.stringify(doc, null, 2)}\n`, 'utf8'));
  }

  await addFile('cases.jsonl', 'application/x-ndjson', Buffer.from(jsonl(caseLines), 'utf8'));

  // ---- evaluation_dataset deliverables (requirements union, frozen recipes) ----
  const needsDatasetFiles =
    frozen.scenarios.some((scenario) => scenario.recipeType === 'evaluation_dataset') ||
    items.some((item) => item.recipeType === 'evaluation_dataset');
  if (needsDatasetFiles) {
    await addFile('records.jsonl', 'application/x-ndjson', Buffer.from(jsonl(recordLines), 'utf8'));
    await addFile('annotations.jsonl', 'application/x-ndjson', Buffer.from(jsonl(annotationLines), 'utf8'));
  }

  await addFile('README.md', 'text/markdown', Buffer.from(
    readmeFor({
      project: frozen.project,
      scenarios: frozen.scenarios,
      items,
      missingItemKeys: missingItems.map((entry) => entry.itemKey),
      exportId: exportRow.id,
      createdAt,
      partial: missingItems.length > 0,
    }),
    'utf8',
  ));

  const report = {
    items: itemReports,
    missingItems: missingItems.map((entry) => ({ itemKey: entry.itemKey, scenarioId: entry.scenarioId ?? null, reason: entry.reason ?? 'not_exported' })),
    assets: { valid: assetValidations, invalid: assetInvalid },
    brokenRefs,
    dataset: {
      required: needsDatasetFiles,
      recordsItems: needsDatasetFiles ? recordLines.length : 0,
      annotationsItems: needsDatasetFiles ? annotationLines.length : 0,
    },
    sceneBufferPeak,
  };

  // ---- manifest.json (content hashes only) + validation.json ----
  // The final archive deterministically contains manifest.json/validation.json
  // (added below), so the required-files report reflects the FINALIZED archive
  // consistently — never a "passed" report that contradicts its own flags.
  const finalizedPaths = new Set([...fileMeta.map((file) => file.path), 'manifest.json', 'validation.json']);
  const requiredPaths = [
    'project.json',
    'README.md',
    'cases.jsonl',
    ...frozen.scenarios.map((scenario) => `scenarios/${scenario.id}/scenario.json`),
    ...items.map((item) => `scenes/${pad4(item.ordinal)}.scene.json`),
    ...(needsDatasetFiles ? ['records.jsonl', 'annotations.jsonl'] : []),
    'manifest.json',
    'validation.json',
  ];
  const requiredReport = requiredPaths.map((path) => ({ path, present: finalizedPaths.has(path) }));
  const validationStatus =
    missingItems.length === 0 && requiredReport.every((entry) => entry.present) && brokenRefs.length === 0
      ? 'passed'
      : 'partial';
  const manifest = {
    version: 1,
    exportId: exportRow.id,
    projectId: frozen.project.id,
    projectRevision: frozen.project.revision ?? null,
    createdAt,
    recipe: frozen.scenarios.length
      ? frozen.scenarios.map((scenario) => ({ scenarioId: scenario.id, type: scenario.recipeType, version: scenario.recipeVersion }))
      : [{ type: frozen.project.type, version: frozen.project.recipeVersion }],
    renderer: { version: rendererVersion },
    policy: { version: policyVersion },
    renderOptions: (() => {
      try {
        return JSON.parse(exportRow.render_options_json ?? '{}');
      } catch {
        return {};
      }
    })(),
    hashScope: {
      included: 'content files listed in files[]',
      excluded: ['manifest.json', 'validation.json'],
    },
    snapshots: frozen.scenarios.map((scenario) => ({ scenarioId: scenario.id, revision: scenario.revision ?? null })),
    items: items.map((item) => ({
      itemId: item.itemId,
      itemKey: item.itemKey,
      ordinal: item.ordinal,
      scenarioId: item.scenarioId,
      sceneId: item.sceneId,
      sceneRevision: item.sceneRevision,
      sceneHash: item.sceneHash,
      dialogueHash: item.dialogueHash,
    })),
    files: fileMeta.map(({ path, mime, bytes, sha256 }) => ({ path, mime, bytes, sha256 })),
  };
  const present = new Set(fileMeta.map((file) => file.path));
  const validation = {
    version: 1,
    checkedAt: new Date(nowMs).toISOString(),
    status: validationStatus,
    checks: {
      requiredFiles: requiredReport,
      jsonlRefs: { ok: brokenRefs.length === 0, broken: brokenRefs },
      pngHeaders: itemReports.map((entry) => ({ itemKey: entry.itemKey, path: entry.renderPath, ...entry.png })),
      assets: {
        valid: assetValidations,
        invalid: assetInvalid,
        policy: '只归档完整解码通过的内嵌图片；未通过的引用如实列出，不伪装为有效素材。',
      },
    },
    missingItems: report.missingItems,
    dataset: report.dataset,
    scopeNote: {
      deterministic: '文件存在性、JSON/JSONL 解析与引用、PNG 签名/尺寸/哈希、素材 MIME/完整解码均已检查。',
      notChecked: '语义质量（文风、剧情合理性、标注正确性）不由服务端判定，无模型参与。',
    },
  };
  await addFile('manifest.json', 'application/json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'), 'meta');
  await addFile('validation.json', 'application/json', Buffer.from(`${JSON.stringify(validation, null, 2)}\n`, 'utf8'), 'meta');

  return { fileMeta, report, manifest, validation, requiredPaths };
}

export { stableStringify };
