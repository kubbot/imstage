# Core Web and account workspace

User scope: core Web design, startup and actual login, requested 2026-09-21.

## Experience

- The existing warm neutral/coral system carries through light, dark and system themes. Login is a focused form; its decorative conversation disappears on small screens.
- Visitors can use the editor without an account. Login returns to the requested editor or saved scene. Switching between login and registration retains only email/name, never the password.
- The account workspace shows saved conversations, search, deletion with cancellation, a new conversation entry and account settings at desktop/mobile widths.
- Saved scenes reuse the existing editor and PNG/JSON renderer. Guest localStorage persistence is disabled inside the account editor. Explicitly saving a guest draft copies it to the account; no automatic migration.
- Account edits use a per-user/per-scene sessionStorage recovery copy, available in the same tab. Save conflicts never overwrite a remote revision: the current edit remains available for JSON export or saving a separate copy. If storage is full, in-app navigation asks before discarding changes; browser reload/close uses beforeunload.
- Logout revokes the server session. Changing a password revokes all sessions. Tabs refresh their identity after account changes. An old request cannot expire a newer identity or write a scene under a different signed-in account.

## Run

Node >=22.18 <23 is required for native SQLite and type stripping of the shared scene contract.

```sh
npm ci
npm run dev
# http://127.0.0.1:4417/#/workspace (Vite proxies /api to :4419)
```

For the built app, stop dev first:

```sh
npm run build
npm start
# one origin/process: http://127.0.0.1:4417
```

`IMSTAGE_WEB_PORT`, `IMSTAGE_APP_ORIGIN`, and `IMSTAGE_DATA_DIR` configure the unified runtime. Data defaults to ignored `.local/app/imstage.db` and persists across restarts. It is separate from the private Eval server on port 4421. Do not commit this directory or raw user conversations. Back up SQLite using a consistent database backup, not only the DB file while its WAL is active.

`npm run preview` remains a static preview and does not provide accounts. A Vercel static deployment also does not host this SQLite backend. Use an HTTPS reverse proxy to the loopback Node service for a self-hosted remote instance; set the exact HTTPS app origin. No broad CORS or forwarded-IP trust is enabled.

## Auth and data boundaries

- Email/password registration and login, session readback, logout and password change are implemented.
- Passwords use async scrypt with a random salt. Random opaque session cookies are HttpOnly and SameSite=Lax (Secure on HTTPS); the database retains only a token hash. Sessions expire after seven days.
- Mutations require exact Origin, JSON and a custom request header. API reads are no-store. Scene writes enforce owner identity, the shared schema, byte/count bounds and optimistic revisions. Account requests carry their expected user identity to detect cross-tab account changes.
- Password and session checks are repeated after asynchronous hashing or streamed request bodies before sensitive writes. The hash queue is bounded; authentication attempts are throttled.
- Email is an account identifier, **not verified ownership**. OAuth, verification mail and password-reset mail are not configured. The UI states this instead of offering nonfunctional provider/reset buttons. No billing or new AI provider is introduced.
- This is a local/self-hosted first version, not a claim of managed cloud availability or a full authentication security certification.

Implementation references: [Node 22 crypto](https://nodejs.org/docs/latest-v22.x/api/crypto.html), [Node SQLite](https://nodejs.org/api/sqlite.html), [OWASP session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html). Node 22's SQLite API is still marked experimental; runtime version is pinned accordingly.

## Verification

`npm test` covers the model, server and identity-response boundaries. `npm run build` checks TypeScript and builds the client. `npm run test:ui` runs the built app with a separate account database under `IMSTAGE_ARTIFACT_DIR`, covering real auth, owned scenes, recovery, conflict copies, password changes, desktop/mobile themes and accessibility, plus existing editor/export behavior. Build before browser tests; choose a free `IMSTAGE_TEST_PORT` (e.g. 4418) while a local app is running.

The private screenshot Eval benchmark remains on its existing branch and runtime. It is not merged, copied or reset by this feature.

Verified on macOS / Node 22.23.2 / Chrome on 2026-09-21: 84 Node tests passed, 36 browser tests passed, TypeScript and production build passed. Browser checks include 320/390/768/1440px layouts and light/dark WCAG A/AA automated checks. An independent review reproduced and closed password-change races, static symlink containment, stale identity responses, mobile settings access, delayed-login navigation and storage-full navigation protection. These are local verification results, not remote CI or public deployment evidence.
