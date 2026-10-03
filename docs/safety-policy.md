# IMStage safety & positioning policy

This document records the safety + positioning rules of the product. The
2026-09-30 change established them; the 2026-10-02 user decision then made the
disclosure a **user watermark switch** (default on) and restored the platform
template skins. The machine-readable single source of truth is
`packages/schema/policy.mjs` (`POLICY_VERSION`).

## 1. Watermark / disclosure (default on)

- Every preview and **every** PNG export (studio export, Agent export, marketing
  export, crops, MCP renders and widgets) shows
  `AI生成 / 虚构 · AI-generated / Fictional` **by default**.
- Since 2026-10-02 the user chooses: `Project.watermarkEnabled` (default `true`
  for new and legacy projects) seeds new scenes, and
  `Scene.watermarkEnabled?:boolean` (absent = on) suppresses the disclosure
  **and** any custom `watermark` text in both the React and the deterministic
  HTML/PNG renderers when `false`. `Scene.watermark` text is retained for
  compatibility. Turning the watermark off never rewrites existing scenes.
- The switch is a *user* preference: `create_scene` preserves the context
  scene's flag, `update_element` rejects it, and obsolete toggle aliases
  (`showFictionalMark`, `hideDisclosure`, `disclosure`, …) are still stripped on
  import by `validateScene` / `stripDisclosureOverrides`.
- The label is drawn by the renderer (`apps/web/src/studio/SceneView.tsx`,
  `packages/renderer/renderSceneHtml.mjs`), never stored in scene data.

## 2. Payment capabilities removed

- `transfer` and legacy spellings (red packet / balance / wallet / …) are not
  valid message types anywhere (Web UI, Agent tools, MCP schemas).
- Imported or legacy scenes are **neutralised**: the message stays (id, order,
  timestamp preserved) but renders as a plain system notice. Stored work is
  never erased.

## 3. Real-screenshot editing disabled

- The public upload/reference entry points were removed (template screenshot
  seed, `ReferenceView` / `ReferenceInspector`, Agent "keep screenshot" mode).
- `validateScene` rejects any `reference` document, which blocks the API scene
  endpoints, template endpoints, batch enqueue and both MCP servers (all funnel
  through the shared validator). `/api/agent/render` returns
  `reference_disabled`.
- The Agent runtime (`services/agent/index.mjs`) throws `reference_disabled`
  unless `internalReferenceResearch: true` is passed by code — only
  `tools/eval` (internal offline evaluation) sets it. `extract_image` is
  internal-only.

## 4. Platform template skins

- Each supported chat platform renders its own template chrome (bubbles,
  avatars, composer): IMStage generic plus WeChat, WhatsApp, iMessage,
  Instagram, Xiaohongshu and Slack — chosen per project/scene and shown as
  selectable preview cards. They are approximate *style previews* for synthetic
  content: no brand logos and no pixel-level interface clones.
- The deterministic renderer (`packages/renderer/renderSceneHtml.mjs`) mirrors
  the same per-platform differences, and manual appearance overrides
  (`appearance.fontSize/color/background/radius/spacing`) win over template
  defaults on every surface.

## 5. Terms, privacy and the generation audit

- Bilingual terms / privacy pages (`#/terms`, `#/privacy`) are linked from the
  footer and summarized with a required checkbox at registration. Prohibited:
  fabricated evidence, fraud, defamation, impersonation, misleading use.
- `services/audit/generation-audit.mjs` persists one row per **hosted**
  generation (web Agent runs, project batch tasks, portrait generation,
  AI-supplied content saved through `/api/mcp` and `/mcp`):

  | column | meaning |
  | --- | --- |
  | run_id | `run_<uuid>` |
  | created_at / created_ms | ISO time and epoch ms |
  | account_id | account id, or the MCP instance token label (never raw tokens) |
  | flow | `agent` / `batch` / `portrait` / `mcp_scene` / `mcp_batch` / `account_mcp` / `render` |
  | status | `running` / `ok` / `partial` / `error` / `aborted` |
  | policy_version | `packages/schema/policy.mjs#POLICY_VERSION` |
  | scene_hash | SHA-256 of canonical scene JSON or rendered PNG (or null) |
  | error_code | bounded error code (or null) |

  This audit table stores no raw prompts, screenshots, image bytes or tokens. Operational account/project data is stored separately.
- **Retention:** rows older than 90 days are deleted by the real cleanup job
  (`cleanupGenerationAudit`, run at server start and every 6 hours). Operational backups retain 14 versions separately.
- **Precise limitation:** anonymous local editing and PNG export never reach a
  server, so **no server audit record exists for them**. The default-on watermark
  is the client-side guarantee for those flows.

## 6. License & commercial use

- Current license: source-available non-commercial (`LICENSE`), testing /
  learning / research only, clearly **not** OSI open source. Earlier releases
  keep their MIT terms (`LICENSE-MIT-LEGACY`); no retroactive revocation.
- Separate closed-source dataset / evaluation services is an
  email enquiry only, driven by `VITE_BUSINESS_EMAIL` (`apps/web/src/config.ts`);
  until a verified address exists every surface shows an honest
  "not published yet" state.

## Regression tests

`tests/template-screenshot-seed.test.mjs`, `tests/source-image.test.mjs`,
`tests/mcp-widget.test.mjs`, `tests/creator-defaults-agent.test.mjs`,
`tests/preferences.test.mjs` and `tests/policy-safety.test.mjs` /
`tests/policy-audit.test.mjs` cover the bypass/import/export rules and the
durable audit + expiry behaviour.
