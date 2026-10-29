# Google Sign-in Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans, implement natively,
> and obtain independent authentication review before merge.

**Goal:** Deploy Google login while preserving existing accounts and works.

**Architecture:** GIS supplies an ID token to same-origin Node endpoints. Durable
nonce flows and Google-subject associations live in SQLite, and both login
methods use the existing IMStage sessions.

**Tech Stack:** React/TypeScript, Node 22, SQLite, google-auth-library, node:test,
Playwright. No authentication-host migration or paid provider calls.

**Spec:** `docs/superpowers/specs/2026-10-29-google-signin-design.md`

## Global Constraints

- Existing six-character password policy and original user/scene records remain.
- No Google email auto-link; use verified subject and explicit password proof.
- Nonce flows expire after 600 seconds, are one-use and session bound.
- Runtime client IDs/configuration and all credentials remain outside Git.
- Google-only users cannot remove their only sign-in method.

## Review Focus

- Logout/account switch during verification must invalidate the in-flight flow.
- A late authentication cookie must refer to a session that logout can revoke.
- Duplicate email/subject races must leave both original accounts untouched.
- An unavailable SDK/provider must preserve password login and honest errors.
- Unmount, locale changes and retries must not reuse stale nonce callbacks.

## Task 1: Google identity and flow store

**Files:** create `services/auth/google.mjs`, `tests/google-auth.test.mjs`;
modify `package.json` and `package-lock.json`.

**Interfaces:** export `GOOGLE_ONLY_PASSWORD_HASH`, `GoogleAuthError`,
`createGoogleAuth(db, {clientId, nowMs, verifyToken})` and
`verifyGoogleIdToken(credential, clientId, {client}?)`. The service exposes
config, issue/claim/recheck/complete/invalidate flow operations, pending
registration, identity lookup/link, and sign-in-method queries. The server owns
the surrounding account/session transaction.

- [ ] Write and run failing tests for configuration, issuer/audience/email,
  nonce expiry, replay, flow binding, pending consent and identity uniqueness.
- [ ] Install the pinned official library in independent worktree dependencies;
  lazy-load it so Google adds no remote work to API startup.
- [ ] Implement additive schema and bounded flow cleanup. Retain completed flow
  session references until expiry so logout can revoke a late-issued session.
- [ ] Verify real RSA signatures with locally generated keys and the real Google
  verification library; mock only its certificate transport in this test.
- [ ] Run `node --test tests/google-auth.test.mjs` and commit the passing module.

## Task 2: Same-origin API and existing-auth integration

**Files:** modify `services/api/server.mjs`; create
`tests/google-auth-api.test.mjs`; extend existing auth tests where needed.

**Interfaces:** `GET /api/auth/google/config`, `POST .../challenge`,
`POST .../credential`, `POST .../register`, `POST .../cancel`,
`GET /api/auth/methods`, `POST .../google/unlink`.
Challenge takes `intent: signin|link` and link password proof. Credential takes
only `credential` and optional terms consent; purpose comes from the stored flow.
Responses authenticate the existing user or return verified pending-registration
profile. Registration takes a name and explicit consent, never a client email.

- [ ] Write failing integration tests for secure cookies, Origin/body guards,
  real persistent sessions, registration consent and protected scene ownership.
- [ ] Add Google routing using existing hash/session/transaction helpers. Mark
  Google-only hashes unusable while retaining ordinary password timing cost.
- [ ] Invalidate browser Google flows on successful existing-auth mutations and
  test deferred verification versus login/logout/password change.
- [ ] Test explicit link, duplicate email/subject, last-method unlink refusal,
  session revocation and a late-response logout race.
- [ ] Run Google plus existing auth API tests, then commit passing integration.

## Task 3: Login, registration and account settings

**Files:** create `apps/web/src/account/GoogleSignIn.tsx` and shared consent UI;
modify `AuthPage.tsx`, `AccountPage.tsx`, account styles/i18n/API helpers,
privacy copy and only required response headers. Create
`tests/ui/google-auth.spec.ts`.

- [ ] Add browser fixtures for the official SDK callback and API responses:
  configured/unconfigured, consent, existing-email conflict, link proof, failed
  SDK load, cancellation/retry and stale callback after navigation.
- [ ] Load the SDK once when configured, initialize a fresh nonce-bound button,
  and guard callback generation/unmount. Keep credentials out of storage/logs.
- [ ] Reuse existing auth acceptance/onboarding and shared legal consent; show
  Google-only account status without a nonfunctional password-change form.
- [ ] Verify Chinese/English, keyboard access and narrow layout. Run targeted
  Google and existing account browser tests and production build; commit.

## Task 4: Review, Google setup and deployment

**Files:** update `services/api/README.md`, `docs/core-web-auth.md` and deployment
guidance; keep machine/provider configuration in ignored private files.

- [ ] Independent whole-change security review; resolve confirmed P0/P1.
- [ ] Run host tests, deployment tests, build/MCP checks and required PR CI.
- [ ] Prepare a dedicated Google Web client with canonical origin, production
  audience and basic identity only. Obtain required action-time confirmation
  before creating/publishing security-sensitive browser configuration.
- [ ] Configure the runtime client ID privately; preserve the tuned Standard
  Mac deployment timer and the existing database/providers.
- [ ] Merge the linked PR after its current checks pass. Wait for exact-main CI,
  Vercel deployment and automatic Mac adoption; verify public revisions.
- [ ] Complete real Google account login/consent, refresh/restart persistence,
  bounded saved-work roundtrip, logout and password-login regression. Record
  limitations honestly and close/read back GET-318 only after acceptance.
