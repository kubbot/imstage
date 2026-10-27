# Platform preview and MCP App experience

2026-10-23. Reviewed against `a35df47`. Full account/host acceptance remains open.

## Behavior

- Public Templates compares all ten styles through one shared `SceneView`, keeping people, dialogue and times fixed. Desktop shows the full selector; mobile places a horizontal strip adjacent to the preview. Arrow keys, Home and End select styles.
- Instagram, Xiaohongshu, X, Jike and Threads are labelled DM/conversation styles. They are synthetic chat previews, not posts, feeds or publishing APIs.
- Continue creates a new creator session with the exact selected scene. Failed draft preparation preserves selection and search, with feedback in the current language. Existing gallery/account template flows remain available.
- MCP App waits for the current PNG to load before reporting preview success or enabling download. Failed/superseded images cannot enable downloads; image completion cannot replace a later edit's waiting status. Long images open width-fit in a bounded keyboard-scrollable region, with full-composition/original views available.
- Ephemeral previews offer downloads after loading and hide saved-work editing actions when no scene ID exists.
- Standard MCP Apps themes override stale legacy globals. The widget uses resource URI v3; v1/v2 remain readable for saved chats.
- MCP model inputs cannot change the user-controlled watermark switch through scenes, patches, project defaults, scenarios, templates or batch items. Stored user choices survive unrelated edits and trusted reuse. Web settings and custom watermark text remain supported.

## Verification

- `npm run build` and `npm run build:mcp`: passed.
- Affected MCP/widget/project integration run: 88/89 passed initially. One old dialogue fixture echoed a readable user preference into model input; after omitting it, its targeted rerun passed. No production rule was relaxed.
- Frontend/marketing browser regressions: 43/43 passed. Platform explorer: 4/4 passed after fixing excessive mobile intro spacing; the preview-position assertion was retained.
- Final widget protocol suite: 12/12 passed after synchronizing keyboard-scroll observation; the first CI run had 709/710, with that timing assertion as its only failure. Latest-head CI remains the release gate.
- Independent final source review: no P0/P1; confirmed locale P2 fixed.
- Main-agent browser: 1440x1000 desktop, 390x844 mobile, English/dark, Instagram handoff preserving four messages and selected style. Actual Web PNG export succeeded at 1206x2622.
- Browser protocol tests use a local parent/iframe bridge. They cover load/error races, download payloads, same-scene follow-up, theme precedence and a genuine 390x10000 PNG. This is not real ChatGPT host acceptance.

UI regression and exact-head CI results are recorded with the PR. Earlier broad worker results are not used as proof for the final combined change.

## Live boundaries

- Existing independent MCP returned real synthetic WeChat/WhatsApp PNGs, 390x844. This runtime uses v2; those results do not prove v3 deployment or real-host App controls.
- Local deterministic rendering of 24 synthetic messages passed at 390x2808; the main agent inspected that real PNG in the v3 local bridge and verified keyboard scrolling. The bridge acknowledged the download payload, but no native download event was observed; real-host download acceptance is still open.
- A later 24-message long-image call failed with `render_failed` / Chromium `page.setContent` timeout. The live long-image path is not accepted.
- Public static frontend was reachable; account API returned upstream non-application HTML. Backend TLS validation and SSH identity verification blocked administration. No trust bypass, routing replacement or shared-service restart was performed.
- Account MCP requires reauthentication. Independent connection imported enums are older than runtime capabilities. Trusted backend recovery, client refresh and real-host edit/download checks remain required.

## Evidence

Images in `evidence/platform-mcp-experience/` contain only synthetic content. `parent-*` are main-agent browser observations; `web-export-instagram.png` is the actual export, SHA-256 `9f7c25b496432ce2b5db964dc7f09af8949a3a9609b643723eb3c1e7b0d93061`. `live-mcp-wechat.png` and `live-mcp-whatsapp.png` are actual outputs from the existing independent runtime. Blank layout-test fixtures are excluded.
