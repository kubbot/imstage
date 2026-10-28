# Login upstream investigation — 2026-10-28

Status: production login remains blocked by the API upstream. The client change
in this PR improves failure handling; it does not restore the production API.
No production deployment, OAuth, credentials, DNS or security configuration was
changed during this investigation.

## Deployment evidence

- `origin` is `https://github.com/kubbot/imstage.git`. The investigation branch
  starts at `main` commit `67b186b`.
- A fresh HTTPS read of `https://imstage.org/` returned HTTP 200,
  `Server: Vercel` and an `X-Vercel-Id` header. This confirms the public frontend
  is served by Vercel; it does not identify the physical API server or prove an
  account service is running.
- [The deployment contract](deployment.md) and [server runbook](../deploy/README.md)
  describe a static Vite frontend with a persistent Node 22 / SQLite API.
  [vercel.json](../vercel.json) proxies `/api/*` and the two OAuth discovery paths
  to `https://103.195.188.236/api/*`. Vercel's
  [external rewrite documentation](https://vercel.com/docs/routing/rewrites)
  describes this proxy behavior.
- A fresh read of `/api/auth/session` on the public frontend returned HTTP 403,
  `Content-Type: text/html`, a `Cf-Ray` header and `Server: Vercel`. This is not
  the account API's JSON session response. The health read also failed at the
  transport layer in this check. Earlier production verification recorded HTTP
  421; see [the existing deployment limitation](design-taste-acceptance.md#deployment-limitation-observed-before-this-change).
- A direct HTTPS health read of the configured upstream failed strict TLS
  validation: its certificate is not valid for `103.195.188.236`.
  Verification was not bypassed. The previously documented SSH identity change
  was not overridden or accepted.
- `api.imstage.org` did not resolve in the DNS check. It is not a verified
  replacement destination.
- The existing local service returned JSON `{"status":"ready"}` and
  `{"user":null}` for health/session reads. Its launch configuration uses a
  separate private access origin and an older release. That does not establish
  it as the intended public production backend. Private hostnames, account
  configuration, databases and deployment receipts remain outside Git.
- The connected Vercel project inspection was reported as denied by team
  permissions. Restricted team configuration was not queried through another
  route. The current Vercel deployment commit/settings were therefore not
  independently read back here.

## Findings and client fix

The public session request is not receiving the application JSON response, and
the configured upstream cannot pass TLS identity verification. The public API
path is the confirmed release blocker. Whether the IP changed owner, the server
moved, or its virtual host/certificate changed still requires a trusted current
backend endpoint. A password change or weaker authentication checks cannot
repair this connection failure.

The client previously reduced an HTML gateway error to a generic request error.
An HTML 401 on a protected request also dispatched `imstage-session-expired`,
even though the application server had not reported an expired session.

The client now reports account-service unavailability for non-JSON responses in
Chinese or English, preserves the HTTP error status, and avoids expiring an
application identity based on an opaque gateway response. Application JSON
credential errors and real session-expiration handling keep their existing path.
No retry is automatic: the user can retry after the upstream recovers.

## Recovery boundary

Before a production fix can be prepared, obtain the current trusted backend
HTTPS hostname and server identity from the operator. Verify DNS, certificate
hostname/chain, and JSON health/session responses without sending credentials
to an unverified host. Inspect that server's existing service and database state
using a trusted connection before deciding whether any server change is needed.

Once the endpoint is verified, prepare the exact rewrite changes, including both
OAuth discovery routes, for review. Report any required server-origin,
certificate, DNS or OAuth changes separately. Obtain confirmation for the
concrete production/configuration actions before executing them.

After approval, verify the reviewed preview and production commit, then perform
a bounded synthetic-account smoke check through `https://imstage.org`: session
JSON, login, Secure/HttpOnly/SameSite cookie persistence after reload, logout and
login again. Reject a wrong Origin and preserve authentication protections.
Do not run the full write-heavy suite against production or paid model evals.

## Local verification

The failing regressions were observed before the client fix: the HTML error used
the generic message, and the HTML 401 expired a bound identity. The same focused
client regressions pass after the fix. The existing local auth baseline passed
36/36 tests, covering login, cookies, persistence, origin checks and throttling.

Final local verification passed:

- `npm test -- --test-concurrency=2`: 712/712, zero failures or skips.
- `npm run build`: TypeScript and production Vite build passed.
- `IMSTAGE_TEST_PORT=4496 IMSTAGE_ARTIFACT_DIR=.local/login-evidence/browser npm run test:ui -- tests/ui/account.spec.ts --workers=1`: 12/12.

Browser coverage includes a synthetic HTML 403/421 followed by a successful retry
against the real isolated local account server, real login/logout, password
changes, account isolation and light/dark accessibility. It is not proof of
production login recovery. Test databases/logs remain ignored under `.local/`.
