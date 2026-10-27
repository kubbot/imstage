// GET-217 deterministic renderer A/B: baseline (7d3e075) vs current (origin/main).
// Usage: node get217-ab.mjs <worktreeDir> <outDir>
// Renders identical legacy-platform scenes through that worktree's
// tools/eval/src/render.mjs and writes PNGs + a results JSON.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const wt = process.argv[2];
const outDir = process.argv[3];
fs.mkdirSync(outDir, { recursive: true });

const { renderScenePng } = await import(pathToFileURL(path.join(wt, 'tools/eval/src/render.mjs')).href);

// 1x1 red PNG + a slightly bigger blue PNG as image assets (data handled by renderer via assets array).
const pngB64 = (hex) => Buffer.from(hex, 'hex').toString('base64');
// Minimal valid 8x8 PNG generated offline is overkill; use assets as data URIs via scene asset fields instead.
// The eval renderer accepts options.assets as raw values consumed by assetToDataUri in renderSceneHtml.
// We pass simple data URIs directly.
const RED = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=';
const assets = [RED];

const base = {
  deviceTime: '09:41', date: '2026-10-20', selfId: 'me',
  participants: [
    { id: 'me', name: '我' },
    { id: 'a', name: '小林' },
    { id: 'b', name: '阿May' },
  ],
};
const T = (id, participantId, text, extra = {}) => ({ id, participantId, type: 'text', text, time: '10:0' + (id.length % 10), ...extra });

const scenes = {};
for (const platform of ['wechat', 'whatsapp', 'instagram']) {
  scenes[`${platform}-basic`] = {
    ...base, id: `${platform}-basic`, platform, title: '基础对话',
    messages: [
      T('m1', 'a', '早上好，昨天的文件看了吗？'),
      T('m2', 'me', '看了，第三页的数据需要再确认一下。'),
      T('m3', 'a', '好的，我下午重新核对后发你。'),
      T('m4', 'me', '辛苦了，顺便把会议纪要也一起发我。'),
      T('m5', 'a', '没问题👍'),
    ],
  };
  scenes[`${platform}-rich`] = {
    ...base, id: `${platform}-rich`, platform, title: '富媒体',
    messages: [
      T('m1', 'a', '这是现场照片', {}),
      { id: 'm2', participantId: 'a', type: 'image', assetIndex: 0, text: '现场图', time: '10:02' },
      { id: 'm3', participantId: 'me', type: 'voice', text: '语音', subtitle: '12"', voiceTranscript: '我觉得这个方案可以，就按这个推进吧。', time: '10:03' },
      { id: 'm4', participantId: 'a', type: 'location', text: '上海市黄浦区', time: '10:04' },
      { id: 'm5', participantId: 'me', type: 'link', text: '项目文档', subtitle: '点击查看完整说明', time: '10:05' },
      { id: 'm6', participantId: 'a', type: 'contact', text: '小林', subtitle: '名片', time: '10:06' },
      { id: 'm7', participantId: 'me', type: 'video', text: '演示视频', subtitle: '0:42', time: '10:07' },
      { id: 'm8', participantId: 'a', type: 'album', text: '相册', items: [{ id: 'i1', kind: 'image', asset: RED, caption: '样本 A' }, { id: 'i2', kind: 'video', caption: '样本 B' }], time: '10:08' },
    ],
  };
  scenes[`${platform}-quote`] = {
    ...base, id: `${platform}-quote`, platform, title: '引用',
    messages: [
      T('m1', 'a', '报价确认了吗？'),
      T('m2', 'me', '确认了，按这个执行', { quote: '报价确认了吗？' }),
      { id: 'm3', participantId: 'a', type: 'image', assetIndex: 0, text: '合同截图', quote: '确认了，按这个执行', time: '10:03' },
      { id: 'm4', participantId: 'me', type: 'voice', text: '语音', subtitle: '5"', voiceTranscript: '好的。', quote: '报价确认了吗？', time: '10:04' },
    ],
  };
  scenes[`${platform}-long`] = {
    ...base, id: `${platform}-long`, platform, title: '长对话',
    messages: Array.from({ length: 25 }, (_, i) => T('m' + i, i % 2 ? 'me' : 'a', `第 ${i + 1} 条消息，这是一段比较长的合成文本，用来把内容推到一屏之外，必须完整保留。`)),
  };
}

const results = {};
for (const [name, scene] of Object.entries(scenes)) {
  try {
    const r = await renderScenePng(scene, { width: 390, height: 844, assets });
    fs.writeFileSync(path.join(outDir, name + '.png'), r.buffer);
    results[name] = { ok: true, width: r.width, height: r.height, bytes: r.buffer.length };
  } catch (e) {
    results[name] = { ok: false, code: e.code || null, message: String(e.message || e).slice(0, 200) };
  }
}
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
