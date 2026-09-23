# IMStage self-hosted API

Local / self-hosted backend for IMStage accounts and owned scenes.

`services/api/server.mjs` implements the real backend only: registration, login,
logout, password change, opaque server-side sessions, and per-user scene,
contact, template and project persistence. Auth uses the Node standard library; the separate Agent service uses `sharp` to verify generated images actually decode.

## What this is (and is not)

- Real local/self-hosted auth backed by SQLite and scrypt.
- No OAuth provider, no email verification, no password-reset-by-email. There is
  no way to recover an account through this server; document that to users.
- Not a Vercel/serverless backend. It is a long-lived Node process with a local
  SQLite file storing both accounts and sessions. Rate-limit counters are process-local.
- DeepSeek Agent creation/editing is implemented under `/api/agent/run`; see [Agent service](../agent/README.md). Image generation requires separate provider configuration. MCP runs as a separate authenticated service; see [MCP service](../mcp/README.md). Billing and per-customer hosted API keys remain unimplemented.
- The Web UI is integrated with these endpoints. Run `npm run dev` for both development servers, or `npm run build && npm start` for the unified app.

Requires **Node >= 22.18** (native TypeScript type stripping is used to import
the shared scene model from `apps/web/src/studio/model.ts`).

## Running

```bash
# standalone API
node services/api/server.mjs

# unified app: serve the built web app and the API from one origin
IMSTAGE_API_PORT=4417 IMSTAGE_APP_ORIGIN=http://127.0.0.1:4417 \
IMSTAGE_DIST_DIR=dist node services/api/server.mjs
```

The unified single-origin setup is the intended production shape: the server
binding is loopback-only and there is deliberately no CORS, so the browser app
and the API must share one origin. `dist/` is produced by `npm run build`.

## Configuration

| Setting | Env var | Default | Notes |
| --- | --- | --- | --- |
| Bind host | `IMSTAGE_API_HOST` | `127.0.0.1` | Must be loopback (`127.0.0.1`, `::1`, `localhost`). Non-loopback values throw. |
| Port | `IMSTAGE_API_PORT` | `4419` | `0` selects a free port (tests). Use `4417` for the unified app. |
| Data directory | `IMSTAGE_DATA_DIR` | `.local/app` | Directory created with mode `0700`. |
| Database file | — | `<data dir>/imstage.db` | Created with mode `0600`; WAL mode. |
| App origin | `IMSTAGE_APP_ORIGIN` | `http://127.0.0.1:4417` | Exact browser origin allowed on mutations. |
| Trusted proxy | `IMSTAGE_TRUST_LOOPBACK_PROXY` | unset | Set `1` only behind a local proxy that overwrites `X-Real-IP`; used for auth throttling. |
| Static dir | `IMSTAGE_DIST_DIR` | `dist` | Built web app; missing directory → static 404s. |
| Node env | `NODE_ENV` | `development` | In `production`, a non-loopback origin must be `https://` or startup fails. |

Unsafe production setups fail fast: `NODE_ENV=production` with a non-HTTPS,
non-loopback `IMSTAGE_APP_ORIGIN` throws, and a non-loopback bind host always
throws. `X-Forwarded-For` and `Forwarded` are never trusted.

### Programmatic use

```js
import { createApp, start } from './services/api/server.mjs';

// createApp() builds the app without listening.
// Returns { server, close, db, config }.
const app = createApp({ dbPath: '.local/app/imstage.db', appOrigin: 'http://127.0.0.1:4417' });
app.server.listen(app.config.port, app.config.host);
await app.close();

// start() is a convenience wrapper that also listens.
// Returns { server, close, db, config, port }.
const running = await start({ port: 0 });
const baseUrl = `http://127.0.0.1:${running.port}`;
await running.close();
```

Options accepted by both: `dbPath`, `dataDir`, `appOrigin`, `port`, `host`,
`distDir`, `now`, plus test-friendly `env`, `nodeEnv`, `logger`,
`hashConcurrency`, and `rateLimit` (`{ ip, email, user }` objects with
`windowMs` / `max` / `maxKeys`).

`now` may be a function returning a `Date` or a millisecond timestamp; it is
used for every timestamp and expiry decision, which makes expiry testable
without waiting. `close()` is idempotent, closes the HTTP server and the
database, and is safe to call when the server never listened.

## API

All API responses are JSON with `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`X-Frame-Options: DENY` and a restrictive `Content-Security-Policy`.
Errors always use `{ "error": { "code": "...", "message": "..." } }` with
Chinese, non-sensitive messages. Unknown `/api/*` routes return 404 JSON and are
never served as an SPA fallback.

### Mutations and CSRF

Every `POST`, `PUT` and `DELETE` request (including login and register) must:

1. send an `Origin` header exactly matching `IMSTAGE_APP_ORIGIN`, and
2. send `X-IMStage-Request: 1`.

Missing/mismatched `Origin` → `403` (`origin_required` / `origin_mismatch`);
missing marker → `403` (`request_marker_required`). `Content-Type` must be
`application/json` (`415` otherwise). Reads (`GET`) do not require the marker.
There is no CORS handling and no `Access-Control-Allow-Origin` header.

### Auth

| Method + path | Body | Success | Notes |
| --- | --- | --- | --- |
| `GET /api/health` | — | `200 {status:"ready"}` | Unauthenticated. |
| `GET /api/auth/session` | — | `200 {user:null\|{id,email,name}}` | Reads the `imstage_session` cookie. |
| `POST /api/auth/register` | `{name,email,password}` | `200 {user}` | Immediately establishes a session. |
| `POST /api/auth/login` | `{email,password}` | `200 {user}` | Establishes a session. |
| `POST /api/auth/logout` | `{}` | `200 {ok:true}` | Revokes the caller's session; idempotent. |
| `POST /api/auth/password` | `{currentPassword,newPassword}` | `200 {ok:true}` | Revokes **all** sessions; re-login required. |

Validation rules:

- `email`: trimmed, lower-cased, unique; stored as the normalized value.
- `name`: trimmed, 1–60 characters.
- `password`: 12–128 characters, any character set, **never trimmed**
  (leading/trailing spaces are significant).
- Wrong password and unknown email both return the same
  `401 {error:{code:"invalid_credentials"}}` and both pay one scrypt
  verification, including a dummy hash for unknown accounts.
- Duplicate registration returns `409 email_taken`.

Sessions:

- Opaque 32-byte random token (`base64url`), stored only as a SHA-256 hash.
- Cookie `imstage_session`, `HttpOnly`, `SameSite=Lax`, `Path=/`,
  `Max-Age=604800` (7 days, fixed — using a session never extends it), and
  `Secure` when `IMSTAGE_APP_ORIGIN` is `https:`.
- Password change deletes every session for the user.

### Scenes

All scene routes require a valid session. Scenes are always filtered by the
authenticated owner; another user's scene is indistinguishable from a missing
one (`404`, never `403`).

| Method + path | Body | Success |
| --- | --- | --- |
| `GET /api/scenes` | — | `200 {items:[{id,title,platform,messageCount,updatedAt,revision}]}` |
| `GET /api/scenes/:id` | — | `200 {item:{id,scene,updatedAt,revision}}` |
| `PUT /api/scenes/:id` | `{scene,revision}` | `200 {item:{id,scene,updatedAt,revision}}` |
| `DELETE /api/scenes/:id` | `{revision}` | `200 {ok:true}` |

Revision semantics (optimistic concurrency):

- The client generates the scene id as a UUID and puts it in both the URL and
  `scene.id` (case-insensitive; stored lower-case). A mismatch is `400`.
- `revision: 0` creates the scene and stores revision `1`. Creating an id that
  already exists returns `409 conflict`; the UI treats a repeated identical
  create as "already saved".
- `revision >= 1` updates only if it matches the stored revision, then
  increments it. A stale revision returns `409 revision_conflict`.
- `DELETE` requires the current revision; a mismatch returns `409`.
- Max `100` scenes per user (`409 scene_limit_reached`).

Scene payloads are validated with the shared `validateScene` from
`apps/web/src/studio/model.ts` and only the normalized scene is persisted. This
rejects unknown platforms, invalid message/participant references, and remote
asset/avatar URLs (only bounded local `data:image/...` values are accepted).
No arbitrary metadata is stored: the scene JSON is capped by the request limit
and the indexed columns are bounded.

## Reusable templates and project batches

Authenticated `/api/templates` routes create, list, read, update, delete and
instantiate owner-scoped snapshots. Revisions prevent silent overwrites; normal
scene autosave does not modify the original template. Project `batch-jobs`
accept structured variants and freeze template values and common rules before
the sequential Agent worker starts. See [the complete contracts and limits](../../docs/templates-and-projects.md).

## Limits and resource bounds

- Request bodies: auth routes and scene `DELETE` → **16 KiB**; scene `PUT` →
  **16 MiB**. `413 payload_too_large`.
- Requests above the limit are drained up to limit + 4 MiB so the client can
  read the `413`; beyond that the socket is closed.
- Per-route read deadlines (15 s auth, 30 s scene) and HTTP server
  `requestTimeout` / `headersTimeout` bounds.
- Auth (login/register) throttle per remote IP (default 300 / 10 min) and per
  normalized email (default 10 / 10 min); password change is additionally
  throttled per user. Exceeding a limit returns `429` with `Retry-After`.
  Counters are bounded and pruned.
- scrypt work is limited by a concurrency semaphore (default 4).
- Credentials and request bodies are never logged.

## Password hashing

- Async `crypto.scrypt`, 16-byte random salt, 64-byte key.
- Parameters `N=32768`, `r=8`, `p=3`, `maxmem=64 MiB` (OWASP-equivalent work
  factor). Stored as `scrypt$N$r$p$salt$hash` and compared with
  `crypto.timingSafeEqual`.
- Missing users verify against a precomputed dummy hash with identical cost.

## Database

SQLite via `node:sqlite` (`DatabaseSync`), WAL mode, foreign keys on, 5 s busy
timeout. The data directory is `0700` and the database file (plus `-wal`/`-shm`
when present) is `0600`. Uniqueness, session revocation and scene revision
updates run inside `BEGIN IMMEDIATE` transactions.

Tables: `users`, `sessions` (token hash + absolute `expires_at_ms`), `scenes`
(per-user primary key `(user_id, id)`, revision, normalized scene JSON).

## Static serving

When `IMSTAGE_DIST_DIR` exists, non-API `GET`/`HEAD` requests are served from
that directory:

- only files inside the resolved dist directory, after symlink resolution;
- no dotfiles and no path traversal (`404`);
- SPA fallback to `index.html` for unknown non-API routes;
- correct MIME types and `X-Content-Type-Options: nosniff`;
- unknown `/api/*` routes remain `404` JSON and never fall back to the SPA.

## Tests

```bash
node --test tests/auth-api.test.mjs
```

The suite covers registration/login/logout/password change, persistence across a
restart, session expiry with an injected clock, owner isolation, Origin and
request-marker enforcement, oversize rejection, validation, duplicate
registration, revision conflicts, rate limiting, cookie flags, configuration
safety and static serving. It uses its own scoped sub-directory under
`IMSTAGE_ARTIFACT_DIR` (falling back to the OS temp dir) and removes only that
sub-directory.

The browser sends `X-IMStage-User` on authenticated requests. If it does not match the cookie session, the API rejects the request instead of operating on a different account after another tab switches users. Password changes recheck the session and old password hash after hashing. Session records are capped at 20 per user; expired records are pruned on session creation.
