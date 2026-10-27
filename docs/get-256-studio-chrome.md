# GET-256 — Studio chrome and template isolation

The Studio gives the rendered artwork most of the desktop workspace. A new browser starts with a 360 px creation panel, while a saved 360–640 px preference survives reload. Dragging, keyboard resizing, widening and reset remain available. At 1280 px, the default render area measures 915 px and the toolbar occupies one 54 px row. Narrow screens retain the chat/preview switch and visible export actions.

Studio controls use a scoped, neutral dark palette. The surrounding website keeps its light/dark/system selection. SceneView retains its own platform colours, typography, watermark preference and device pixel dimensions. The Jike adapter's registered `#f7f8fa` background now reaches both the React view and the generated deterministic renderer, instead of falling back to the generic blue-grey background. Custom-layout backgrounds still take precedence.

## Verification

Latest local run: 710 host tests and 55 affected browser tests passed; production build and generated-renderer check passed. Independent read-only review found no confirmed P0/P1/P2.

Local verification uses the production Vite build, synthetic scenes and an isolated local API/database. No model request, real conversation, native simulator or external account is needed.

- `npm run build` and `npm run check:renderer` validate the browser build and reproducible generated renderer.
- `tests/ui/creation-layout.spec.ts` covers panel defaults, mouse/keyboard resizing, saved widths, properties, composer reachability, accessibility, error/retry at desktop/tablet/mobile sizes.
- `tests/ui/studio-chrome.spec.ts` measures 1280 px hierarchy, preserves a previously saved 480 px preference, checks 390 px layout, toolbar text enlarged to 200%, reduced motion, draft recovery and empty-state export availability.
- The three WeChat/Xiaohongshu/Jike templates produce actual downloaded 1179×2556 PNGs from the iPhone 15 Pro preset. Decoded PNG pixels are identical across light/dark/system site themes for each platform. The default fictional-content disclosure is checked in the downloaded files.
- Independent deterministic-HTML checks cover social backgrounds and custom-layout precedence. Existing social, WhatsApp, visible crop/touch and element-editor regressions cover the shared renderer and editing/export paths.

Browser plugin was unavailable; tests use the existing Playwright workflow with one Chromium worker. Local screenshots/downloads/logs are retained with the task evidence. Test runs are evidence of these behaviors, not a human score for photographic realism.

## Remaining acceptance and release boundary

The requested remote delivery consists of code, review and a pull request. Production publication and Linear completion remain separate. The earlier Vercel authorization failure is not reinterpreted as a successful release; no manual deployment or paid evaluation is part of this update.

No version-specific source screenshots were attached to this issue. The official [WeChat](https://apps.apple.com/us/app/wechat/id414478124), [Jike](https://apps.apple.com/cn/app/id966129812) and [Xiaohongshu](https://apps.apple.com/cn/app/id741292507) listings identify the reference platforms, but do not provide a measured chat-layout gold standard here. Existing platform metrics are preserved, except for the registered Jike background fix. A claim of exact platform-version pixel equivalence or successful human quick-glance comparison remains unverified. Full-browser zoom, native app/device testing and live backend/MCP acceptance are also not claimed by the toolbar-only enlargement check or local fixtures.
