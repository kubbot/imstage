import { validateScene, type Scene } from '../studio/model';
export type ToolEvent = { type: 'tool'; id: string; name: string; state: 'running' | 'done' | 'error'; detail: string };
export type AgentEvent = ToolEvent | { type: 'scene'; scene: Scene } | { type: 'assistant'; text: string } | { type: 'done' };
export type ChatEntry = { role: 'user' | 'assistant'; content: string };
export async function* runAgent(input: { prompt: string; scene: Scene; targetId?: string; attachments: string[]; history: ChatEntry[] }, userId: string, signal: AbortSignal): AsyncGenerator<AgentEvent> {
  const response = await fetch('/api/agent/run', { method: 'POST', credentials: 'same-origin', signal, headers: { 'Content-Type': 'application/json', 'X-IMStage-Request': '1', 'X-IMStage-User': userId }, body: JSON.stringify(input) });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(response.status === 401 ? '登录已过期。请先保存或导出当前画面，再重新登录。' : body?.error?.message || 'Agent 暂时连接不上，请重试。');
  }
  if (!response.body || !response.headers.get('content-type')?.includes('application/x-ndjson')) throw new Error('Agent 返回了无法识别的响应。');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let done = false; let bytes = 0;
  function parse(line: string): AgentEvent {
    const item = JSON.parse(line);
    if (item.type === 'error') throw new Error(typeof item.message === 'string' ? item.message : '生成未完成。');
    if (item.type === 'scene') { const result = validateScene(item.scene); if (!result.ok || !result.scene) throw new Error('生成的场景未通过校验，已保留上一份画面。'); return { type: 'scene', scene: result.scene }; }
    if (item.type === 'assistant' && typeof item.text === 'string' && item.text.length < 16000) return item;
    if (item.type === 'tool' && ['id', 'name', 'detail'].every(key => typeof item[key] === 'string') && ['running','done','error'].includes(item.state)) return item;
    if (item.type === 'done') { done = true; return item; }
    throw new Error('Agent 事件格式不正确。');
  }
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) { buffer += decoder.decode(); break; }
      bytes += chunk.value.byteLength; if (bytes > 96 * 1024 * 1024) throw new Error('生成结果过大，请减少图片后重试。');
      buffer += decoder.decode(chunk.value, { stream: true });
      let split: number;
      while ((split = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, split).trim(); buffer = buffer.slice(split + 1); if (line) { if (done) throw new Error('Agent 在完成后仍发送数据。'); yield parse(line); } }
      if (buffer.length > 20 * 1024 * 1024) throw new Error('单次生成内容过大。');
    }
    if (buffer.trim()) { if (done) throw new Error('Agent 响应顺序错误。'); yield parse(buffer); }
    if (!done) throw new Error('连接提前结束，已保留收到的画面。可重试。');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
