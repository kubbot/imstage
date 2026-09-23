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

// Resource URIs are host cache keys; keep the old address readable for saved chats.
export const LEGACY_WIDGET_RESOURCE_URI = 'ui://imstage/render-scene.html';
export const WIDGET_RESOURCE_URI = 'ui://imstage/render-scene-v2.html';
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
  :root { color-scheme: light dark; --ink:var(--color-text-primary,#242323); --muted:var(--color-text-secondary,#73716d); --surface:var(--color-background-primary,#fff); --line:var(--color-border-primary,#e5e3df); }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif; color:var(--ink); background:transparent; }
  .card { max-width:900px; margin:auto; padding:16px; display:grid; gap:14px; }
  h1 { margin:0; font-size:17px; font-weight:600; overflow-wrap:anywhere; }
  .meta,.status,.hint { margin:0; color:var(--muted); font-size:12px; }
  .heading { display:flex; justify-content:space-between; gap:12px; align-items:baseline; }
  .preview { display:flex; justify-content:center; align-items:flex-start; border-radius:10px; background:var(--color-background-secondary,#f6f5f2); padding:12px; }
  .preview img { display:block; width:auto; height:auto; max-width:100%; max-height:480px; object-fit:contain; }
  .preview[data-fit="width"] img { width:auto; max-width:100%; max-height:none; }
  .preview[data-fit="original"] { overflow:auto; max-height:80vh; justify-content:flex-start; }
  .preview[data-fit="original"] img { max-width:none; max-height:none; }
  .toolbar,.view-options,.row,.shortcuts { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
  button,summary,a.action { min-height:40px; padding:8px 12px; font:inherit; font-size:13px; border:1px solid var(--line); border-radius:7px; color:inherit; background:var(--surface); cursor:pointer; text-decoration:none; }
  .primary { background:var(--ink); color:var(--surface); border-color:var(--ink); }
  button:disabled { opacity:.5; cursor:default; }
  button:hover:not(:disabled),summary:hover { filter:brightness(.96); }
  :focus-visible { outline:2px solid var(--ink); outline-offset:3px; }
  .toolbar { position:relative; }
  details.more { position:static; }
  details.more summary { list-style:none; }
  details.more summary::-webkit-details-marker { display:none; }
  .more-content { position:absolute; right:0; top:46px; z-index:2; width:min(300px,75vw); padding:14px; background:var(--surface); border:1px solid var(--line); border-radius:8px; box-shadow:0 8px 24px #0001; }
  .more-content h2 { font-size:13px; margin:0 0 8px; }
  .more-content p { overflow-wrap:anywhere; }
  .more-content .action { display:block; margin-top:12px; }
  .view-options { justify-content:center; }
  .view-options button,.shortcuts button { min-height:32px; border:0; padding:5px 9px; color:var(--muted); background:transparent; font-size:12px; }
  .view-options button[aria-pressed="true"] { background:var(--color-background-secondary,#f0eeea); color:var(--ink); }
  form { display:grid; gap:8px; }
  label { font-size:13px; font-weight:500; }
  .row { flex-wrap:nowrap; align-items:stretch; }
  input { min-width:0; flex:1; font:inherit; padding:10px 12px; border:1px solid var(--line); border-radius:7px; background:var(--surface); color:inherit; }
  .status { min-height:18px; }
  [hidden] { display:none!important; }
  @media(max-width:420px) { .card{padding:12px;gap:12px}.heading{display:block}.toolbar button,.toolbar summary,.toolbar a.action{min-height:44px}.preview{padding:8px}.preview img{max-height:420px} }
  @media(prefers-color-scheme:dark) { :root { --ink:var(--color-text-primary,#eee);--muted:var(--color-text-secondary,#aaa);--surface:var(--color-background-primary,#202020);--line:var(--color-border-primary,#414141); }.preview{background:var(--color-background-secondary,#292929)}.view-options button[aria-pressed="true"]{background:var(--color-background-secondary,#333)} }
</style>
</head>
<body>
<main class="card">
  <header class="heading"><h1 id="scene-title">你的对话作品</h1><p class="meta" id="save-state" role="status">等待作品…</p></header>
  <div class="preview" id="preview" data-fit="height" hidden><img id="preview-img" alt="完整对话作品预览" /></div>
  <p id="long-hint" class="hint" hidden>这是一张长图。当前显示完整构图，可选择适合宽度展开阅读。</p>
  <div class="view-options" id="view-options" aria-label="预览尺寸" hidden>
    <button type="button" data-fit="height" aria-pressed="true">适合高度</button><button type="button" data-fit="width" aria-pressed="false">适合宽度</button><button type="button" data-fit="original" aria-pressed="false">查看原图 / 放大</button>
  </div>
  <div class="toolbar" id="toolbar" hidden>
    <button id="edit-work" class="primary" type="button">编辑作品</button>
    <button id="download" type="button" hidden>下载 PNG</button>
    <details class="more"><summary>更多</summary><div class="more-content"><h2>作品信息</h2><p class="meta" id="scene-meta"></p><p class="hint">头像、样式与标记可在网页编辑器中调整。</p><a id="web-link" class="action" target="_blank" rel="noopener noreferrer" hidden>在网页中打开</a></div></details>
  </div>
  <form id="edit-form" hidden>
    <label for="edit-input">想改哪里？</label>
    <div class="row"><input id="edit-input" type="text" maxlength="500" autocomplete="off" placeholder="例如：把最后一句改得更轻松" /><button id="edit-submit" type="submit">发送修改</button></div>
    <div class="shortcuts"><button type="button" data-prompt="更换对方头像：">换头像</button><button type="button" data-prompt="调整对话时间为：">调整时间</button><button type="button" data-prompt="修改聊天样式为：">改样式</button></div>
  </form>
  <p class="status" id="status" role="status" aria-live="polite"></p>
</main>
<script>
(function () {
  "use strict";
  var pending = Object.create(null);
  var nextId = 1;
  var hostCapabilities = {};
  var latest = { sceneId: null, revision: null, renderId: null, downloadUri: null, dataUri: null, title: null, webUrl: null };
  var resultEpoch = 0;
  var editing = false;
  var editTimer = null;
  var bridgeReady = false;
  var lastResultKey = null;

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
    if (el && typeof value === "string") el.textContent = value;
  }

  function renderFromResult(result) {
    if (!result || typeof result !== "object") return;
    var structured = result.structuredContent && typeof result.structuredContent === "object" ? result.structuredContent : {};
    var meta = result._meta && typeof result._meta === "object" ? result._meta : {};
    var preview = meta.preview && typeof meta.preview === "object" ? meta.preview : {};

    var dataUri = typeof preview.dataUri === "string" ? preview.dataUri : null;
    if (!dataUri && Array.isArray(result.content)) {
      for (var i = 0; i < result.content.length; i += 1) {
        var block = result.content[i];
        if (block && block.type === "image" && typeof block.data === "string") {
          var mime = typeof block.mimeType === "string" ? block.mimeType : "image/png";
          if (mime !== "image/png") continue;
          dataUri = "data:" + mime + ";base64," + block.data;
          break;
        }
      }
    }
    if (dataUri && !/^data:image\\/(png);base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUri)) dataUri = null;

    var resultKey = JSON.stringify([Boolean(result.isError), structured.sceneId, structured.revision, structured.renderId, structured.title, structured.width, structured.height, structured.webUrl, dataUri]);
    if (resultKey === lastResultKey) return;
    lastResultKey = resultKey;
    resultEpoch += 1;
    var wasEditing = editing;
    editing = false; clearTimeout(editTimer); document.getElementById("edit-submit").disabled = false;
    latest = { sceneId:null, revision:null, renderId:null, downloadUri:null, dataUri:null, title:null, webUrl:null };
    document.getElementById("preview").hidden = true;
    document.getElementById("preview-img").removeAttribute("src");
    document.getElementById("download").hidden = true;
    document.getElementById("download").disabled = false;
    document.getElementById("toolbar").hidden = true;
    document.getElementById("edit-form").hidden = true;
    document.getElementById("view-options").hidden = true;
    document.getElementById("long-hint").hidden = true;
    document.getElementById("web-link").hidden = true;
    document.getElementById("web-link").removeAttribute("href");
    setText("scene-title", "你的对话作品"); setText("scene-meta", "");
    if(result.isError){ setText("save-state","生成未完成"); setStatus("生成失败，请在对话中重试。上一版本不会作为新结果下载。"); return; }
    latest.sceneId = typeof structured.sceneId === "string" ? structured.sceneId : null;
    latest.revision = Number.isInteger(structured.revision) ? structured.revision : null;
    latest.renderId = typeof structured.renderId === "string" ? structured.renderId : null;
    latest.title = typeof structured.title === "string" ? structured.title : null;

    var downloadUri = typeof structured.downloadUri === "string" ? structured.downloadUri : null;
    if (!downloadUri && typeof preview.downloadUri === "string") downloadUri = preview.downloadUri;
    latest.downloadUri = downloadUri && /^imstage:\\/\\/renders\\/rnd_[0-9a-f]{32}\\.png$/.test(downloadUri) ? downloadUri : null;

    if (latest.title) setText("scene-title", latest.title);
    try {
      var web = new URL(structured.webUrl);
      if (web.protocol === "https:" && !web.username && !web.password && web.hash.startsWith("#/workspace?scene=")) latest.webUrl = web.href;
    } catch (_) { /* no account-owned web link */ }
    var link = document.getElementById("web-link");
    if (latest.webUrl) { link.href = latest.webUrl; link.hidden = false; }
    setText("save-state", latest.sceneId ? "作品已保存" : "预览已生成");
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
      document.getElementById("view-options").hidden = false;
      document.getElementById("long-hint").hidden = !(structured.height > structured.width * 3);
      setStatus(wasEditing ? "作品已更新。" : "");
    }
    document.getElementById("edit-form").hidden = !latest.sceneId;
    document.getElementById("toolbar").hidden = !latest.sceneId && !dataUri;
    if (!dataUri) { setText("save-state", "预览未就绪"); setStatus("未收到有效图片，请重新渲染作品。"); }
    var download = document.getElementById("download");
    if (download && latest.dataUri) download.hidden = false;
  }

  function setStatus(value) {
    var el = document.getElementById("status");
    if (el) el.textContent = value || "";
  }

  document.getElementById("preview-img").addEventListener("error",function(){
    latest.dataUri = null; document.getElementById("download").hidden = true;
    document.getElementById("preview").hidden = true;
    document.getElementById("view-options").hidden = true;
    setText("save-state","预览未就绪");setStatus("图片无法显示，请在对话中重新渲染。");
  });
  var exportedFiles = Object.create(null);
  async function downloadWithOpenAi(name, snapshot, epoch) {
    var api = window.openai;
    if (!api || typeof api.uploadFile !== "function" || typeof api.getFileDownloadUrl !== "function" || typeof api.openExternal !== "function") {
      setStatus("当前宿主不支持组件下载，请在对话中请求导出 PNG。"); return;
    }
    var button = document.getElementById("download");
    button.disabled = true;
    setStatus("正在准备 PNG…");
    try {
      var key = snapshot.dataUri;
      var fileId = exportedFiles[key];
      if (!fileId) {
        var raw = atob(snapshot.dataUri.split(",")[1]);
        var bytes = Uint8Array.from(raw, function(c) { return c.charCodeAt(0); });
        var uploaded = await api.uploadFile(new File([bytes], name, {type:"image/png"}));
        fileId = uploaded && uploaded.fileId;
        if (!fileId) throw new Error("missing file");
        exportedFiles[key] = fileId;
      }
      var download = await api.getFileDownloadUrl({fileId:fileId});
      var url = new URL(download.downloadUrl);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error("invalid download URL");
      if (epoch !== resultEpoch) return;
      await api.openExternal({href:url.href});
      if (epoch === resultEpoch) setStatus("已打开 PNG 下载链接。");
    } catch (error) { if (epoch === resultEpoch) setStatus("下载未完成，请重试或在对话中请求导出 PNG。"); }
    finally { if (epoch === resultEpoch) button.disabled = false; }
  }

  async function downloadPng() {
    if(!latest.dataUri) return;
    var snapshot = Object.assign({}, latest), epoch = resultEpoch;
    var name = "imstage-" + (snapshot.revision || "preview") + ".png";
    if(!hostCapabilities.downloadFile){await downloadWithOpenAi(name,snapshot,epoch);return;}
    var button = document.getElementById("download"); button.disabled = true; setStatus("正在准备 PNG…");
    try {
      var result = await post("ui/download-file", {contents:[{type:"resource",resource:{uri:"file:///"+name,mimeType:"image/png",blob:snapshot.dataUri.split(",")[1]}}]});
      if(result && result.isError) throw new Error("download rejected");
      if(epoch === resultEpoch) setStatus("宿主已接受 PNG 下载请求。");
    } catch (_) { if(epoch === resultEpoch) setStatus("下载未完成，请重试或在对话中请求导出 PNG。"); }
    finally { if (epoch === resultEpoch) button.disabled = false; }
  }

  async function openEditor() {
    if (!latest.webUrl) { document.getElementById("edit-input").focus(); return; }
    try {
      if (hostCapabilities.openLinks) {
        var result = await post("ui/open-link", { url:latest.webUrl });
        if (result && result.isError) throw new Error("rejected");
      } else if(window.openai && typeof window.openai.openExternal === "function") {
        await window.openai.openExternal({ href:latest.webUrl });
      } else {
        document.querySelector("details.more").open = true;
        document.getElementById("web-link").focus();
        setStatus("使用「在网页中打开」继续编辑。");
      }
    } catch (_) { document.querySelector("details.more").open = true; setStatus("未能打开网页，请使用「在网页中打开」重试。"); }
  }

  async function sendEdit(text) {
    if(editing || !latest.sceneId) return;
    var epoch = resultEpoch, input = document.getElementById("edit-input");
    var scenePart = "场景 " + latest.sceneId;
    var revisionPart = latest.revision !== null ? "（revision " + latest.revision + "）" : "";
    var message = "请修改 IMStage " + scenePart + revisionPart + "：" + text + "。保留未明确要求修改的头像和虚构标记设置。请调用 imstage_update_scene 后重新调用 imstage_render_scene。";
    editing = true; document.getElementById("edit-submit").disabled = true; setStatus("正在发送修改…");
    try {
      var api = window.openai;
      if (!bridgeReady && api && typeof api.sendFollowUpMessage === "function") await api.sendFollowUpMessage({prompt:message});
      else {
        var result = await post("ui/message", { role:"user", content:[{type:"text",text:message}] });
        if(result && result.isError) throw new Error("rejected");
      }
      if(epoch !== resultEpoch) return;
      if(input.value.trim() === text) input.value = "";
      setStatus("已把修改指令发回对话，等待作品更新…");
      editTimer = setTimeout(function(){
        if(epoch !== resultEpoch) return;
        editing = false; document.getElementById("edit-submit").disabled = false;
        setStatus("尚未收到新作品，请查看对话中的执行结果，再决定是否重试。");
      },45000);
    } catch (_) {
      if(epoch !== resultEpoch) return;
      editing = false; document.getElementById("edit-submit").disabled = false;
      setStatus("未确认发送成功，输入已保留。请查看对话后重试，或直接在对话中描述修改。");
    }
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
  document.getElementById("edit-work").addEventListener("click", openEditor);
  document.querySelectorAll("button[data-fit]").forEach(function(button){ button.addEventListener("click",function(){
    document.getElementById("preview").dataset.fit = button.dataset.fit;
    document.querySelectorAll("button[data-fit]").forEach(function(other){other.setAttribute("aria-pressed",String(other === button));});
  }); });
  document.querySelectorAll("button[data-prompt]").forEach(function(button){button.addEventListener("click",function(){
    var input = document.getElementById("edit-input"); input.value = button.dataset.prompt; input.focus();
  });});
  document.getElementById("edit-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var input = document.getElementById("edit-input");
    var text = input && typeof input.value === "string" ? input.value.trim() : "";
    if (!text) return;
    void sendEdit(text);
  });

  // ChatGPT Work can provide the complete result only in response metadata.
  // Globals updates are partial; retain the other fields from window.openai.
  function renderOpenAiGlobals(globals) {
    var current = typeof window.openai !== "undefined" ? window.openai : {};
    var g = globals || {};
    var meta = g.toolResponseMetadata || current.toolResponseMetadata || {};
    var nested = meta.call_tool_result;
    if (nested && typeof nested === "object") {
      renderFromResult({ content: nested.content, structuredContent: nested.structuredContent,
        isError: nested.isError, _meta: Object.assign({}, nested._meta || {}, meta) });
      return;
    }
    var output = g.toolOutput || current.toolOutput;
    if (output || meta.preview) renderFromResult({ structuredContent: output || {}, _meta: meta });
  }
  renderOpenAiGlobals();
  window.addEventListener("openai:set_globals", function(event) {
    var globals = event.detail && event.detail.globals;
    if (!globals || (!Object.prototype.hasOwnProperty.call(globals,"toolOutput") && !Object.prototype.hasOwnProperty.call(globals,"toolResponseMetadata"))) return;
    renderOpenAiGlobals(globals);
  });

  post("ui/initialize", {
    appInfo: { name: "imstage-render-widget", version: "0.1.0" },
    appCapabilities: { availableDisplayModes: ["inline"] },
    protocolVersion: "2026-01-26"
  }).then(function (result) {
    bridgeReady = true;
    hostCapabilities = result && result.hostCapabilities || {};
    notify("ui/notifications/initialized", {});

  }).catch(function () { /* legacy host without the MCP Apps bridge */ });
  if (window.ResizeObserver) new ResizeObserver(function() {
    var height = document.documentElement.scrollHeight;
    notify("ui/notifications/size-changed", {height:height});
    if (window.openai && typeof window.openai.notifyIntrinsicHeight === "function") window.openai.notifyIntrinsicHeight(height);
  }).observe(document.body);
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
