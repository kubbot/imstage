# Creator flow acceptance — 2026-09-23

This release connects the public website, creation sessions, automatic persistence,
reusable templates and project variations. The website uses the real renderer:
scrolling moves from a scene to direct editing and then distinct people/photos.
Chinese examples use WeChat and English examples use WhatsApp. The GitHub action
is an accessible icon link. Opening an example does not invoke a provider.

## Behavior verified

- Homepage Send preserves the exact instruction through authentication, creates a
  separate session and dispatches once. Reloading does not replay a consumed or
  failed intent. Failed local persistence blocks dispatch and keeps the input.
- The compact workspace, examples, people, templates, project forms and errors
  follow the selected language. Scene, person/avatar and project edits save
  automatically, with local recovery and explicit conflict/error status.
- Project writes are serialized while fields stay editable. Tests cover offline
  retry, reload, deleted projects, stale GETs, account changes, normalization and
  lost acknowledgements. In the last case, edits made during both PUT and the
  reconciliation GET survive and use the acknowledged revision. Batches cannot
  start while project settings are unsynchronized.
- Templates expose typed text/image variables and create independent scenes.
  Selection races cannot use the previous template or source scene. Screenshot
  starters retain their input if decoding or session persistence fails.
- Screenshot reconstruction and source-preserving edit regions remain distinct.
  Custom layouts share the preview/export renderer and can be adjusted by Agent.
  Reconstruction is approximate; this does not certify pixel-perfect fidelity.
- Web project jobs freeze rules/template/variable values. Retrying an existing
  client key recovers the original job even if its template was deleted.
- MCP exposes 16 authenticated tools. Project/template/batch tools use the MCP
  instance database, atomically save content supplied by the calling AI and
  preserve idempotency. MCP does not run the hosted Agent or share Web accounts.

## Verification boundaries

The integrated Node/API/MCP suite passed 417 tests; the evaluation tooling passed
193 tests, its positive/negative controls and its browser note workflow. These
local checks do not replace GitHub's cross-platform CI or the separate screenshot
fidelity evaluation documented in `agent-project-acceptance.md`.

Desktop and mobile screenshots were inspected in both languages. Template pages
at 1440, 390 and 320 pixels had no horizontal overflow and no automated WCAG A/AA
violations. Automated accessibility checks are not a complete accessibility audit.
Independent reviews closed the identified ownership, persistence and batch
validation findings before delivery.

The final integrated Playwright run passed **155/155** browser tests against the
production build, including the concurrent lost-ack regression. TypeScript and
the Vite production build passed. Private account data and raw logs remain outside Git.

Production receipts will be appended after live acceptance.
