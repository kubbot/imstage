# Templates, project variants, custom layout and MCP batch — acceptance

Date: 2026-09-23. Scope: the delegated slice for reusable templates, Projects
variants, declarative custom layout and MCP project/template/batch tools, based
on the frozen worktree baseline `5a90d11`. This file records what was actually
implemented and verified locally; it is not a claim about deployment, live
provider acceptance or the parent's homepage/marketing work.

## Delivered

### Shared contracts (preserved from phase 1, extended compatibly)
- `packages/schema/templates.ts` and `packages/schema/layout.ts` are reused as
  the single pure contracts. Only a type-narrowing cast was added to
  `templates.ts` so TypeScript can check the module when imported from the Web
  app; behaviour is unchanged.
- `Scene.layout?: CustomLayout` is now part of the canonical `Scene` and is
  validated by `validateScene` through `validateCustomLayout`.

### Account template API
- `GET/POST /api/templates`, `GET/PUT/DELETE /api/templates/:id`,
  `POST /api/templates/:id/instantiate`.
- Additive `template_records` table installed at database open; no migration
  rewrites or deletions.
- Owner scope, 50-template quota, optimistic revisions, lightweight list
  summaries, 404 for foreign/malformed ids, no scene writes on instantiate,
  deleting a template keeps created scenes.
- `TemplateError` is mapped to HTTP error payloads in `sendError`.

### Web template library
- `#/templates` shows the account library when signed in and keeps the public
  marketing gallery when signed out (no extra provider calls).
- Create from a saved editable scene with explicit name/description and an
  opt-in, relabellable discovered-variable list.
- Reuse opens a genuinely new creator session through the existing landing
  handoff; normal autosave persists the instance.
- Rename/delete dialogs, empty/error states, bilingual copy.
- Screenshot → template starter: upload → explicit reconstruct / preserve
  choice → the existing Agent workspace receives the image plus the bounded
  intent; results can be saved as a template. Reconstruct hints at
  `layout.kind=custom` for non-platform sources; preserve uses
  `Scene.reference` and states that only explicit regions are replaced.
- Compact creation examples (support, event, onboarding, narrative/photo,
  evaluation) open real creator sessions.
- "Save as template" action in the creator toolbar captures the current frame.

### Projects: structured variants and frozen templates
- `variants` input (≤10 × platforms ≤20) with `{name, prompt, values}` and
  optional `templateId` / `templateRevision`; mixing with `prompts` /
  `promptsText` is an explicit error.
- Values are validated against the frozen template before any job row is
  written; values without a templateId are rejected; template revision mismatch
  is a 409.
- The job transaction freezes rules, template snapshot/revision and per-item
  values; later template deletion or project edits cannot change queued work.
- The serial worker instantiates the frozen template (or a blank scene) per
  task, applies item differences through the same Agent runtime and publishing
  path, and keeps sequential/limiter/cancel/restart semantics.
- UI: prompt-list/variants mode toggle, template selector, one row per variant
  with name/prompt/typed value fields, per-task name plus differences.

### Declarative custom layout
- `SceneView` renders neutral header/composer under `data-layout="custom"` using
  bounded tokens only, through the same renderer and export path; absent layout
  leaves existing skins untouched.
- Inspector control group to create/reset and edit the useful tokens.
- Agent `update_element`/`create_scene` accept and validate `layout`; the model
  context includes it and targeted `@scene` edits may change it.
- MCP scene schema/bounds/patch/capabilities preserve `layout` and reject
  unsafe values via the shared validator.

### MCP projects, templates and batch
- Instance-scoped `mcp_projects`, `mcp_batches`, `mcp_batch_items` tables plus
  the reused owner-scoped template store under the constant `mcp-instance`
  scope inside the isolated MCP database.
- Tools: create/list/get/update project, create/list/get/update template,
  create/get/list batch (16 tools total; existing scene/render tools
  unchanged).
- `imstage_create_batch` accepts full validated scenes or
  `templateId + typed values (+ optional patch)`, validates the whole request
  before writing, and writes all scenes, snapshots, item references and the
  receipt in one transaction. `clientIdempotencyKey` retries return the same
  receipt; changed payloads conflict.
- Capabilities document the deterministic-save vs real Web Agent distinction,
  the schemas, limits and error codes.

## Verification performed locally

- `npm run build` — TypeScript + Vite production build passes.
- `npm test` — 407 tests pass, 0 fail (baseline 391 plus new template API,
  layout contract, project-variant and MCP batch tests; `pretest` rebuilds the
  MCP renderer).
- `env IMSTAGE_TEST_PORT=4452 IMSTAGE_ARTIFACT_DIR=/private/tmp/ai-test-imstage-creator-flow.nweHc3/pi-templates npx playwright test tests/ui/templates.spec.ts tests/ui/projects.spec.ts`
  — 7 passed, including account template create/reuse/rename/delete, the
  screenshot starter, bilingual English library, structured variants with a
  frozen template, and custom layout creation/edit/reload/reset.
- New Node coverage specifically asserts:
  - foreign-account template access denied, revision conflicts, list/detail
    separation, source snapshot immutability, hostile keys and oversize/type
    mismatches rejected, delete keeps created scenes;
  - ambiguous legacy/new batch input rejected, values without template rejected,
    stale template revision rejected, template deletion after enqueue does not
    change produced output;
  - layout tokens validated across model/Agent/MCP/renderer, with unsafe values
    rejected and platform chrome absent in custom mode;
  - MCP batch atomic validation (no rows written on failure), idempotent retry,
    idempotency conflict, quotas and unchanged existing scene tools.

## Remaining limits / not claimed

- Live provider acceptance (DeepSeek/image service) was not run; mock providers
  are used in tests, as required by the task.
- Screenshot reconstruction is an approximation; no pixel-perfect claim.
- MCP still rejects `Scene.reference`; screenshot edit layers remain Web-only.
- The parent owns homepage/marketing integration, final independent review,
  commits, deployment and production readback; those are not claimed here.
- `tests/ui/projects.spec.ts` and `tests/ui/templates.spec.ts` were updated/
  added because the baseline project test still expected the removed manual
  "保存作品" button; the autosave behavior is now asserted instead.

## Independent review fixes (2026-09-23)

All nine review findings were addressed in the frozen worktree; no parent-owned
file was touched.

1. `TemplatesPage` async actions (`create`, `use`, `rename`, `remove`,
   `readScreenshot`, both loaders) now capture owner + epoch and re-check
   mounted/owner before any state, `sessionStorage` handoff or navigation side
   effect. A delayed instantiate response after account change is discarded.
2. `SceneView` uses `layout.background` for the chat background when no explicit
   scene background exists, so the declarative token actually renders.
3. `handleBatchCreate` resolves the bounded `clientBatchId` idempotent job
   before current-template/new-job validation; same-key retries recover the
   frozen job after the template is updated or deleted.
4. Screenshot-reference templates reject any platform other than
   `reference.plan.im` before enqueue (`reference_platform_mismatch`), the
   worker no longer overrides the source platform, and the Projects UI pins the
   source platform, shows a bilingual note and maps the code to localized text.
5. MCP `imstage_create_batch` re-runs `enforceSceneBounds` on every final
   template instance before the atomic write, so shared-contract values that
   exceed MCP limits (name 60, text 2000, asset count) fail with no partial rows.
6. The screenshot seed is read without consuming it; `clearTemplateScreenshot`
   removes only the exact payload after `writeSession` succeeds. A failed
   IndexedDB write or an undecodable preserve source keeps the upload and shows
   a localized error instead of creating an empty scene.
7. `account/api.ts` localizes network/timeout/unavailable/server-code errors
   from the current document locale, keeps Chinese validation detail for `zh`,
   falls back to stable English for untranslated Chinese messages, and
   `safeNext` now accepts `/templates`. `AuthPage` uses copy for the
   registration-uncertain message.
8. MCP `imstage_update_project` preserves omitted rules/defaults on a
   rename-only patch and clears them only when explicitly provided.
9. `stableStringify` builds a null-prototype map so an own `__proto__` key is
   preserved; changed batch payloads can no longer hash like an earlier valid
   one.

### Verification after the fixes

- `npm run build` — passes.
- `npm test` — 417 tests pass, 0 fail.
- `env IMSTAGE_TEST_PORT=4452 IMSTAGE_ARTIFACT_DIR=/private/tmp/ai-test-imstage-creator-flow.nweHc3/pi-templates npx playwright test tests/ui/templates.spec.ts tests/ui/projects.spec.ts`
  — 11 passed, including stale-owner handoff, failed-write seed retention,
  decode-failure retention, one-shot success cleanup, computed custom-layout
  background and the reference-platform rejection flow.
