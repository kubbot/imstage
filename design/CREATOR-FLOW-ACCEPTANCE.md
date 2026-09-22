# Creator flow acceptance

Scope: the September 23 creator experience request. This is an acceptance checklist, not a claim that every item has shipped. Current implementation and verification receipts must be recorded against the delivered commit.

## Entry and continuity

- Explicit homepage Send creates a new, blank session and carries the exact submitted prompt as a bounded durable intent.
- Sign-in retains that session and intent. Only a staged intent starts automatically; persist `running` before dispatch. Reloading an uncertain run requires explicit retry.
- Browsing examples, scrolling, opening an editable example and opening a template never trigger a provider request.
- Ordinary edits persist locally and automatically synchronize a signed-in user's Scene. Do not create cloud records merely by browsing an empty workspace.
- A newer cloud revision, deleted remote scene, account switch, offline response or unmount must not silently overwrite another draft or account.
- People names and uploaded/generated avatars use the same serialized autosave queue. Pending changes survive reload; failure/conflict remains visible and recoverable.

## Creation surface

- Useful controls, validation, statuses, authentication, project and scene navigation match the selected Chinese or English locale.
- Compact typography and a focused composer replace decorative headings and explanatory filler.
- Mobile controls remain reachable; export and preview share the same Scene renderer.
- Creation examples cover customer support, onboarding, event coordination, narrative photography and evaluation data.

## Templates and projects

- A template freezes an editable Scene and a chosen set of typed variables. Reuse creates independent sessions; ordinary autosave does not change the template.
- Screenshot workflows expose the existing reconstruction and source-preserving region-edit modes truthfully. Custom declarative layouts extend the renderer beyond named app skins.
- Web Project jobs freeze shared rules, template revision and per-item values. Each task produces an independent scene through the existing Agent runtime.
- MCP exposes instance-scoped templates, projects and deterministic batch scene creation. Its authenticated instance store remains separate from Web user accounts. The calling AI provides generated content; the MCP save operation does not pretend to invoke a model.
- Invalid items fail before any batch write; idempotency, bounded quotas, cancellation and ownership are verified.

## Delivery gates

Build and relevant unit/API/MCP tests; real browser Chinese/English, responsive and reduced-motion checks; independent review; production readback of the deployed frontend/backend revision and changed flows; exact-head CI before merge. A blocked external check must be reported rather than bypassed or described as passed.

## First implementation checkpoint

- Homepage uses a scroll-directed live Scene with direct message edits and three independently configured variations. Eight authored examples, image zoom and real PNG export remain usable without an Agent request. Desktop/mobile/reduced-motion tests cover the interaction.
- Pi CLI implemented the bilingual workspace, send-intent lifecycle and shared autosave integration. Parent review corrected contact queue races, per-tab durable caching and cache failure navigation protection.
- Independent code review closed the confirmed intent, account queue, contact revision and navigation findings. Node/API/MCP baseline: 391 tests passed. Focused browser run: 37 passed initially with one obsolete export selector; corrected selector and the 12-test contacts/creation rerun passed. Seven new Send/asset tests cover mocked provider behavior; live provider acceptance remains a deployment gate.
- Shared template/layout validators and owner-scoped SQLite template storage pass 13 focused tests. Template UI, transports, custom layout renderer and project batch wiring are the next implementation slice; the pure contracts alone do not deliver these features.
