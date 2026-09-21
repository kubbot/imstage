import { createAgentRuntime, resolveAgentConfig } from '../../../../services/agent/index.mjs';
import { referenceScene } from '../../../../services/agent/screenshot-tools.mjs';
import { assertDecodableImage } from '../../../../services/agent/image-decode.mjs';

// Only the task, source pixels and authorized assets enter the product Agent.
// No expected edits, answer text, preserved boxes or scores are exposed to it.

const SAFE_ASSET_ID_RE = /^[-\w]{1,128}$/;

function dataUrlMime(dataUrl) {
  const semi = dataUrl.indexOf(';');
  return semi > 'data:'.length ? dataUrl.slice('data:'.length, semi) : '';
}

function bufferFromDataUrl(dataUrl) {
  const comma = dataUrl.indexOf(',');
  return Buffer.from(dataUrl.slice(comma + 1), 'base64');
}

function toReferenceAsset(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  if (typeof entry.dataUrl === 'string') return entry;
  if (Buffer.isBuffer(entry.buffer) && typeof entry.mime === 'string') {
    return { ...entry, dataUrl: `data:${entry.mime};base64,${entry.buffer.toString('base64')}` };
  }
  return entry;
}

function inputAssetDataUrl(input) {
  if (typeof input.dataUrl === 'string') return input.dataUrl;
  return `data:${input.mime};base64,${input.buffer.toString('base64')}`;
}

/**
 * Build the accepted asset registry from the ACTUAL runtime result.
 *
 * Acceptance rules (see the benchmark integrity requirements):
 * - Only assets present in the runtime's own `scene.reference.assets` registry
 *   are considered. A model-declared asset id that never entered the registry is
 *   never accepted.
 * - A preprovided (dataset) asset is only accepted when its bytes are identical
 *   to the verified dataset bytes; a same-id different-bytes rewrite is an
 *   ownership violation, not a generated asset.
 * - Every generated asset's bytes must decode as a bounded raster image before
 *   it can be rendered or scored.
 *
 * @returns {Promise<{registry:Array,generated:Array,provenance:Record<string,'preprovided'|'generated'>}>}
 */
export async function collectAssetRegistry({ reference, inputAssets = [], signal, strict = true } = {}) {
  const inputs = new Map();
  for (const asset of Array.isArray(inputAssets) ? inputAssets : []) {
    if (asset && typeof asset.id === 'string' && asset.id !== '') inputs.set(asset.id, asset);
  }
  const registry = [];
  const generated = [];
  const provenance = {};
  const seen = new Set();
  const rawAssets = Array.isArray(reference?.assets) ? reference.assets : [];
  for (const raw of rawAssets) {
    const asset = toReferenceAsset(raw);
    const validShape = asset && typeof asset.id === 'string' && SAFE_ASSET_ID_RE.test(asset.id) && typeof asset.dataUrl === 'string';
    if (!validShape) {
      if (strict) {
        const error = new Error('运行时返回了不合法的素材注册项');
        error.code = 'invalid_generated_asset';
        throw error;
      }
      continue;
    }
    if (seen.has(asset.id)) {
      if (strict) {
        const error = new Error(`运行时素材注册表存在重复 id: ${asset.id}`);
        error.code = 'duplicate_generated_asset';
        throw error;
      }
      continue;
    }
    seen.add(asset.id);
    const input = inputs.get(asset.id);
    if (input) {
      if (!asset.dataUrl.startsWith('data:') || asset.dataUrl !== inputAssetDataUrl(input)) {
        if (strict) {
          const error = new Error(`预置素材 ${asset.id} 的字节被运行时改写，拒绝作为可用素材`);
          error.code = 'asset_ownership_violation';
          throw error;
        }
        continue;
      }
      const entry = {
        id: asset.id,
        mime: input.mime,
        buffer: input.buffer,
        description: typeof asset.description === 'string' ? asset.description : '',
        provenance: 'preprovided',
      };
      registry.push(entry);
      provenance[asset.id] = 'preprovided';
      continue;
    }
    try {
      await assertDecodableImage(asset.dataUrl, signal);
    } catch (error) {
      if (strict) {
        const wrapped = new Error(`生成素材 ${asset.id} 的图片字节能校验失败`);
        wrapped.code = 'invalid_generated_asset';
        wrapped.cause = error;
        throw wrapped;
      }
      continue;
    }
    const entry = {
      id: asset.id,
      mime: dataUrlMime(asset.dataUrl),
      buffer: bufferFromDataUrl(asset.dataUrl),
      description: typeof asset.description === 'string' ? asset.description : '',
      provenance: 'generated',
    };
    registry.push(entry);
    generated.push(entry);
    provenance[asset.id] = 'generated';
  }
  return { registry, generated, provenance };
}

export async function callDeepSeekAgent({ config, request, assets = [], signal, env = process.env, deps = {} }) {
  const runtime = createAgentRuntime(
    resolveAgentConfig(env, {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      maxRounds: 24,
      maxCalls: 80,
      deadlineMs: 360000,
    }),
    deps,
  );
  const scene = referenceScene(request, assets);
  const trace = [];
  const result = await runtime.run({
    prompt: request.task,
    scene,
    signal,
    onEvent: (event) => {
      if (event.type === 'tool' || event.type === 'assistant') trace.push(event);
    },
  });
  // A failed run still exposes its partial scene, but its assets are collected
  // leniently so an invalid generation cannot become a usable asset.
  const registry = await collectAssetRegistry({
    reference: result?.scene?.reference,
    inputAssets: assets,
    signal,
    strict: result.ok === true,
  });
  if (!result.ok) {
    const error = new Error(result.error || 'Agent 未完成任务');
    error.code = result.reason || 'agent_incomplete';
    error.trace = trace;
    error.partial = {
      reason: result.reason ?? null,
      plan: result.scene?.reference?.plan ?? null,
      scene: result.scene ?? null,
      assets: registry.registry,
      generatedAssets: registry.generated,
      provenance: registry.provenance,
      mutations: result.mutations ?? 0,
    };
    throw error;
  }
  return {
    rawContent: JSON.stringify(result.scene.reference.plan),
    model: runtime.capabilities.model,
    trace,
    assets: registry.registry,
    generatedAssets: registry.generated,
    assetProvenance: registry.provenance,
  };
}
