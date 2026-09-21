import { PNG } from 'pngjs';
import { DEFAULT_MAX_DIFF_RATIO, RUBRIC_VERSION } from './constants.mjs';
import { computeInputFingerprint } from './fingerprint.mjs';
import { encodePng } from './png.mjs';
import { sha256Hex } from './util.mjs';

// ---------------------------------------------------------------------------
// Deterministic synthetic PNG rendering (no randomness).
// These images are geometric "chat-like" placeholders. They are explicitly
// NOT authentic IM UI and must never be treated as approved product goldens.
// ---------------------------------------------------------------------------

function setPixel(data, width, height, x, y, color) {
  const xi = x | 0;
  const yi = y | 0;
  if (xi < 0 || yi < 0 || xi >= width || yi >= height) return;
  const i = (yi * width + xi) * 4;
  data[i] = color[0];
  data[i + 1] = color[1];
  data[i + 2] = color[2];
  data[i + 3] = color[3] ?? 255;
}

function fillRect(data, width, height, x0, y0, w, h, color) {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) setPixel(data, width, height, x, y, color);
  }
}

function fillCircle(data, width, height, cx, cy, radius, color) {
  const r2 = radius * radius;
  for (let y = cy - radius; y <= cy + radius; y += 1) {
    for (let x = cx - radius; x <= cx + radius; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) setPixel(data, width, height, x, y, color);
    }
  }
}

const PALETTES = {
  wechat: { header: [46, 52, 58], bubbleIn: [255, 255, 255], bubbleOut: [149, 236, 105], accent: [7, 193, 96] },
  telegram: { header: [40, 110, 175], bubbleIn: [255, 255, 255], bubbleOut: [220, 242, 255], accent: [64, 158, 255] },
  whatsapp: { header: [7, 94, 84], bubbleIn: [255, 255, 255], bubbleOut: [220, 248, 198], accent: [37, 211, 102] },
  custom: { header: [58, 58, 74], bubbleIn: [250, 250, 252], bubbleOut: [214, 244, 236], accent: [16, 163, 127] },
};

/**
 * Render a deterministic, synthetic chat-like PNG.
 * @param {{width:number,height:number,im?:string,variant?:number,long?:boolean}} options
 */
export function renderSyntheticChatPng({ width, height, im = 'custom', variant = 0, long = false }) {
  const palette = PALETTES[im] ?? PALETTES.custom;
  const png = new PNG({ width, height });
  const data = png.data;
  const bg = [244, 247, 246];
  fillRect(data, width, height, 0, 0, width, height, [...bg, 255]);

  const headerH = Math.min(88, Math.max(56, Math.round(height * 0.09)));
  fillRect(data, width, height, 0, 0, width, headerH, [...palette.header, 255]);
  // Title bar accent block (stands in for an avatar + name).
  fillCircle(data, width, height, 28, Math.round(headerH / 2), 14, [...palette.accent, 255]);
  fillRect(data, width, height, 52, Math.round(headerH / 2) - 8, Math.min(width - 80, 140), 8, [235, 240, 238, 255]);
  fillRect(data, width, height, 52, Math.round(headerH / 2) + 4, Math.min(width - 110, 96), 6, [200, 210, 206, 255]);

  const bubbleH = 56;
  const gap = long ? 64 : 72;
  const startY = headerH + 14;
  const maxBubbles = Math.max(1, Math.floor((height - startY - 12) / gap) + 1);
  for (let i = 0; i < maxBubbles; i += 1) {
    const y = startY + i * gap;
    if (y + bubbleH > height) break;
    const incoming = (i + variant) % 2 === 0;
    const bw = Math.max(90, Math.min(width - 96, 120 + ((i * 37 + variant * 53) % 140)));
    const x = incoming ? 16 : width - bw - 16;
    fillCircle(data, width, height, incoming ? width - 24 : 24, y + 20, 12, [...palette.accent, 255]);
    fillRect(data, width, height, x, y, bw, bubbleH, [...(incoming ? palette.bubbleIn : palette.bubbleOut), 255]);
    fillRect(data, width, height, x + 10, y + 12, bw - 20, 8, [120, 132, 128, 255]);
    fillRect(data, width, height, x + 10, y + 28, Math.max(24, bw - 60), 7, [176, 186, 182, 255]);
    fillRect(data, width, height, x + 10, y + 42, Math.max(18, bw - 96), 6, [200, 208, 205, 255]);
  }
  // Deterministic variant marker stripe so altered fixtures differ clearly.
  fillRect(data, width, height, 0, height - 6, Math.min(width, 18 + variant * 7), 6, [...palette.accent, 255]);
  return encodePng({ width, height, data });
}

function caseBase(fields) {
  return {
    id: fields.id,
    revision: 1,
    createdAt: fields.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: fields.updatedAt ?? '2026-01-01T00:00:00.000Z',
    question: fields.question,
    inputLanguage: fields.inputLanguage,
    targetIM: fields.targetIM,
    surface: fields.surface,
    outputKind: fields.outputKind,
    width: fields.width,
    height: fields.height,
    notes: fields.notes ?? '',
    maxDiffRatio: DEFAULT_MAX_DIFF_RATIO,
    synthetic: fields.synthetic === true,
    attachments: fields.attachments ?? [],
    candidate: fields.candidate ?? null,
    review: null,
    golden: null,
  };
}

/**
 * Optional synthetic starter cases. They start UNREVIEWED and are never
 * auto-seeded into the user's store; the UI must add them explicitly.
 */
export function buildStarterCases() {
  const specs = [
    {
      id: 'starter_wechat_ios_zh',
      question: '请生成一条微信 iOS 单聊截图：朋友问「周末一起爬山吗？」，我回复「好，早上八点山脚见」。',
      inputLanguage: 'zh-CN',
      targetIM: 'wechat',
      surface: 'ios',
      outputKind: 'screenshot',
      width: 390,
      height: 844,
      notes: '期望：两条消息均为中文，右侧绿色气泡，时间显示在顶部。',
      variant: 0,
    },
    {
      id: 'starter_telegram_android_en',
      question: 'Render a Telegram Android chat: a colleague asks "Did you push the fix?" and I reply "Yes, CI is green."',
      inputLanguage: 'en',
      targetIM: 'telegram',
      surface: 'android',
      outputKind: 'screenshot',
      width: 360,
      height: 800,
      notes: 'Expect two English messages, blue outgoing bubble, Telegram-style spacing.',
      variant: 1,
    },
    {
      id: 'starter_whatsapp_desktop_zh_tw',
      question: '產生一段 WhatsApp 桌面版長截圖：先確認會議時間，再傳送一段較長的會議議程說明。',
      inputLanguage: 'zh-TW',
      targetIM: 'whatsapp',
      surface: 'desktop',
      outputKind: 'long-screenshot',
      width: 420,
      height: 1800,
      notes: '期望：長截圖包含多條訊息，桌面上版式較寬，長度明顯大於一屏。',
      variant: 2,
    },
  ];
  return specs.map((spec) => {
    const buffer = renderSyntheticChatPng({
      width: spec.width,
      height: spec.height,
      im: spec.targetIM,
      variant: spec.variant,
      long: spec.outputKind === 'long-screenshot',
    });
    const candidate = {
      id: `cand_${spec.id}`,
      name: `${spec.id}.png`,
      mime: 'image/png',
      size: buffer.length,
      sha256: sha256Hex(buffer),
      width: spec.width,
      height: spec.height,
      uploadedAt: '2026-01-01T00:00:00.000Z',
      inputFingerprint: null, // filled below
      synthetic: true,
    };
    const base = caseBase({ ...spec, synthetic: true });
    candidate.inputFingerprint = computeInputFingerprint({ ...base, candidate });
    return { case: { ...base, candidate }, candidateBuffer: buffer, note: '合成示例，未评审' };
  });
}

// ---------------------------------------------------------------------------
// Harness fixtures for `cli.mjs selftest`. Kept separate from starter cases.
// ---------------------------------------------------------------------------

export const HARNESS_GOLD_ID = 'harness-gold-0001';
export const HARNESS_STALE_ID = 'harness-stale-0002';

export function buildHarness() {
  const goldSpec = {
    question: 'harness synthetic case',
    inputLanguage: 'zh-CN',
    targetIM: 'wechat',
    surface: 'ios',
    outputKind: 'screenshot',
    width: 64,
    height: 64,
    notes: 'deterministic harness',
  };
  const goldBuffer = renderSyntheticChatPng({ width: 64, height: 64, im: 'wechat', variant: 0 });
  const alteredBuffer = renderSyntheticChatPng({ width: 64, height: 64, im: 'telegram', variant: 3 });
  const smallBuffer = renderSyntheticChatPng({ width: 64, height: 32, im: 'wechat', variant: 0 });
  const inputFingerprint = computeInputFingerprint(goldSpec);

  const staleSpec = { ...goldSpec, width: 96, height: 96 };
  const staleFingerprint = computeInputFingerprint(staleSpec);

  const goldCase = {
    bundleCaseId: HARNESS_GOLD_ID,
    ...goldSpec,
    inputFingerprint,
    maxDiffRatio: DEFAULT_MAX_DIFF_RATIO,
    synthetic: true,
    rubricVersion: RUBRIC_VERSION,
    scores: { content: 2, imFidelity: 2, layout: 2, completeness: 2 },
    verdict: 'good',
    reason: 'harness',
    goldenPng: {
      sha256: sha256Hex(goldBuffer),
      width: 64,
      height: 64,
      base64: goldBuffer.toString('base64'),
    },
  };

  const goldBundle = {
    schemaVersion: 1,
    kind: 'imstage-eval-golden-bundle',
    generator: 'imstage-eval-selftest-harness',
    notice:
      'infrastructure-only harness fixture; not a product render proof and not an approved product golden.',
    infrastructureOnly: true,
    exportedAt: '2026-01-01T00:00:00.000Z',
    scope: 'synthetic',
    threshold: 0.1,
    cases: [goldCase],
  };

  const emptyBundle = { ...goldBundle, cases: [] };

  const actualFor = (overrides = {}) => ({
    schemaVersion: 1,
    kind: 'imstage-eval-actual-manifest',
    generator: 'imstage-eval-selftest-harness',
    notice: 'infrastructure-only harness fixture; not a product render proof.',
    generatedAt: '2026-01-01T00:00:00.000Z',
    cases: [
      {
        caseId: HARNESS_GOLD_ID,
        inputFingerprint,
        pngBase64: goldBuffer.toString('base64'),
        ...overrides,
      },
    ],
  });

  return {
    goldBundle,
    emptyBundle,
    buffers: { goldBuffer, alteredBuffer, smallBuffer },
    inputFingerprint,
    staleFingerprint,
    actual: {
      identical: actualFor(),
      altered: actualFor({ pngBase64: alteredBuffer.toString('base64') }),
      missing: { ...actualFor(), cases: [] },
      dimensionMismatch: actualFor({ pngBase64: smallBuffer.toString('base64') }),
      stale: actualFor({ inputFingerprint: staleFingerprint }),
      malformed: actualFor({ pngBase64: Buffer.from('not a png at all').toString('base64') }),
    },
  };
}
