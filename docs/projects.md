# Projects and bounded batch generation

User scope: account-owned projects, project rules/default platform, saved scene
grouping and bounded batch DeepSeek generation, requested 2026-09-21.

## What a project is

A project is account-owned metadata, not a separate content store:

- `id`, `name` (1–80 chars, required);
- `rules` (default empty, max 4000 chars) — ordinary user-authored creative
  constraints, explicitly **not** secrets;
- `platform` (default `wechat`) — the default platform for new batch items;
- `revision` and `updatedAt` — optimistic concurrency for saved edits.

A project is limited to 50 per account. Deleting a project deletes only the
project and its `scene_projects` association rows. The saved scenes stay in
`我的作品`, exactly as before.

Scenes associate through a separate `scene_projects` table (no `scenes` column
migration, no data reset). An existing scene can be attached to a project only
after an ownership check; cross-account scene or project access returns 404.

## HTTP endpoints

All project and batch routes require an authenticated session. Mutations also
require the exact Origin, JSON content type and the `X-IMStage-Request` marker.
Reads are short GETs (no long-lived request that could hit the client's 15s
deadline).

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/projects` | List own projects with scene counts |
| POST | `/api/projects` | Create a project |
| GET | `/api/projects/:id` | Project + attached scene summaries |
| PUT | `/api/projects/:id` | Update name/rules/platform with `revision` |
| DELETE | `/api/projects/:id` | Delete with `revision`; preserves scenes |
| POST | `/api/projects/:id/scenes` | Attach an owned scene (`sceneId`) |
| DELETE | `/api/projects/:id/scenes/:sceneId` | Detach; never deletes the scene |
| POST | `/api/projects/:id/batch-jobs` | Enqueue a batch (immediate JSON response) |
| GET | `/api/projects/:id/batch-jobs` | Recent job summaries |
| GET | `/api/projects/:id/batch-jobs/:jobId` | Job + per-task status |
| POST | `/api/projects/:id/batch-jobs/:jobId/cancel` | Cancel a queued/running job |
| POST | `/api/projects/:id/batch-jobs/:jobId/retry` | Re-run failed/interrupted tasks |

### Batch request

```json
{
  "prompts": ["第一段对话", "第二段对话"],
  "platforms": ["wechat", "xiaohongshu"],
  "clientBatchId": "optional-stable-key"
}
```

- Up to 10 non-empty prompt lines (4000 chars each); `promptsText` is also
  accepted and split on newlines.
- 1–6 distinct supported platforms; omitted platforms fall back to the project
  default.
- `prompts × platforms` must be ≤ 20 items.
- Enqueue returns immediately after the job is persisted; it does **not** hold
  the request open while generation runs.
- `clientBatchId` makes the submit idempotent: a retried request (for example
  after a client timeout) returns the already-created job with
  `deduplicated: true` instead of duplicating work. At most 3 queued/running
  batch jobs per account.

## Execution semantics

- A single in-process worker claims durable jobs from SQLite in FIFO order and
  runs tasks serially. Each task calls the existing
  `ctx.agent.runtime.run` — the same runtime, provider and model as interactive
  Agent runs. There is no second model client and no fake provider fallback.
- Every task starts from a validated blank scene built with the shared
  `createScene` contract and a server-generated UUID. A successfully finished
  run is published as a **new** scene with that UUID and attached to the
  project; batch never overwrites or modifies existing user scenes.
- Rules are snapshotted at enqueue and injected as a separate, clearly labelled
  instruction block (`【项目规则…】` + `【本次任务】`). Changing the project
  later does not change a queued or finished job.
- Only `ok: true` runs publish. Tool failures, incomplete turns, timeouts,
  cancellation and restarts are recorded per task with a code and message; the
  job is `done`, `partial`, `failed`, `cancelled` or `interrupted` accordingly.
- Batch tasks acquire the same global/per-user active lease and fixed-window
  rate limit as interactive Agent runs. When the user is busy, a task waits
  (bounded) rather than bypassing the limiter.
- A cancel request aborts the active run and stops the remaining tasks. A
  revoked/expired session is rechecked before and during a run; losing the
  session cancels the job instead of publishing more scenes.
- Restart recovery runs before the worker may claim anything: jobs left
  `queued`/`running` by a previous process (including crash residue) are marked
  `interrupted`. Resuming paid generation is always an explicit user action
  (re-enqueue or retry), never automatic.

## Agent integration

`services/projects/store.mjs` exposes `getProjectContext(db, userId, projectId)`,
returning `{ id, name, rules, platform }` only when the project belongs to the
caller, otherwise `null`.

`POST /api/agent/run` accepts an optional `body.projectId`. When present, the
server loads the owned project, appends its rules as the labelled instruction
block, and leaves the user prompt length validation (≤ 4000 chars) unchanged.
Another account's project id returns 404 and contributes no rules.

## Web surface

`#/projects` lists and creates projects. `#/projects?project=ID` edits a project
(name/rules/platform with conflict-safe, disabled-while-saving state), lists
attached scenes with links to the existing `AccountEditor`, allows attaching or
detaching owned scenes, and drives the batch panel with visible per-task
progress, failure detail, cancel and explicit retry. An explicit confirmation
dialog states that deleting a project preserves its scenes.

## Verification

```sh
npm ci
npm run typecheck
node --test tests/projects.test.mjs
```

`tests/projects.test.mjs` covers account isolation, conflict-safe revisions,
rule snapshots at enqueue, idempotent submit, successful publish, failed-tool
handling, cancel, session revocation, restart recovery and normal Agent
project-rule integration with injected providers (no network or credential).

The broader `npm test` suite and `npm run build` continue to pass. These are
local results, not remote CI or deployment evidence.

Each scene belongs to at most one project. Explicit attachment moves an owned
scene to the selected project. Ordinary scene save accepts `projectId`: an
omitted field preserves membership, an empty string detaches, and a project ID
moves it. Membership changes share the save transaction and revision check.
The editor includes membership in dirty state and same-tab recovery.

Rules are model instructions, not a deterministic grammar. Live verification
observed fixed wording being paraphrased despite successful tool execution;
`done` means the run and persistence completed, not semantic/human approval.
