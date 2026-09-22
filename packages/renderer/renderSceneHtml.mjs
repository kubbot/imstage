// Deterministic, framework-neutral IM scene renderer.
//
// renderSceneHtml(scene, { surface, width, outputKind, assets }) -> HTML string
//
// Guarantees:
// - Pure: no fs/network/DOM access, no randomness, no Date.now. Given the same
//   scene/options it always returns the same bytes.
// - Safe: every scene string is HTML-escaped. Uploaded images are embedded as
//   `data:` URIs. No remote resources, no inline event handlers, no scripts.
// - Real templates: WeChat / Telegram / WhatsApp each get distinct header,
//   background, bubble colors, sender alignment, names and system messages.
// - Surface differences: iOS/Android status bars, desktop/web window chrome.
//
// The companion screenshotter lives in tools/eval/src/render.mjs and loads the
// browser with all network requests aborted; this module never emits one.

export const RENDERER_VERSION = 'v1';

export const RENDERER_PLATFORMS = Object.freeze(['wechat', 'telegram', 'whatsapp']);
export const RENDERER_SURFACES = Object.freeze(['ios', 'android', 'desktop', 'web']);

const PLATFORM_THEMES = Object.freeze({
  wechat: {
    label: '微信',
    headerBg: '#ededed',
    headerFg: '#111111',
    headerBorder: '#d9d9d9',
    bg: '#f5f5f5',
    selfBubble: '#95ec69',
    otherBubble: '#ffffff',
    bubbleFg: '#111111',
    metaFg: '#8a8a8a',
    accent: '#07c160',
    bubbleRadius: '8px',
    bubbleTail: true,
  },
  telegram: {
    label: 'Telegram',
    headerBg: '#517da2',
    headerFg: '#ffffff',
    headerBorder: '#3f6d92',
    bg: '#a3c2d6',
    selfBubble: '#effdde',
    otherBubble: '#ffffff',
    bubbleFg: '#111111',
    metaFg: '#5f7d8f',
    accent: '#3390ec',
    bubbleRadius: '16px',
    bubbleTail: false,
  },
  whatsapp: {
    label: 'WhatsApp',
    headerBg: '#075e54',
    headerFg: '#ffffff',
    headerBorder: '#064c44',
    bg: '#ece5dd',
    selfBubble: '#dcf8c6',
    otherBubble: '#ffffff',
    bubbleFg: '#111111',
    metaFg: '#667781',
    accent: '#25d366',
    bubbleRadius: '10px',
    bubbleTail: true,
  },
});

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeMime(mime) {
  const value = String(mime ?? '').toLowerCase();
  if (/^image\/(png|jpeg|jpg|webp|gif)$/.test(value)) return value === 'image/jpg' ? 'image/jpeg' : value;
  return null;
}

export function assetToDataUri(asset) {
  if (!asset) return null;
  if (typeof asset === 'string') {
    return /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(asset) ? asset : null;
  }
  if (typeof asset !== 'object') return null;
  const mime = safeMime(asset.mime);
  if (!mime) return null;
  const base64 = String(asset.dataBase64 ?? '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
  return `data:${mime};base64,${base64}`;
}

function avatarColor(id) {
  // Deterministic palette index based on the participant id.
  let hash = 0;
  for (const ch of String(id ?? '')) hash = (hash * 31 + ch.charCodeAt(0)) % 100000;
  const palette = ['#f6a623', '#5b8def', '#e26d5c', '#59b98f', '#9b6bd6', '#3f9aa8', '#d67ab1', '#8a9a5b'];
  return palette[hash % palette.length];
}

function initials(name) {
  const value = String(name ?? '').trim();
  if (!value) return '?';
  const chars = [...value];
  return escapeHtml(chars.slice(0, 2).join(''));
}

function formatDateText(date) {
  if (!date) return '';
  return escapeHtml(String(date));
}

function statusBar(surface, deviceTime, theme) {
  const time = escapeHtml(deviceTime || '09:41');
  if (surface === 'ios') {
    return `<div class="statusbar statusbar-ios"><span class="status-time">${time}</span><span class="status-icons" aria-hidden="true"><span class="signal">▮▮▮</span><span class="wifi">▲</span><span class="battery"><span class="battery-level"></span></span></span></div>`;
  }
  if (surface === 'android') {
    return `<div class="statusbar statusbar-android"><span class="status-icons" aria-hidden="true"><span class="signal">▮▮▮</span><span class="wifi">▲</span></span><span class="status-time">${time}</span><span class="status-icons" aria-hidden="true"><span class="battery"><span class="battery-level"></span></span></span></div>`;
  }
  // desktop / web: window chrome instead of a phone status bar.
  const isWeb = surface === 'web';
  return `<div class="windowbar windowbar-${isWeb ? 'web' : 'desktop'}"><span class="traffic" aria-hidden="true"><i></i><i></i><i></i></span><span class="window-title">${escapeHtml(theme.label)}</span><span class="window-time">${time}</span></div>`;
}

function renderMessage(message, context) {
  const { theme, surface, participantsById, selfId } = context;
  const participant = participantsById.get(message.participantId) ?? null;
  const isSelf = message.participantId === selfId;

  if (message.type === 'system') {
    return `<div class="system-message"><span>${escapeHtml(message.text)}</span><time>${escapeHtml(message.time)}</time></div>`;
  }

  const name = participant?.name ?? '?';
  const avatar = `<span class="avatar" style="background:${avatarColor(message.participantId)}">${initials(name)}</span>`;
  const meta = `<span class="meta">${isSelf ? '' : `<span class="meta-name">${escapeHtml(name)}</span>`}<time>${escapeHtml(message.time)}</time></span>`;

  if (message.type === 'image') {
    const uri = context.assets[message.assetIndex] ?? null;
    const caption = message.text ? `<div class="caption">${escapeHtml(message.text)}</div>` : '';
    const inner = uri
      ? `<img class="bubble-image" src="${escapeHtml(uri)}" alt="${escapeHtml(message.text || '图片消息')}" />`
      : `<div class="image-placeholder">[图片]${message.text ? ` ${escapeHtml(message.text)}` : ''}</div>`;
    return `<div class="row ${isSelf ? 'row-self' : 'row-other'}">${isSelf ? '' : avatar}<div class="bubble bubble-image-wrap">${meta}${inner}${caption}</div></div>`;
  }

  if (message.type === 'location') {
    return `<div class="row ${isSelf ? 'row-self' : 'row-other'}">${isSelf ? '' : avatar}<div class="bubble"><span class="location-pin" aria-hidden="true">📍</span><span class="bubble-text">${escapeHtml(message.text || '位置')}</span>${meta}</div></div>`;
  }

  return `<div class="row ${isSelf ? 'row-self' : 'row-other'}">${isSelf ? '' : avatar}<div class="bubble"><span class="bubble-text">${escapeHtml(message.text)}</span>${meta}</div></div>`;
}

/**
 * @param {object} scene validated conversation scene
 * @param {{ surface?: string, width?: number, outputKind?: string, assets?: Array<object|string> }} options
 * @returns {string} full HTML document
 */
export function renderSceneHtml(scene, options = {}) {
  if (!scene || typeof scene !== 'object') {
    throw new TypeError('renderSceneHtml 需要 scene 对象');
  }
  const surface = RENDERER_SURFACES.includes(options.surface) ? options.surface : 'ios';
  const width = Number.isInteger(options.width) && options.width > 0 ? options.width : 390;
  const outputKind = options.outputKind === 'long-screenshot' ? 'long-screenshot' : 'screenshot';
  // Never trust scene.platform as a CSS class: normalize to a known enum.
  const platform = RENDERER_PLATFORMS.includes(scene.platform) ? scene.platform : 'wechat';
  const theme = PLATFORM_THEMES[platform];

  const assetsInput = Array.isArray(options.assets) ? options.assets : [];
  const assets = assetsInput.map(assetToDataUri);

  const participantsById = new Map((scene.participants ?? []).map((p) => [p.id, p]));
  const context = { theme, surface, participantsById, selfId: scene.selfId, assets };

  const headerTitle = escapeHtml(scene.title || participantsById.get(scene.selfId)?.name || 'Chat');
  const dateDivider = scene.date
    ? `<div class="date-divider"><span>${formatDateText(scene.date)}</span></div>`
    : '';

  const body = (scene.messages ?? []).map((m) => renderMessage(m, context)).join('\n      ');
  const watermark = scene.watermark
    ? `<div class="watermark" aria-hidden="true">${escapeHtml(scene.watermark)}</div>`
    : '';
  const surfaceClass = `surface-${surface}`;
  const kindClass = `kind-${outputKind}`;
  const platformClass = `platform-${platform}`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=${width}, initial-scale=1" />
<title>${headerTitle}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #ffffff; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB",
      "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #111111;
    -webkit-font-smoothing: antialiased;
  }
  .device {
    width: ${width}px;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    background: ${theme.bg};
    position: relative;
  }
  /* The device grows with its content in both modes. A normal screenshot is
     captured at a fixed viewport, so the screenshotter measures the real
     content height and reports output_too_tall instead of silently clipping. */
  body.kind-long-screenshot .device { height: auto; min-height: 0; }

  .statusbar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 14px;
    font-size: 12px;
    color: ${theme.headerFg};
    background: ${theme.headerBg};
  }
  .statusbar-ios { height: 44px; padding-top: 6px; }
  .statusbar-android { height: 32px; padding-top: 2px; }
  .status-icons { display: inline-flex; align-items: center; gap: 5px; opacity: 0.92; }
  .signal { letter-spacing: -1px; font-size: 10px; }
  .wifi { font-size: 9px; }
  .battery {
    width: 20px; height: 10px; border: 1px solid currentColor; border-radius: 2px;
    display: inline-block; position: relative; padding: 1px;
  }
  .battery-level { display: block; width: 70%; height: 100%; background: currentColor; border-radius: 1px; }

  .windowbar {
    flex: 0 0 auto; height: 38px; display: flex; align-items: center; gap: 10px;
    padding: 0 14px; background: ${theme.headerBg}; color: ${theme.headerFg}; font-size: 12px;
  }
  .traffic { display: inline-flex; gap: 6px; }
  .traffic i { width: 11px; height: 11px; border-radius: 50%; background: rgba(255,255,255,0.55); display: inline-block; }
  .traffic i:nth-child(1) { background: #ff5f57; }
  .traffic i:nth-child(2) { background: #febc2e; }
  .traffic i:nth-child(3) { background: #28c840; }
  .window-title { font-weight: 600; opacity: 0.95; }
  .windowbar-web .window-title { opacity: 0.85; }
  .window-time { margin-left: auto; opacity: 0.85; }

  .chat-header {
    flex: 0 0 auto; display: flex; align-items: center; gap: 10px;
    padding: 10px 14px; background: ${theme.headerBg}; color: ${theme.headerFg};
    border-bottom: 1px solid ${theme.headerBorder};
  }
  .chat-header .back { font-size: 18px; opacity: 0.9; }
  .chat-header .title { font-size: 16px; font-weight: 600; }
  .chat-header .spacer { margin-left: auto; font-size: 18px; opacity: 0.9; }

  .messages {
    flex: 1 1 auto;
    padding: 14px 12px 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    background: ${theme.bg};
  }
  .date-divider { text-align: center; color: ${theme.metaFg}; font-size: 11px; }
  .date-divider span { background: rgba(0,0,0,0.06); border-radius: 10px; padding: 2px 10px; }

  .system-message {
    text-align: center; color: ${theme.metaFg}; font-size: 11px;
    display: flex; flex-direction: column; gap: 2px; align-items: center;
  }
  .system-message span { background: rgba(0,0,0,0.06); border-radius: 10px; padding: 3px 10px; max-width: 80%; }
  .system-message time { font-size: 10px; opacity: 0.8; }

  .row { display: flex; align-items: flex-start; gap: 8px; max-width: 100%; }
  .row-other { justify-content: flex-start; }
  .row-self { justify-content: flex-end; }
  .avatar {
    flex: 0 0 auto; width: 34px; height: 34px; border-radius: 6px;
    display: inline-flex; align-items: center; justify-content: center;
    color: #ffffff; font-size: 13px; font-weight: 600;
  }
  .bubble {
    position: relative; max-width: 74%; padding: 9px 12px 8px;
    border-radius: ${theme.bubbleRadius}; background: ${theme.otherBubble}; color: ${theme.bubbleFg};
    box-shadow: 0 1px 1px rgba(0,0,0,0.06);
    display: flex; flex-direction: column; gap: 4px;
  }
  .row-self .bubble { background: ${theme.selfBubble}; }
  .bubble-text { font-size: 15px; line-height: 1.4; white-space: pre-wrap; word-break: break-word; }
  .meta { display: flex; align-items: center; gap: 6px; font-size: 10px; color: ${theme.metaFg}; }
  .row-self .meta { justify-content: flex-end; }
  .meta-name { font-weight: 600; opacity: 0.9; }
  .meta time { opacity: 0.85; }
  .bubble-image-wrap { padding: 5px; gap: 5px; }
  .bubble-image { display: block; width: 100%; max-width: 220px; height: auto; border-radius: 6px; background: rgba(0,0,0,0.05); }
  .image-placeholder {
    width: 180px; height: 120px; border-radius: 6px; background: rgba(0,0,0,0.08);
    display: flex; align-items: center; justify-content: center; color: ${theme.metaFg}; font-size: 13px;
  }
  .caption { font-size: 13px; line-height: 1.35; white-space: pre-wrap; word-break: break-word; }
  .location-pin { font-size: 14px; }

  .composer {
    flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
    padding: 9px 12px; background: ${theme.headerBg}; border-top: 1px solid ${theme.headerBorder};
  }
  .composer .field { flex: 1 1 auto; height: 32px; border-radius: 16px; background: rgba(255,255,255,0.92); }
  .composer .icon { width: 22px; height: 22px; border-radius: 50%; border: 2px solid ${theme.accent}; flex: 0 0 auto; }

  .watermark {
    position: absolute; right: 10px; bottom: 54px; font-size: 10px; color: ${theme.metaFg};
    opacity: 0.7; pointer-events: none;
  }

  /* Surface-specific framing. */
  body.surface-ios .device { border-radius: 0; }
  body.surface-android .chat-header { padding-top: 12px; padding-bottom: 12px; }
  body.surface-desktop .messages, body.surface-web .messages { padding: 18px 20px 24px; }
  body.surface-desktop .bubble, body.surface-web .bubble { max-width: 64%; }
  body.surface-desktop .device, body.surface-web .device { min-height: 100vh; }
</style>
</head>
<body class="${platformClass} ${surfaceClass} ${kindClass}">
  <div class="device">
    ${statusBar(surface, scene.deviceTime, theme)}
    <header class="chat-header">
      <span class="back" aria-hidden="true">${surface === 'android' ? '←' : surface === 'desktop' || surface === 'web' ? '' : '‹'}</span>
      <span class="title">${headerTitle}</span>
      <span class="spacer" aria-hidden="true">${surface === 'desktop' || surface === 'web' ? '' : '⋯'}</span>
    </header>
    <main class="messages">
      ${dateDivider}
      ${body}
    </main>
    <footer class="composer"><span class="icon" aria-hidden="true"></span><span class="field"></span></footer>
    ${watermark}
  </div>
</body>
</html>
`;
}

export default renderSceneHtml;
