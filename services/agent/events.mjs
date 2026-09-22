/**
 * IMStage Agent — NDJSON event contract.
 *
 * The stream emitted by `POST /api/agent/run` is exactly one of these records
 * per line, and nothing else:
 *
 *   {type:'scene', scene}
 *   {type:'tool', id, name, state:'running'|'done'|'error', detail}
 *   {type:'assistant', text}
 *   {type:'done'}
 *   {type:'error', message}
 *
 * `serializeAgentEvent` builds each object explicitly so internal bookkeeping
 * can never leak onto the wire.
 */

import { AGENT_MAX_ASSISTANT_CHARS, AGENT_MAX_TOOL_DETAIL_CHARS } from './config.mjs';

export const AGENT_EVENT_TYPES = Object.freeze(['scene', 'tool', 'assistant', 'done', 'error']);
export const AGENT_TOOL_STATES = Object.freeze(['running', 'done', 'error']);

function clampText(value, max) {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function requireObject(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
  return value;
}

/**
 * Serialize one event to a single NDJSON line (including the trailing `\n`).
 * Throws for unknown event types or malformed tool states.
 */
export function serializeAgentEvent(event) {
  requireObject(event, 'agent 事件');
  switch (event.type) {
    case 'scene':
      requireObject(event.scene, 'scene 事件');
      return `${JSON.stringify({ type: 'scene', scene: event.scene })}\n`;
    case 'tool': {
      if (!AGENT_TOOL_STATES.includes(event.state)) {
        throw new Error(`未知的 tool 状态：${String(event.state)}`);
      }
      const id = typeof event.id === 'string' && event.id !== '' ? event.id : 'tool';
      const name = typeof event.name === 'string' && event.name !== '' ? event.name : 'unknown';
      return `${JSON.stringify({
        type: 'tool',
        id,
        name,
        state: event.state,
        detail: clampText(event.detail, AGENT_MAX_TOOL_DETAIL_CHARS),
      })}\n`;
    }
    case 'assistant':
      return `${JSON.stringify({
        type: 'assistant',
        text: clampText(event.text, AGENT_MAX_ASSISTANT_CHARS),
      })}\n`;
    case 'done':
      return `${JSON.stringify({ type: 'done' })}\n`;
    case 'error':
      return `${JSON.stringify({ type: 'error', message: clampText(event.message, AGENT_MAX_TOOL_DETAIL_CHARS) })}\n`;
    default:
      throw new Error(`未知的 agent 事件类型：${String(event.type)}`);
  }
}
