# Creation session management — 2026-09-21

The creation workbench now has a named current-session control and an always-visible new-session button above AI/element tabs. Opening the control shows recent sessions, search, rename, copy-current and delete with an explicit confirmation. The list supports keyboard focus, Escape, outside-click dismissal, and mobile/light/dark layouts.

Each session owns its scene, AI transcript, pending attachments, both input drafts, selected element/edit scope, project, screenshot mode and visible scroll position. Switching remounts the editor so model context, selected elements, errors and undo stacks cannot leak between sessions. New/switch actions wait for pending saves and are disabled during generation/export/image reads. An interrupted generation is labeled as interrupted on recovery.

A browser IndexedDB database atomically stores metadata and drafts, grouped by the signed-in account (or guest). Existing tab drafts migrate only after the durable write succeeds. Active-session pointers stay tab-local. Optimistic revisions prevent another tab from overwriting or resurrecting a stale session; a recovery-copy action preserves conflicting local edits. Storage failures retain editable in-memory content, show an error and block unsafe switching. Login handoff creates a separate account session without replacing an existing account conversation.

Account work IDs remain stable for a creation session. Saving after switching back updates the same work, with the last successfully saved revision retained as a small account-scoped local marker. Server-side revision conflicts remain enforced. Deleting a local session does not delete an account work.

## Verification

- Build and TypeScript check passed. `npm test`: 304 passed.
- 47 distinct browser cases passed across sessions, account, Agent, element editing, timeline/clipboard and visible-crop suites, executed in batches. The original expanded run passed 43/45; two pre-existing account tests referenced the old inspector label and selected the header instead of a message. After updating those locators, both original draft/conflict assertions passed. Two additional recovery/handoff cases also passed.
- Ten session-specific cases cover migration, immediate-switch autosave, scene/transcript/attachment isolation, rename/search, copy/delete, stale-tab conflicts, storage failure/retry, account isolation, stopped/late AI requests, saved-work association and remote conflicts, interrupted recovery, login handoff, screenshot scroll restoration, and normal/example draft separation.
- Mobile 390 × 844 light/dark and desktop 1440 × 1000 were visually inspected. Axe WCAG 2 A/AA checks passed. Screenshots in `evidence/session-management/` contain synthetic data only.
- Tests ran against an isolated local API/database on port 4424. The existing 4417 service serves the built frontend; its account database and backend were preserved.

## Boundaries

Session history is local to this browser, not a server-synchronized conversation inbox. “My works” saves the rendered scene to the account, not the full AI transcript. Undo/redo remains an in-session editor operation and resets when switching sessions. No private user screenshot, conversation, account ID or credentials were added to the repository.
