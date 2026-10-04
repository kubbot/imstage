// Deterministic, framework-neutral IM scene renderer.
//
// renderSceneHtml(scene, { surface, width, outputKind, assets }) -> HTML string
//
// Guarantees:
// - Pure: no fs/network/DOM access, no randomness, no Date.now. Given the same
//   scene/options it always returns the same bytes.
// - Safe: every scene string is HTML-escaped. Uploaded images are embedded as
//   `data:` URIs. No remote resources, no inline event handlers, no scripts.
// - Platform templates: each supported chat platform gets its own distinct
//   header, bubble, avatar and composer chrome — an approximate style preview
//   for synthetic content, never a pixel clone and never a brand logo. The
//   IMStage generic skin is a first-class template of its own. Differences are
//   real: switching `scene.platform` changes the rendered output.
// - Watermark: the "AI生成 / 虚构" disclosure and any custom watermark are drawn
//   by default (new and legacy scenes). `scene.watermarkEnabled === false` — a
//   user choice frozen into the scene — suppresses both. Nothing else can.
// - Payment safety: payment/transfer/red-packet messages render as a neutral
//   system notice, never as a payment card.
// - Surface differences: iOS/Android status bars, desktop/web window chrome.
//
// The companion screenshotter lives in tools/eval/src/render.mjs and loads the
// browser with all network requests aborted; this module never emits one.

import {
  DISCLOSURE_ATTRIBUTE,
  DISCLOSURE_CLASS,
  DISCLOSURE_TEXT,
  disclosureStyleText,
  isPaymentMessageType,
  PAYMENT_NEUTRALIZED_TEXT,
  sceneWatermarkEnabled,
} from '../schema/policy.mjs';

export const RENDERER_VERSION = 'v3';

/**
 * Supported platform templates. An unknown/hostile value falls back to the
 * IMStage generic template — the value is never echoed into a class or style.
 */
export const RENDERER_PLATFORMS = Object.freeze(['imstage', 'wechat', 'telegram', 'whatsapp', 'xiaohongshu', 'imessage', 'slack', 'instagram']);
export const RENDERER_SURFACES = Object.freeze(['ios', 'android', 'desktop', 'web']);

/**
 * One theme per platform template. Colors and metrics follow the shared
 * browser skins (`apps/web/src/studio/platform-templates.ts` + `studio.css`)
 * so the deterministic HTML and the React preview render the same platform.
 */
const PLATFORM_THEMES = Object.freeze({
  imstage: {
    label: 'IMStage', headerBg: '#f5f7fa', headerFg: '#16202e', headerBorder: '#d5dce5',
    bg: '#e9edf2', selfBubble: '#d6e5ff', selfFg: '#16202e', otherBubble: '#ffffff', bubbleFg: '#16202e',
    metaFg: '#5b6675', accent: '#2f6fed', bubbleRadius: '14px', avatarRadius: '6px',
    headerAvatar: false, messageAvatars: 'all', inlineTime: true, bubbleTail: false, composer: 'default',
  },
  wechat: {
    label: '微信 / WeChat', headerBg: '#ededed', headerFg: '#111111', headerBorder: '#d9d9d9',
    bg: '#f5f5f5', selfBubble: '#95ec69', selfFg: '#111111', otherBubble: '#ffffff', bubbleFg: '#111111',
    metaFg: '#8a8a8a', accent: '#07c160', bubbleRadius: '8px', avatarRadius: '7px',
    headerAvatar: false, messageAvatars: 'all', inlineTime: false, bubbleTail: true, composer: 'wechat',
  },
  telegram: {
    // Legacy id kept for stored scenes; renders as its own classic chat skin.
    label: 'Telegram', headerBg: '#517da2', headerFg: '#ffffff', headerBorder: '#3f6d92',
    bg: '#a3c2d6', selfBubble: '#effdde', selfFg: '#111111', otherBubble: '#ffffff', bubbleFg: '#111111',
    metaFg: '#5f7d8f', accent: '#3390ec', bubbleRadius: '16px', avatarRadius: '50%',
    headerAvatar: false, messageAvatars: 'group', inlineTime: true, bubbleTail: false, composer: 'default',
  },
  whatsapp: {
    label: 'WhatsApp', headerBg: '#075e54', headerFg: '#ffffff', headerBorder: '#064c44',
    bg: '#ece5dd', selfBubble: '#d9fdd3', selfFg: '#111111', otherBubble: '#ffffff', bubbleFg: '#111111',
    metaFg: '#667781', accent: '#25d366', bubbleRadius: '10px', avatarRadius: '50%',
    headerAvatar: true, messageAvatars: 'group', inlineTime: true, bubbleTail: true, composer: 'whatsapp',
  },
  imessage: {
    label: 'iMessage', headerBg: '#f8f8fa', headerFg: '#111111', headerBorder: '#ececef',
    bg: '#ffffff', selfBubble: '#0b84ff', selfFg: '#ffffff', otherBubble: '#e9e9eb', bubbleFg: '#111111',
    metaFg: '#8a8a8a', accent: '#0b84ff', bubbleRadius: '18px', avatarRadius: '50%',
    headerAvatar: false, messageAvatars: 'none', inlineTime: false, bubbleTail: false, composer: 'imessage',
  },
  instagram: {
    label: 'Instagram', headerBg: '#ffffff', headerFg: '#111111', headerBorder: '#efefef',
    bg: '#ffffff', selfBubble: '#6750f5', selfFg: '#ffffff', otherBubble: '#f1f1f4', bubbleFg: '#111111',
    metaFg: '#8a8a8a', accent: '#6750f5', bubbleRadius: '20px', avatarRadius: '50%',
    headerAvatar: true, messageAvatars: 'incoming', inlineTime: false, bubbleTail: false, composer: 'instagram',
  },
  xiaohongshu: {
    label: '小红书 / Xiaohongshu', headerBg: '#ffffff', headerFg: '#111111', headerBorder: '#f0f0f2',
    bg: '#ffffff', selfBubble: '#c71f3a', selfFg: '#ffffff', otherBubble: '#f4f4f6', bubbleFg: '#111111',
    metaFg: '#8a8f96', accent: '#c71f3a', bubbleRadius: '14px', avatarRadius: '50%',
    headerAvatar: false, messageAvatars: 'all', inlineTime: false, bubbleTail: false, composer: 'default',
  },
  slack: {
    label: 'Slack', headerBg: '#4a154b', headerFg: '#ffffff', headerBorder: '#3f1240',
    bg: '#ffffff', selfBubble: '#e8e3f0', selfFg: '#111111', otherBubble: '#f4f4f6', bubbleFg: '#111111',
    metaFg: '#616061', accent: '#4a154b', bubbleRadius: '8px', avatarRadius: '4px',
    headerAvatar: false, messageAvatars: 'all', inlineTime: true, bubbleTail: false, composer: 'slack',
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

function showRowAvatar(theme, isSelf, isGroup) {
  if (theme.messageAvatars === 'none') return false;
  if (theme.messageAvatars === 'all') return true;
  if (theme.messageAvatars === 'incoming') return !isSelf;
  return !isSelf && isGroup; // 'group'
}

function renderMessage(message, context) {
  const { theme, participantsById, selfId, isGroup } = context;
  // Payment / transfer / red-packet cards can never render on any surface.
  if (isPaymentMessageType(message.type)) {
    return `<div class="system-message"><span>${escapeHtml(PAYMENT_NEUTRALIZED_TEXT)}</span><time>${escapeHtml(message.time ?? '')}</time></div>`;
  }
  const participant = participantsById.get(message.participantId) ?? null;
  const isSelf = message.participantId === selfId;

  if (message.type === 'system') {
    return `<div class="system-message"><span>${escapeHtml(message.text)}</span><time>${escapeHtml(message.time)}</time></div>`;
  }

  const name = participant?.name ?? '?';
  const avatar = showRowAvatar(theme, isSelf, isGroup)
    ? `<span class="avatar" style="background:${avatarColor(message.participantId)}">${initials(name)}</span>`
    : '';
  const whatsapp = theme.composer === 'whatsapp';
  const receipt = whatsapp && isSelf ? '<svg class="read-receipt" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-label="Read"><path d="m3 12 4 4 10-10M12 16l9-9"/></svg>' : '';
  const metadata = `<time>${escapeHtml(message.time)}</time>${receipt}`;
  const meta = `<span class="meta">${!isSelf && (!whatsapp || isGroup) ? `<span class="meta-name">${escapeHtml(name)}</span>` : ''}${metadata}</span>`;
  const rowTime = theme.inlineTime ? '' : `<span class="row-time">${escapeHtml(message.time ?? '')}</span>`;

  if (message.type === 'image') {
    const uri = context.assets[message.assetIndex] ?? null;
    const caption = message.text ? `<div class="caption">${escapeHtml(message.text)}</div>` : '';
    const inner = uri
      ? `<img class="bubble-image" src="${escapeHtml(uri)}" alt="${escapeHtml(message.text || '图片消息')}" />`
      : `<div class="image-placeholder">[图片]${message.text ? ` ${escapeHtml(message.text)}` : ''}</div>`;
    return `<div class="row ${isSelf ? 'row-self' : 'row-other'}">${isSelf ? '' : avatar}${rowTime}<div class="bubble bubble-image-wrap">${!whatsapp && theme.inlineTime ? meta : ''}${inner}${caption}${whatsapp && theme.inlineTime ? meta : ''}</div>${isSelf && avatar ? avatar : ''}</div>`;
  }

  if (message.type === 'location') {
    return `<div class="row ${isSelf ? 'row-self' : 'row-other'}">${isSelf ? '' : avatar}${rowTime}<div class="bubble"><span class="location-pin" aria-hidden="true">📍</span><span class="bubble-text">${escapeHtml(message.text || '位置')}</span>${theme.inlineTime ? meta : ''}</div>${isSelf && avatar ? avatar : ''}</div>`;
  }

  if (whatsapp && message.type === 'text') {
    const footer = message.time || isSelf ? `<span class="meta-space" aria-hidden="true">${metadata}</span><span class="meta">${metadata}</span>` : '';
    return `<div class="row ${isSelf ? 'row-self' : 'row-other'}">${isSelf ? '' : avatar}<div class="bubble bubble-whatsapp-text">${!isSelf && isGroup ? `<span class="sender-name">${escapeHtml(name)}</span>` : ''}<span class="bubble-text">${escapeHtml(message.text)}</span>${footer}</div>${isSelf && avatar ? avatar : ''}</div>`;
  }
  return `<div class="row ${isSelf ? 'row-self' : 'row-other'}">${isSelf ? '' : avatar}${rowTime}<div class="bubble${theme.bubbleTail ? ' bubble-tail' : ''}"><span class="bubble-text">${escapeHtml(message.text)}</span>${theme.inlineTime ? meta : ''}</div>${isSelf && avatar ? avatar : ''}</div>`;
}

function renderComposer(theme, composerText) {
  const field = escapeHtml(composerText ?? '');
  const empty = field === '';
  switch (theme.composer) {
    case 'wechat':
      return `<footer class="composer composer-wechat"><span class="icon" aria-hidden="true"></span><span class="field"${empty ? '' : ' data-filled="true"'}>${field}</span><span class="icon" aria-hidden="true"></span><span class="icon" aria-hidden="true"></span></footer>`;
    case 'whatsapp':
      return `<footer class="composer composer-whatsapp"><span class="field" ${empty ? '' : 'data-filled="true" '}>${field}</span><span class="icon icon-round" aria-hidden="true">➤</span></footer>`;
    case 'imessage':
      return `<footer class="composer composer-imessage"><span class="field" ${empty ? '' : 'data-filled="true" '}>${field}</span><span class="icon icon-round icon-up" aria-hidden="true">↑</span></footer>`;
    case 'instagram':
      return `<footer class="composer composer-instagram"><span class="avatar-small" aria-hidden="true"></span><span class="field" ${empty ? '' : 'data-filled="true" '}>${field}</span><span class="icon" aria-hidden="true"></span></footer>`;
    case 'slack':
      return `<footer class="composer composer-slack"><span class="field-box"><span class="field" ${empty ? '' : 'data-filled="true" '}>${field}</span><span class="toolbar" aria-hidden="true"><i></i><i></i><i></i></span></span><span class="send" aria-hidden="true">➤</span></footer>`;
    default:
      return `<footer class="composer"><span class="icon" aria-hidden="true"></span><span class="field" ${empty ? '' : 'data-filled="true" '}>${field}</span><span class="icon" aria-hidden="true"></span></footer>`;
  }
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
  // Never trust scene.platform as a CSS class: normalize to a known enum before
  // it reaches the DOM; unknown/hostile values fall back to the generic skin.
  const platform = RENDERER_PLATFORMS.includes(scene.platform) ? scene.platform : 'imstage';
  const theme = { ...PLATFORM_THEMES[platform], ...(platform === 'whatsapp' && surface === 'ios' ? { headerBg: '#efeae2', headerFg: '#111111' } : {}) };
  // User watermark preference: absent means on (new + legacy scenes). Nothing
  // but `watermarkEnabled === false` suppresses the disclosure/custom watermark.
  const watermarkOn = sceneWatermarkEnabled(scene);
  // Supported manual appearance overrides (same bounds as the shared scene
  // contract) win over the platform template defaults, matching the browser
  // renderer's `--scene-*` variables.
  const look = scene.appearance && typeof scene.appearance === 'object' ? scene.appearance : {};
  const num = (value, min, max) => (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null);
  const color = (value) => (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : null);
  const bubbleRadius = num(look.radius, 0, 40);
  const fontPx = num(look.fontSize, 10, 40);
  const messageSpacing = num(look.spacing, 0, 48);
  const textOverride = color(look.color);
  const bubbleOverride = color(look.background);
  const bubbleCss = bubbleOverride ?? theme.otherBubble;
  const selfBubbleCss = bubbleOverride ?? theme.selfBubble;
  const bubbleTextCss = textOverride ?? theme.bubbleFg;
  const selfTextCss = textOverride ?? theme.selfFg;

  const assetsInput = Array.isArray(options.assets) ? options.assets : [];
  const assets = assetsInput.map(assetToDataUri);

  const participantsById = new Map((scene.participants ?? []).map((p) => [p.id, p]));
  const isGroup = (scene.participants ?? []).length > 2;
  const context = { theme, surface, participantsById, selfId: scene.selfId, assets, isGroup };

  const other = (scene.participants ?? []).find((participant) => participant.id !== scene.selfId);
  const headerTitle = escapeHtml(scene.headerText?.trim() || (isGroup ? scene.title || '群聊' : other?.name || participantsById.get(scene.selfId)?.name || '对话'));
  const dateDivider = scene.date
    ? `<div class="date-divider"><span>${formatDateText(scene.date)}</span></div>`
    : '';

  const body = (scene.messages ?? []).map((m) => renderMessage(m, context)).join('\n      ');
  const watermark = watermarkOn && scene.watermark
    ? `<div class="watermark" aria-hidden="true">${escapeHtml(scene.watermark)}</div>`
    : '';
  // AI-generated / fictional disclosure — drawn by default on every preview and
  // export, inside the fixed header band below the status bar. Only a user's
  // explicit `watermarkEnabled: false` turns it (and the custom watermark) off.
  const disclosure = watermarkOn
    ? `<div class="${DISCLOSURE_CLASS}" ${DISCLOSURE_ATTRIBUTE}="true" style="${disclosureStyleText()}">${escapeHtml(DISCLOSURE_TEXT)}</div>`
    : '';
  const surfaceClass = `surface-${surface}`;
  const kindClass = `kind-${outputKind}`;
  const platformClass = `platform-${platform}`;
  const headerAvatar = theme.headerAvatar
    ? `<span class="avatar avatar-header" style="background:${avatarColor(other?.id ?? 'unknown')}">${initials(other?.name ?? '?')}</span>`
    : '';

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
    gap: ${messageSpacing === null ? '12px' : `${messageSpacing}px`};
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
    flex: 0 0 auto; width: 34px; height: 34px; border-radius: ${theme.avatarRadius};
    display: inline-flex; align-items: center; justify-content: center;
    color: #ffffff; font-size: 13px; font-weight: 600;
  }
  .avatar-header { width: 28px; height: 28px; font-size: 11px; }
  .bubble {
    position: relative; max-width: 74%; padding: 9px 12px 8px;
    border-radius: ${bubbleRadius === null ? theme.bubbleRadius : `${bubbleRadius}px`}; background: ${bubbleCss}; color: ${bubbleTextCss};
    box-shadow: 0 1px 1px rgba(0,0,0,0.06);
    display: flex; flex-direction: column; gap: 4px;
  }
  .row-self .bubble { background: ${selfBubbleCss}; color: ${selfTextCss}; }
  .bubble-tail::before {
    content: ''; position: absolute; top: 12px; left: -4px; width: 8px; height: 8px;
    transform: rotate(45deg); background: inherit; border-radius: 1px;
  }
  .row-self .bubble-tail::before { left: auto; right: -4px; }
  .bubble-text { font-size: ${fontPx === null ? '15px' : `${fontPx}px`}; line-height: 1.4; white-space: pre-wrap; word-break: break-word; }
  .meta { display: flex; align-items: center; gap: 6px; font-size: 10px; color: ${theme.metaFg}; }
  .row-self .meta { justify-content: flex-end; }
  .meta-name { font-weight: 600; opacity: 0.9; }
  .meta time { opacity: 0.85; }
  .bubble-whatsapp-text { display:block; padding-bottom:5px; }
  .bubble-whatsapp-text .meta { position:absolute; right:8px; bottom:4px; white-space:nowrap; line-height:16px; }
  .meta-space { display:inline-flex; align-items:center; gap:6px; padding-left:8px; font-size:10px; line-height:16px; height:16px; white-space:nowrap; visibility:hidden; }
  .read-receipt { color:#219bfa; }
  .sender-name { display:block; font-size:11px; color:${theme.metaFg}; margin-bottom:2px; }
  .row-time { flex: 0 0 auto; align-self: center; font-size: 10px; color: ${theme.metaFg}; opacity: 0.85; }
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
  .composer .field {
    flex: 1 1 auto; height: 32px; border-radius: 16px; background: rgba(255,255,255,0.92);
    color: #9aa2ad; font-size: 13px; display: flex; align-items: center; padding: 0 12px;
  }
  .composer .field[data-filled="true"] { color: #111111; }
  .composer .icon { width: 22px; height: 22px; border-radius: 50%; border: 2px solid ${theme.accent}; flex: 0 0 auto; }
  .composer .icon-round { display: inline-flex; align-items: center; justify-content: center; background: ${theme.accent}; color: #ffffff; border: 0; font-size: 12px; width: 30px; height: 30px; }
  .composer-whatsapp .field { background: #ffffff; border-radius: 18px; }
  .composer-imessage .field { background: #ffffff; border: 1px solid ${theme.headerBorder}; border-radius: 16px; }
  .composer-instagram { border-radius: 24px; margin: 6px 10px; background: #f5f5f5; border: 0; }
  .composer-instagram .field { background: transparent; border-radius: 0; height: 26px; }
  .composer-instagram .avatar-small { width: 26px; height: 26px; border-radius: 50%; background: ${theme.accent}; opacity: 0.75; }
  .composer-slack { flex-wrap: wrap; padding-bottom: 6px; }
  .composer-slack .field-box { flex: 1 1 auto; border: 1px solid ${theme.headerBorder}; border-radius: 6px; background: #ffffff; display: flex; flex-direction: column; }
  .composer-slack .field-box .field { border-radius: 6px 6px 0 0; height: 28px; }
  .composer-slack .toolbar { display: flex; gap: 6px; padding: 3px 8px 5px; }
  .composer-slack .toolbar i { width: 14px; height: 10px; border-radius: 2px; background: rgba(0,0,0,0.18); }
  .composer-slack .send { color: ${theme.accent}; font-size: 13px; font-weight: 600; }

  .watermark {
    position: absolute; right: 10px; bottom: 54px; font-size: 10px; color: ${theme.metaFg};
    opacity: 0.7; pointer-events: none;
  }
  .${DISCLOSURE_CLASS} {
    position: relative; display: block; flex: 0 0 auto; width: 100%; box-sizing: border-box;
    margin: 0; padding: 4px 10px; background: #1f2430; color: #ffffff;
    font-size: 11px; line-height: 1.5; letter-spacing: 0.02em; text-align: center;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none;
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
    ${disclosure}
    <header class="chat-header">
      <span class="back" aria-hidden="true">${surface === 'android' ? '←' : surface === 'desktop' || surface === 'web' ? '' : '‹'}</span>
      ${headerAvatar}
      <span class="title">${headerTitle}</span>
      <span class="spacer" aria-hidden="true">${surface === 'desktop' || surface === 'web' ? '' : '⋯'}</span>
    </header>
    <main class="messages">
      ${dateDivider}
      ${body}
    </main>
    ${renderComposer(theme, scene.composerText)}
    ${watermark}
  </div>
</body>
</html>
`;
}

export default renderSceneHtml;
