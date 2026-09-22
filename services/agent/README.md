# IMStage Agent service

Bounded, server-side DeepSeek tool-calling backend for the prompt-first studio.
It is deliberately **separate from the frontend**: it owns provider calls, tool
execution, scene invariants and the NDJSON event stream, while the UI owns
rendering and presentation.

Scope boundary: real AI-assisted scene creation/editing only. No arbitrary
URLs, no shell, no network tool and no browser access. The Tencent image
provider alone downloads completed results from validated COS hosts over HTTPS.

## Endpoints

### `GET /api/agent/capabilities`

Public, non-secret status. No session, no mutation headers.

```json
{ "configured": true, "model": "deepseek-flash", "imageConfigured": false }
```

`configured` means a DeepSeek-compatible chat key + base URL resolved;
`imageConfigured` means a valid image provider (`openai` or `tencent-wand`)
with its key/base/model resolved. The response never contains a key, base URL or
token.

### `POST /api/agent/run`

Protected by the existing `guardMutation` (exact `Origin` +
`X-IMStage-Request: 1`), `requireSession` and a post-body `recheckSession`.
Errors before streaming (auth, CSRF, validation, limits, unconfigured AI) are
regular JSON `{error:{code,message}}`. A successful request returns
`200 application/x-ndjson; charset=utf-8` and one JSON object per line.

Request body:

```jsonc
{
  "prompt": "把最后一句改得更轻松一点",        // 1..4000 chars
  "scene": { /* canonical Scene from apps/web/src/studio/model.ts */ },
  "targetId": "m-4",                          // optional: targeted-edit one message
  "attachments": ["data:image/png;base64,..."], // optional, max 3, <=6MB each, png/jpeg/webp
  "history": [{ "role": "user", "content": "..." }] // optional, max 12, <=4000 chars each
}
```

NDJSON event union (exactly these records, one per line):

```jsonc
{ "type": "scene", "scene": { /* validated Scene */ } }
{ "type": "tool", "id": "call_1", "name": "upsert_message", "state": "running", "detail": "正在更新消息…" }
{ "type": "assistant", "text": "已按要求修改。" }
{ "type": "done" }
{ "type": "error", "message": "AI 服务暂时不可用，请稍后重试。" }
```

`done` is only emitted after at least one real, validated scene mutation. A run
that only narrates (no tool call), whose tool calls all fail, or whose final
provider turn reports an incomplete/refused finish reason (`length`,
`content_filter`, `insufficient_system_resource`, `aborted`) ends with `error`,
never with `done`. An incomplete turn is rejected before any of its tool calls
are applied. Streams abort on client disconnect and on a 120 s wall deadline;
the deadline also aborts pending socket writes, so a non-reading client cannot
pin a run or its concurrency lease — the socket is finished/destroyed boundedly.

## Tools

| Tool | Arguments | Effect |
| --- | --- | --- |
| `create_scene` | `{scene}` | Replace the whole scene from a full Scene object. |
| `upsert_message` | `{message}` | Insert or update one message by `id`. |
| `delete_message` | `{id}` | Delete one message. |
| `generate_image` | `{targetId, kind:"message"\|"avatar", prompt}` | Generate a real image for a message or participant avatar. |

Rules enforced after every mutation:

- the candidate is passed through the shared canonical `validateScene`;
- `scene.id` is always preserved (a model-supplied id is ignored);
- `create_scene`/`upsert_message` strip any model-supplied `asset`/`avatar`
  (models never return base64); existing assets are re-attached server-side by
  message/participant id;
- a mutation that changes nothing is reported as a failed tool result;
- `generate_image` with `kind:"message"` requires a media-capable message or album slot
  (a plain-text target gets a corrective tool error), so no paid
  image call is made for a message the renderer would ignore;
- on a **targeted** run (`targetId` present) only the selected element may change:
  `create_scene` and `delete_message` fail; message, participant and scene
  targets each restrict mutations to their own allowed fields.

The model only ever sees a compact scene context in which existing images and
avatars are replaced by `<已有图片…>` / `<已有头像…>` markers. The context is
built in O(n) with a single pass/id-serialization and a bounded join (no
repeated slice + stringify); when it must be truncated, the `targetId` message
is always preserved even if it is early in a long scene. User-provided
`attachments` are the only base64 that reaches the provider and are framed as
untrusted data.

## Provider

- Chat: native `fetch` to `{IMSTAGE_AI_BASE_URL}/chat/completions` (default
  `https://api.deepseek.com/chat/completions`), default model `deepseek-flash`,
  `stream:false`, `thinking:{type:"disabled"}`, `tool_choice:"auto"`, function
  tools. The loop appends the assistant `tool_calls` message and a
  `{role:"tool", tool_call_id, content}` result for every call, then calls the
  model again until it returns a final assistant message.
- The production client fails closed on `finish_reason`: only `stop` and
  `tool_calls` are accepted; `length`/`content_filter`/
  `insufficient_system_resource`/`aborted`, a missing value or an unknown value
  raise a bounded Chinese error (the raw value is never echoed). Injected test
  providers may omit `finishReason`, in which case the run loop still rejects
  any non-accepted string it is given.
- Upstream error bodies are never surfaced to clients: provider errors are
  built from the HTTP status only, so a proxy cannot echo a credential through
  an error detail.
- The loop is bounded to **8 rounds**, **24 tool calls** and a **120 s** wall
  deadline; the chat/image responses are read with a byte cap; client abort is
  propagated to `fetch`.
- Image: `IMSTAGE_IMAGE_PROVIDER` selects the client. `openai` (default) uses
  native `fetch` to `{IMSTAGE_IMAGE_BASE_URL}/images/generations` with
  `response_format:"b64_json"`; reference edits use `POST /images/edits`
  multipart. The returned base64 is decoded only to sniff the raster mime type;
  nothing is downloaded and there is no fake fallback. Missing image
  configuration yields a failed tool result + `tool` error event while text
  generation keeps working.
- Image: `tencent-wand` uses the Tencent TokenHub WAND-Vega async task API
  (`POST {base}/wand/vega-images/generations` → `task_id`, then
  `GET {base}/wand/vega-images/tasks/{task_id}` every **3 s** until a terminal
  status). `completed` returns temporary signed COS URLs; live responses have
  returned those over plain HTTP, so the runtime validates the URL as an
  allowlisted Tencent COS host and **upgrades it to HTTPS before fetching**, then
  validates the actual decoded raster before returning the usual
  `{dataUrl,mime,bytes}` contract. A plain-HTTP request is never issued, and
  other protocols are rejected. Reference editing sends the real inline
  `data:image/png|jpeg` URL in `input[].content[].image_url` (never silently
  dropped); WebP or malformed references fail before any submission. Polling is
  bounded by a deadline, abortable, and a failed/timed-out task is never
  resubmitted. The auth-bearing submit and poll requests use
  `redirect:'error'`, so an `Authorization` header is never forwarded to a
  redirect target. An unknown `IMSTAGE_IMAGE_PROVIDER` value fails closed (image
  generation is reported as not configured) instead of falling back to another
  provider.

## Environment (server-only)

| Setting | Env var | Default |
| --- | --- | --- |
| Chat key | `IMSTAGE_AI_API_KEY` or `DEEPSEEK_API_KEY` | — |
| Chat base URL | `IMSTAGE_AI_BASE_URL` | `https://api.deepseek.com` |
| Chat model | `IMSTAGE_AI_MODEL` | `deepseek-flash` |
| Image provider | `IMSTAGE_IMAGE_PROVIDER` | `openai` |
| Image key | `IMSTAGE_IMAGE_API_KEY` | — |
| Image base URL | `IMSTAGE_IMAGE_BASE_URL` | none for `openai`; `https://tokenhub.tencentmaas.com/v1` for `tencent-wand` |
| Image model | `IMSTAGE_IMAGE_MODEL` | none for `openai`; e.g. `wand-vega-image-lite` for `tencent-wand` |

A non-http(s) base URL degrades to "not configured" instead of ever producing an
arbitrary outbound request. Keys are read from the process environment only and
are never echoed in events, tool results or the capability response.

## Limits

Scene resource limits (applied to the incoming scene **and** every proposed
mutation; violations of the incoming scene are a `400 invalid_scene` before any
model context is built, mutations get a corrective tool error):

- messages: **200**; participants: **20**;
- message text: **4000** chars; ids: **128**; participant name: **120**;
- date: **80**; deviceTime: **20**; title/watermark: **200**.

Run limits:

- Global concurrent runs: 4 (default).
- Per-user concurrent runs: 1 (default).
- Per-user rate: 20 runs / 10 min (default), bounded windows.
- Whole-run wall deadline: 120 s (default). It covers the first emit, every
  backpressure wait and the provider calls; on expiry all pending writes abort,
  the socket is finished/destroyed after a short bounded delay and the active
  lease is released.
- Request body cap: 40 MiB (16 MiB scene + 3 × 6 MiB attachments + history).
  Prompt, attachments, history and scene are all bounded. Exceeding a limit
  returns `429` with `Retry-After` before streaming.

## Tests

```bash
node --test tests/agent.test.mjs tests/agent-api.test.mjs tests/tencent-images.test.mjs
```

All suites inject fake providers/fetch — **no network call and no credential**
is used. They cover: genuine multi-round tool sequences, invalid-tool
feedback/recovery, no-op-is-not-success, incomplete/refused/unknown provider
finish reasons (provider-level and run-level), selected-only invariants,
id/asset preservation, image targets that must be `type:"image"`, batch abort
(is rethrow + no later mutation/emit), disabled-image failure, image success,
provider selection (default OpenAI, explicit Tencent WAND, unknown fail-closed),
scene resource limits on input and mutations, O(n) bounded context with the
target preserved under truncation, bounds, abort/timeout, round/call caps, the
NDJSON wire format, provider request/response shape and error-message
sanitisation, abortable NDJSON backpressure writes with bounded socket
finish/destroy, per-user/global active limits, bounded rate limiting, auth
denial and admitted NDJSON, and lease cleanup on finish/disconnect.

`tests/tencent-images.test.mjs` also covers the WAND async flow end to end with
fake fetch: single submission, 3 s polling to `completed`, presence of the actual
inline reference bytes, abortable deadline without resubmission, terminal
`failed`/`cancelled`/`incomplete` handling, unknown status fail-closed, sanitized
HTTP errors, COS download allowlisting (host/credentials/port checks, plain-HTTP
result URLs upgraded to HTTPS with no insecure request, no private/other hosts),
redirect rejection on both downloads and auth-bearing submit/poll, byte limits
and actual image decoding.

## Limitations

- Streaming from the model is not used (`stream:false`); events are emitted per
  completed turn/tool, not token-by-token.
- Thinking mode is intentionally disabled; `reasoning_content` is not handled.
- OpenAI-compatible image generation only accepts `b64_json`; that client never
  downloads remote image URLs. The Tencent WAND client downloads only the
  completed task's first URL, and only from allowlisted Tencent COS hosts over
  HTTPS (a plain-HTTP result URL is upgraded, never fetched insecurely).
- The server runs agent runs in-process; long runs occupy a Node request
  handler until completion or the 120 s deadline.
- Not a managed cloud service: no billing, quotas, persistence of run history or
  cross-instance coordination (limits are process-local).

Generated image tools additionally require actual PNG/JPEG/WebP decoding through sharp, with a 16-megapixel limit. Invalid/truncated image bytes never produce a successful tool result. Combined scene assets are capped at 12 MiB of data URL characters. The same check runs after each mutation.

## Rich elements, image edits and reference screenshots

`update_element` supports `@scene` settings and `@participant:ID` identity.
Message targets include image, video-thumbnail, contact, location, link and
album slots. Image `kind` also accepts `background`. `edit:true` sends the
selected element's existing bytes as the reference (multipart `/images/edits`
for the OpenAI-compatible client, inline `input[].content[].image_url` for
Tencent WAND) instead of regenerating from text alone. No live image-provider
acceptance is claimed without credentials.

`Scene.reference` contains a verified source raster, normalized editing plan
and owned assets. It switches the same `runAgent` loop to `read_text`,
`inspect_region`, `find_frame`, `list_assets`, `set_text`, `set_edits`,
`place_image`, `generate_image`, `render_preview`, and `finish`. Only source,
task and authorized asset descriptions enter the model; expected answers and
scoring boxes do not. Web and evaluation use the same plan validator, HTML,
font fitting and server PNG renderer. macOS OCR uses Vision; Linux uses
Tesseract with Chinese, English and Russian language data.

Reference inputs are decoded with an 8-megapixel cap and actual source
width/height must equal the document. WebP is converted to PNG for rendering.
`POST /api/agent/render` requires the existing session/CSRF gates and returns
an original-resolution PNG. Source-backed editing and cross-platform Scene
reconstruction are distinct modes; selecting another platform requests a new
Scene rather than relabelling the original raster.

Completion rejects unresolved image failures, missing message media and
newly generated reference assets not placed in the output. Reference mode
also requires a successful preview of the latest state. This proves execution,
not semantic correctness; dataset scores and human reviews remain separate.

Interactive runs use 8 rounds / 24 calls / 120 seconds; the bounded evaluation
adapter allows 12 rounds / 40 calls / 180 seconds. Project batches share the
interactive runtime, ownership checks and concurrency limiter.
