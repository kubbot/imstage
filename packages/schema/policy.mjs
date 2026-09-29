/**
 * IMStage shared safety / positioning policy (framework-neutral).
 *
 * One definition for every surface — Web editor, marketing previews, the
 * deterministic renderer, the API server and both MCP servers:
 *
 *   1. Disclosure: every rendered frame and every PNG export carries the
 *      mandatory "AI生成 / 虚构" (AI-generated / Fictional) mark. It cannot be
 *      turned off through the UI, the Agent, an import or the API.
 *   2. Payments: transfer / red-packet / balance style messages are not
 *      supported anywhere. Legacy or imported scenes are neutralised, never
 *      silently deleted (stored work is preserved as a neutral notice).
 *   3. Real screenshots: reference-scene ("edit a real screenshot") documents
 *      are rejected on all public surfaces. Internal offline evaluation code
 *      may keep its research implementation, but it is unreachable publicly.
 *   4. Generic rendering: the product renders its own generic IMStage chat UI.
 *      Legacy platform identifiers may survive in stored data for migration,
 *      but no public rendered output shows a brand logo or platform clone.
 *
 * This module must stay dependency-free (no `node:` imports, no DOM) so the
 * browser bundle and plain Node share exactly one policy.
 */

/** Bump when a policy-visible behaviour changes; recorded in the audit log. */
export const POLICY_VERSION = 'imstage-safety-2026-09-30';

/** The mandatory visible disclosure. Bilingual on purpose: exports travel. */
export const DISCLOSURE_TEXT = 'AI生成 / 虚构 · AI-generated / Fictional';

/** Shorter in-frame label; still contains both mandated words. */
export const DISCLOSURE_SHORT = 'AI生成 / 虚构';

/** DOM hooks used by the browser renderer and by export/crop tooling. */
export const DISCLOSURE_CLASS = 'imstage-disclosure';
export const DISCLOSURE_ATTRIBUTE = 'data-imstage-disclosure';

/**
 * Immutable inline styles for the mandatory disclosure band. Inline styles
 * travel with the DOM node into every export (html-to-image copies them) and
 * cannot be overridden by custom layout tokens, scene appearance or themes.
 * The band sits below device chrome in the fixed header, so ordinary, long and
 * scrolled/cropped exports all keep it in view.
 */
export const DISCLOSURE_STYLE = Object.freeze({
  position: 'relative',
  display: 'block',
  flex: '0 0 auto',
  width: '100%',
  boxSizing: 'border-box',
  margin: '0',
  padding: '4px 10px',
  background: '#1f2430',
  color: '#ffffff',
  fontSize: '11px',
  lineHeight: '1.5',
  letterSpacing: '0.02em',
  textAlign: 'center',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  pointerEvents: 'none',
});

/** Same styles serialised for the deterministic HTML renderer. */
export function disclosureStyleText() {
  return Object.entries(DISCLOSURE_STYLE)
    .map(([key, value]) => `${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}:${value}`)
    .join(';');
}

/**
 * Message types that depict payments, transfers, red packets or balances.
 * Both current ids and legacy/imported spellings are listed, so an old stored
 * scene can never smuggle a payment card through a renamed type.
 */
export const PAYMENT_MESSAGE_TYPES = Object.freeze([
  'transfer',
  'redpacket',
  'red_packet',
  'red-packet',
  'hongbao',
  'lucky-money',
  'lucky_money',
  'balance',
  'payment',
  'pay',
  'wallet',
  'cash',
  'coupon',
  'money',
  'bill',
]);

/** Marker for any payment-style attempt (type or legacy alias). */
export function isPaymentMessageType(type) {
  return typeof type === 'string' && PAYMENT_MESSAGE_TYPES.includes(type);
}

/** Neutral replacement text; the original text is not rendered. */
export const PAYMENT_NEUTRALIZED_TEXT = '该消息类型已停用（不支持支付/转账/红包类内容）';
export const PAYMENT_NEUTRALIZED_TEXT_EN = 'This message type is disabled (no payment, transfer or red-packet content).';

/**
 * Neutralise payment-style messages in a messages array.
 *
 * The message is kept (ids, order and timestamps survive) but its payload is
 * replaced with a plain system notice — stored work is never erased and a
 * payment card can never render again.
 *
 * @param {ReadonlyArray<object>|undefined} messages
 * @returns {{ messages: object[], neutralized: number }}
 */
export function neutralizePaymentMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let neutralized = 0;
  const next = list.map((message) => {
    if (!message || typeof message !== 'object') return message;
    if (!isPaymentMessageType(message.type)) return message;
    neutralized += 1;
    return {
      ...message,
      type: 'system',
      participantId: '',
      text: PAYMENT_NEUTRALIZED_TEXT,
      subtitle: undefined,
      quote: undefined,
      asset: undefined,
      items: undefined,
      width: undefined,
      height: undefined,
    };
  });
  return { messages: next, neutralized };
}

/** True when any message still carries a banned payment type. */
export function hasPaymentMessages(messages) {
  return Array.isArray(messages) && messages.some((m) => m && isPaymentMessageType(m.type));
}

/** Field names a producer might use to try to disable the disclosure. */
export const DISCLOSURE_OVERRIDE_FIELDS = Object.freeze([
  'showFictionalMark',
  'fictionalMark',
  'showMark',
  'hideDisclosure',
  'disclosure',
  'watermarkEnabled',
  'markEnabled',
]);

/**
 * Strip fields that attempt to toggle the mandatory disclosure. The disclosure
 * is unconditional, so any such key is simply dropped before validation.
 *
 * @param {Record<string, unknown>} raw
 * @returns {Record<string, unknown>}
 */
export function stripDisclosureOverrides(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  let changed = false;
  const next = { ...raw };
  for (const key of DISCLOSURE_OVERRIDE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(next, key)) {
      delete next[key];
      changed = true;
    }
  }
  return changed ? next : raw;
}

/**
 * Reject reference-scene ("real screenshot editing") documents on public
 * surfaces. Internal offline evaluation tooling keeps its own research code
 * paths and never calls this gate in reverse.
 */
export function hasReferenceLayer(scene) {
  if (!scene || typeof scene !== 'object') return false;
  const reference = scene.reference;
  return reference !== undefined && reference !== null && reference !== '';
}

export const REFERENCE_DISABLED_MESSAGE =
  '真实截图参考编辑已停用：仅支持合成（虚构）对话场景 / Real-screenshot reference editing is disabled; synthetic fictional scenes only.';

/**
 * Stable, order-independent serialisation used for audit scene hashes.
 * The digest stores no raw content; it can still be compared with known inputs.
 */
export function canonicalSceneJson(scene) {
  return JSON.stringify(sortValue(scene));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}
