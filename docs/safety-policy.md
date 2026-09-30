# IMStage safety & positioning policy (2026-09-30)

This document records the implementation of the 2026-09-30 user-authorized
safety + positioning change. It supersedes conflicting historical plans in
`docs/product-brief.md` and `design/BRIEF.md`. The machine-readable single
source of truth is `packages/schema/policy.mjs` (`POLICY_VERSION`).

## 1. Mandatory disclosure

- Every hosted preview and **every** PNG export (studio export, Agent export,
  marketing export, crops, MCP renders and widgets) shows
  `AI生成 / 虚构 · AI-generated / Fictional`.
- The label is drawn by the renderer (`apps/web/src/studio/SceneView.tsx`,
  `packages/renderer/renderSceneHtml.mjs`), never stored in scene data, so it
  cannot be turned off through the UI, the Agent, an import or the API.
- `validateScene` strips disclosure-override fields (`showFictionalMark`,
  `hideDisclosure`, `disclosure`, …) on import; `PUT /api/preferences` rejects
  `showFictionalMark: false`; `update_element` cannot patch `watermark`.

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

## 4. Generic IMStage chat UI

- All platform identifiers render one generic IMStage skin (`data-skin
  "imstage-generic"`); legacy schema ids survive only for migration. No
  messaging-platform names, logos or interface clones appear in public output.

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
  server, so **no server audit record exists for them**. The mandatory label is
  the client-side guarantee for those flows.

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
