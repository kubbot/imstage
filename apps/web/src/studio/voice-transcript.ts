import { VOICE_TRANSCRIPT_MAX, voiceTranscriptError } from '../../../../packages/schema/voice.mjs';
import type { Message, MessagePatch, MessageType, NewMessageInput } from './model';
/**
 * Studio-side voice message helpers (pure, framework-free).
 *
 * The transcript is always explicit authoring: these helpers only *move* text
 * the user already typed into the visible `voiceTranscript` field (or back),
 * as one deliberate reversible edit. They never infer words from audio, never
 * read legacy `text`/`subtitle` labels as hidden transcripts and never invent a
 * duration. Shared semantics live in `packages/schema/voice.mjs`.
 *
 * Invalid submissions (over the 2000-char transcript cap) are rejected with a
 * typed `VoiceTranscriptError` BEFORE any scene mutation — never silently
 * truncated. Every UI caller catches it and surfaces the reason while keeping
 * the previous valid scene, the typed input and undo history intact. Ordinary
 * message text is never length-restricted.
 */

/** Typed failure for invalid voice submissions/conversions (caught by UI callers). */
export class VoiceTranscriptError extends Error {
  readonly code = 'voice_transcript_invalid';

  constructor(message: string) {
    super(message);
    this.name = 'VoiceTranscriptError';
  }
}

/** Throws a typed error when `value` is not an acceptable explicit transcript. */
export function assertVoiceTranscript(value: string): void {
  const reason = voiceTranscriptError(value, 'voice');
  if (reason) throw new VoiceTranscriptError(reason);
}

/**
 * Patch for an explicit message-type switch in the editor.
 *
 * - TEXT → VOICE copies the authored wording into the visible transcript field
 *   and leaves the voice bubble on its neutral label (empty `text` renders as
 *   语音/Voice). One `updateMessage` call, so undo restores the text message.
 *   If the authored wording exceeds the transcript cap, this throws
 *   `VoiceTranscriptError` first — the caller keeps the old valid scene and
 *   surfaces the error instead of silently truncating the wording.
 * - VOICE → any other type drops the transcript (non-voice use is invalid) and,
 *   when switching to TEXT with an empty bubble label, moves the transcript
 *   wording back into `text` so nothing is lost but undo still reverts it.
 * - Every other conversion behaves exactly as before.
 */
export function messageTypeChangePatch(
  message: Message,
  type: MessageType,
  selfId: string,
): MessagePatch {
  const patch: MessagePatch = { type, participantId: type === 'system' ? '' : selfId };
  if (type === 'voice' && message.type === 'text' && !message.voiceTranscript && message.text.trim() !== '') {
    if (message.text.length > VOICE_TRANSCRIPT_MAX) {
      throw new VoiceTranscriptError(
        `切换为语音失败：文本 ${message.text.length} 字超过语音文字稿 ${VOICE_TRANSCRIPT_MAX} 字上限，请先精简文本或手动填写文字稿`,
      );
    }
    assertVoiceTranscript(message.text);
    patch.voiceTranscript = message.text;
    patch.text = '';
  } else if (type !== 'voice' && message.type === 'voice') {
    patch.voiceTranscript = undefined;
    if (type === 'text' && message.text.trim() === '' && message.voiceTranscript) patch.text = message.voiceTranscript;
  }
  return patch;
}

/**
 * Input for a new voice message created from the composer: the authored words
 * become the explicit synthetic transcript and the bubble keeps a neutral
 * label (empty `text` → 语音/Voice at render time) instead of an invented
 * duration. Throws `VoiceTranscriptError` for over-long input so the UI can
 * reject the submission visibly before any state change.
 */
export function newVoiceMessageInput(
  words: string,
  participantId: string,
  time: string,
): NewMessageInput {
  assertVoiceTranscript(words);
  return { type: 'voice', text: '', voiceTranscript: words, participantId, time };
}
