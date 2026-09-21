// Inline MCP Apps widget for `imstage_render_scene` only.
//
// Design constraints:
//   - The widget markup is static and self-contained: no remote scripts, fonts,
//     images or fetch() calls. All scene values arrive through the MCP Apps
//     bridge and are written with textContent / validated data URIs.
//   - It never executes or injects scene strings as HTML.
//   - It works with the standard MCP Apps bridge (`ui/initialize`,
//     `ui/message`, `ui/download-file`) and degrades to the optional legacy
//     `window.openai` helpers when the bridge is unavailable.
//   - The render tool itself stays fully usable headless: this widget is an
//     optional presentation layer, not a required step.

import { WIDGET_MIME_TYPE } from './limits.mjs';

export const WIDGET_RESOURCE_URI = 'ui://imstage/render-scene.html';
export const WIDGET_TITLE = 'IMStage 渲染预览';

/** CSP for the widget: it connects to and loads from nowhere. */
export const WIDGET_CSP = Object.freeze({ connectDomains: [], resourceDomains: [] });

export function buildRenderWidgetHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${WIDGET_TITLE}</title>
<style>
  :root { color-scheme: light dark; }
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", "Segoe UI", Roboto, sans-serif;
    background: transparent;
    color: var(--color-text-primary, #111111);
  }
  .card { display: flex; flex-direction: column; gap: 12px; padding: 12px; }
  header { display: flex; align-items: flex-start; gap: 12px; }
  .titles { flex: 1 1 auto; min-width: 0; }
  h1 { font-size: 15px; margin: 0 0 2px; font-weight: 600; overflow-wrap: anywhere; }
  .meta { margin: 0; font-size: 12px; color: var(--color-text-secondary, #6b7280); overflow-wrap: anywhere; }
  .preview {
    border: 1px solid var(--color-border-primary, #e5e7eb);
    border-radius: 10px;
    padding: 6px;
    background: var(--color-background-secondary, #f8fafc);
    max-height: 70vh;
    overflow: auto;
  }
  .preview img { display: block; width: 100%; height: auto; border-radius: 6px; background: #ffffff; }
  form { display: flex; flex-direction: column; gap: 6px; }
  label { font-size: 12px; color: var(--color-text-secondary, #6b7280); }
  .row { display: flex; gap: 8px; }
  input[type="text"] {
    flex: 1 1 auto; min-width: 0; padding: 8px 10px; font-size: 13px;
    border: 1px solid var(--color-border-primary, #d1d5db); border-radius: 8px;
    background: var(--color-background-primary, #ffffff); color: inherit;
  }
  button {
    flex: 0 0 auto; padding: 8px 12px; font-size: 13px; font-weight: 600;
    border: 1px solid var(--color-border-primary, #d1d5db); border-radius: 8px;
    background: var(--color-background-primary, #ffffff); color: inherit; cursor: pointer;
  }
  button[disabled] { opacity: 0.5; cursor: default; }
  .status { margin: 0; font-size: 12px; min-height: 16px; color: var(--color-text-secondary, #6b7280); }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main class="card">
  <header>
    <div class="titles">
      <h1 id="scene-title">IMStage 渲染预览</h1>
      <p class="meta" id="scene-meta">等待渲染结果…</p>
    </div>
    <button id="download" type="button" hidden>下载 PNG</button>
  </header>
  <div class="preview" id="preview" hidden>
    <img id="preview-img" alt="IMStage 场景渲染预览" />
  </div>
  <form id="edit-form">
    <label for="edit-input">继续用自然语言修改（会把指令发回 ChatGPT）</label>
    <div class="row">
      <input id="edit-input" type="text" maxlength="500" autocomplete="off"
             placeholder="例如：把标题改成「周末自驾」，再加一条阿远的回复" />
      <button id="edit-submit" type="submit">发送修改</button>
    </div>
    <p class="status" id="status" role="status" aria-live="polite"></p>
  </form>
</main>
<script>
(function () {
  "use strict";
  var pending = Object.create(null);
  var nextId = 1;
  var hostCapabilities = {};
  var latest = { sceneId: null, revision: null, renderId: null, downloadUri: null, dataUri: null, title: null };

  function post(method, params) {
    var id = nextId++;
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      try {
        window.parent.postMessage({ jsonrpc: "2.0", id: id, method: method, params: params }, "*");
      } catch (error) {
        delete pending[id];
        reject(error);
        return;
      }
      setTimeout(function () {
        if (pending[id]) { delete pending[id]; reject(new Error("timeout")); }
      }, 5000);
    });
  }

  function notify(method, params) {
    try {
      window.parent.postMessage({ jsonrpc: "2.0", method: method, params: params }, "*");
    } catch (error) { /* host not listening */ }
  }

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el && typeof value === "string" && value) el.textContent = value;
  }

  function renderFromResult(result) {
    if (!result || typeof result !== "object") return;
    if(result.isError){ document.getElementById("preview").hidden=true; document.getElementById("download").hidden=true; setStatus("生成失败，请在对话中重试。"); return; }
    var structured = result.structuredContent && typeof result.structuredContent === "object" ? result.structuredContent : {};
    var meta = result._meta && typeof result._meta === "object" ? result._meta : {};
    var preview = meta.preview && typeof meta.preview === "object" ? meta.preview : {};

    var dataUri = typeof preview.dataUri === "string" ? preview.dataUri : null;
    if (!dataUri && Array.isArray(result.content)) {
      for (var i = 0; i < result.content.length; i += 1) {
        var block = result.content[i];
        if (block && block.type === "image" && typeof block.data === "string") {
          var mime = typeof block.mimeType === "string" ? block.mimeType : "image/png";
          if (mime !== "image/png" && mime !== "image/jpeg" && mime !== "image/webp") mime = "image/png";
          dataUri = "data:" + mime + ";base64," + block.data;
          break;
        }
      }
    }
    if (dataUri && !/^data:image\\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUri)) dataUri = null;

    latest.sceneId = typeof structured.sceneId === "string" ? structured.sceneId : null;
    latest.revision = Number.isInteger(structured.revision) ? structured.revision : null;
    latest.renderId = typeof structured.renderId === "string" ? structured.renderId : null;
    latest.title = typeof structured.title === "string" ? structured.title : null;

    var downloadUri = typeof structured.downloadUri === "string" ? structured.downloadUri : null;
    if (!downloadUri && typeof preview.downloadUri === "string") downloadUri = preview.downloadUri;
    latest.downloadUri = downloadUri && /^imstage:\\/\\/renders\\/rnd_[0-9a-f]{32}\\.png$/.test(downloadUri) ? downloadUri : null;

    if (latest.title) setText("scene-title", latest.title);
    var metaBits = [];
    if (latest.revision !== null) metaBits.push("revision " + latest.revision);
    if (latest.sceneId) metaBits.push(latest.sceneId);
    if (Number.isInteger(structured.width) && Number.isInteger(structured.height)) metaBits.push(structured.width + "×" + structured.height);
    if (typeof structured.platform === "string") metaBits.push(structured.platform);
    if (metaBits.length) setText("scene-meta", metaBits.join(" · "));

    var previewBox = document.getElementById("preview");
    var img = document.getElementById("preview-img");
    if (dataUri && previewBox && img) {
      latest.dataUri = dataUri;
      img.src = dataUri;
      previewBox.hidden = false;
    }
    document.getElementById("edit-form").hidden = !latest.sceneId;
    var download = document.getElementById("download");
    if (download && (latest.downloadUri || latest.dataUri)) download.hidden = false;
  }

  function setStatus(value) {
    var el = document.getElementById("status");
    if (el) el.textContent = value || "";
  }

  function downloadPng() {
    if(!latest.dataUri) return;
    var name = "imstage-" + (latest.revision || "preview") + ".png";
    if(!hostCapabilities.downloadFile){setStatus("当前宿主不支持组件下载，请在对话中请求导出 PNG。");return;}
    post("ui/download-file", {contents:[{type:"resource",resource:{uri:"file:///"+name,mimeType:"image/png",blob:latest.dataUri.split(",")[1]}}]})
      .then(function(result){if(result && result.isError) throw new Error("download rejected");setStatus("宿主已接受 PNG 下载请求。");})
      .catch(function(){setStatus("下载未完成，请在对话中请求导出 PNG。");});
  }

  function sendEdit(text) {
    var scenePart = latest.sceneId ? "场景 " + latest.sceneId : "当前场景";
    var revisionPart = latest.revision !== null ? "（revision " + latest.revision + "）" : "";
    var message = "请修改 IMStage " + scenePart + revisionPart + "：" + text + "。请调用 imstage_update_scene 后重新调用 imstage_render_scene。";
    post("ui/message", { role: "user", content: [{ type: "text", text: message }] }).then(function (result) {
      if (result && result.isError) { throw new Error("host rejected"); }
      setStatus("已把修改指令发回 ChatGPT。");
    }).catch(function () {
      var openai = typeof window.openai !== "undefined" ? window.openai : null;
      if (openai && typeof openai.sendFollowUpMessage === "function") {
        try { openai.sendFollowUpMessage({ prompt: message }); setStatus("已把修改指令发回 ChatGPT。"); return; } catch (error) { /* fall through */ }
      }
      setStatus("无法发送修改指令，请直接在对话中描述修改。");
    });
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.id !== undefined && pending[message.id]) {
      var entry = pending[message.id];
      delete pending[message.id];
      if (message.error) entry.reject(message.error);
      else entry.resolve(message.result);
      return;
    }
    if (message.method === "ui/notifications/tool-result") renderFromResult(message.params);
  }, { passive: true });

  document.getElementById("download").addEventListener("click", downloadPng);
  document.getElementById("edit-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var input = document.getElementById("edit-input");
    var text = input && typeof input.value === "string" ? input.value.trim() : "";
    if (!text) return;
    sendEdit(text);
    if (input) input.value = "";
  });

  var openai = typeof window.openai !== "undefined" ? window.openai : null;
  if (openai && openai.toolOutput) renderFromResult({ structuredContent: openai.toolOutput, _meta:openai.toolResponseMetadata });
  window.addEventListener("openai:set_globals", function(event){var g=event.detail && event.detail.globals;if(g && g.toolOutput)renderFromResult({structuredContent:g.toolOutput,_meta:g.toolResponseMetadata});});

  post("ui/initialize", {
    appInfo: { name: "imstage-render-widget", version: "0.1.0" },
    appCapabilities: { availableDisplayModes: ["inline"] },
    protocolVersion: "2026-01-26"
  }).then(function (result) {
    hostCapabilities = result && result.hostCapabilities || {};
    notify("ui/notifications/initialized", {});
    if(window.ResizeObserver)new ResizeObserver(function(){notify("ui/notifications/size-changed",{height:document.documentElement.scrollHeight});}).observe(document.body);
  }).catch(function () { /* legacy host without the MCP Apps bridge */ });
})();
</script>
</body>
</html>
`;
}

export function buildWidgetResourceContent(uri = WIDGET_RESOURCE_URI) {
  return {
    uri,
    mimeType: WIDGET_MIME_TYPE,
    text: buildRenderWidgetHtml(),
    _meta: {
      ui: {
        prefersBorder: true,
        csp: WIDGET_CSP,
      },
    },
  };
}
