# Renderer

`packages/renderer` is the single deterministic rendering path for the shared
conversation contract. It is deliberately framework-neutral: pure JavaScript,
no `node:` imports and no DOM access.

## API

```js
import { renderSceneHtml, RENDERER_VERSION } from '../../packages/renderer/index.mjs';

const html = renderSceneHtml(scene, {
  surface: 'ios',            // ios | android | desktop | web
  width: 390,                // viewport width in CSS pixels
  outputKind: 'screenshot',  // screenshot | long-screenshot
  assets: [{ mime: 'image/png', dataBase64: '...' }], // indexed by message.assetIndex
});
```

`renderSceneHtml` returns a complete HTML document string.

- **Pure & deterministic** — no randomness, timers, network, filesystem or
  `Date.now`. Identical inputs produce identical bytes.
- **Safe** — every scene string is HTML-escaped; uploaded images are embedded
  as `data:image/...;base64,...` URIs. No `<script>`, no inline handlers and no
  remote URLs are ever emitted. Scene fields that look like HTML/JS are rejected
  by `packages/schema/conversation.mjs` before rendering.
- **Real templates** — WeChat, Telegram and WhatsApp have distinct header,
  background, bubble colors, sender alignment, name labels, status bar and
  system-message styling. Device surfaces add iOS/Android status bars or
  desktop/web window chrome.
- **Escaped image captions and text** — image messages render the uploaded
  image plus an escaped caption; missing assets degrade to a `[图片]` placeholder.

## Screenshotting

The browser screenshotter is intentionally kept out of this package and lives
in `tools/eval/src/render.mjs`. It loads this HTML, aborts every non-`data:`
network request, and returns a validated PNG. Keeping the renderer pure lets the
Eval harness, the future Web app and future MCP/API adapters share one scene
contract without sharing a browser lifecycle.

The legacy website renderer in `tools/eval/public/` is **not** wired to this
module yet; migrating it is future work and must not fork the scene contract.
