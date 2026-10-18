// Shared voice-message semantics (framework-free).
//
// One optional, explicit, user-authored transcript field for voice messages:
//
//   Message.voiceTranscript?: string   // bounded, visible, never inferred
//
// Contract (GET-35):
// - OPTIONAL. Omitting it preserves legacy scenes byte-for-byte and keeps the
//   honest "no transcript" placeholder in every renderer.
// - NEVER inferred: old `text`/`subtitle` voice labels and durations are legacy
//   bubble copy, not hidden transcript data. Nothing here (or anywhere else)
//   transcribes audio, calls a speech service, or migrates hidden fields.
// - Bounded: at most `VOICE_TRANSCRIPT_MAX` characters (the shared text cap).
//   Over-long or wrongly-typed values are rejected, never silently truncated.
// - Voice-only: a transcript on a non-voice message is rejected as
//   inappropriate use instead of letting an unbounded hidden payload through.
// - Every renderer (React SceneView, MCP SceneView SSR, deterministic HTML)
//   treats the field with the same semantics; see docs/get-35-voice-tablet.md.

/** Shared transcript cap: same bound as the MCP message text limit. */
export const VOICE_TRANSCRIPT_MAX = 2000;

/**
 * Validate one untrusted `voiceTranscript` value against the shared contract.
 * Returns a human-readable reason, or `undefined` when the value is acceptable
 * (including `undefined`, i.e. omission). Pure and total.
 *
 * @param {unknown} value
 * @param {string|undefined} messageType canonical message type of the owner
 * @returns {string|undefined}
 */
export function voiceTranscriptError(value, messageType) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return 'voiceTranscript 必须是字符串';
  if (value.length > VOICE_TRANSCRIPT_MAX) return `voiceTranscript 不能超过 ${VOICE_TRANSCRIPT_MAX} 字`;
  if (messageType !== 'voice') return 'voiceTranscript 只能用于语音（voice）消息';
  return undefined;
}

/**
 * Rendered presence: a transcript only renders when it carries visible wording.
 * Whitespace-only values are stored as authored but render as absent, keeping
 * the honest placeholder. Never fabricates text for missing transcripts.
 *
 * @param {{voiceTranscript?: unknown}} [message]
 * @returns {boolean}
 */
export function hasVoiceTranscript(message) {
  return typeof message?.voiceTranscript === 'string' && message.voiceTranscript.trim() !== '';
}
