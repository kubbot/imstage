# GET-318: Google sign-in

The user requested Google login for IMStage users and production deployment. The
implementation choices below are agent decisions under the user's autonomous
delivery instructions. Existing password accounts, six-character passwords and
saved works remain usable.

## Approach

Use the Google Identity Services (GIS) popup button and verify its ID token on
the Node backend with Google's supported `google-auth-library`. Issue the same
SQLite-backed IMStage session used by password login. This needs a dedicated Web
client ID and the canonical JavaScript origin, not a Google client secret or
Google API access token.

A custom authorization-code flow would add redirects, PKCE and a client secret
without adding a needed capability. Moving authentication to Firebase or another
host would introduce an account migration. Neither is needed for this request.

References: [GIS](https://developers.google.com/identity/gsi/web/guides/overview),
[server verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token),
[JavaScript API](https://developers.google.com/identity/gsi/web/reference/js-reference).

## Identity and persistence

- Google `sub`, not email, identifies the Google account. Require verified email
  and validate signature, issuer, audience, expiry and the issued nonce.
- Do not auto-link an existing local email. Tell its owner to sign in with the
  existing password and explicitly link Google in account settings.
- Linking requires the current password and the same live IMStage session when
  Google verification finishes. A Google subject can belong to one user, and a
  user can link one Google subject. Conflicts never replace either association.
- New Google users accept the existing terms before account creation. If consent
  was not given yet, keep a ten-minute server-side pending registration and show
  the verified profile with a consent form. Never persist an ID token.
- Add identity/flow tables without rebuilding `users`. Google-only users use an
  explicit unusable password-hash marker. Password login pays its normal dummy
  hash cost for those users, and account settings state that no password is set.
- Unlinking requires a password and revokes that user's sessions. Reject removal
  of the only sign-in method. Google profile/email changes do not rewrite the
  IMStage user's email or move their works.

## Browser flow and races

1. The public config endpoint reports availability; an unconfigured provider has
   no active login button and does not load Google's SDK.
2. A singleton IndexedDB readwrite transaction creates a random browser auth
   context shared by tabs, resolving only after transaction completion. All
   first-party auth mutations obtain it before fetch and send it in
   X-IMStage-Auth-Context. Reuse a resolved in-memory context after storage errors.
   A client that never obtained one can retain legacy password login, but cannot
   start Google login or claim equivalent cross-tab race protection.
3. Capture the durable context epoch before any await, including body reads and
   password verification. A challenge CAS-advances it and issues a random nonce
   plus an independent HttpOnly cookie named for that flow. SQLite stores their
   hashes, context/epoch, purpose, initial session binding and ten-minute deadline.
4. GIS receives the nonce and returns a credential to JavaScript. Send it only
   in a same-origin JSON POST with the existing mutation guard. Do not put it in
   URLs, browser storage or logs. Do not enable One Tap/automatic account choice.
5. Claim a flow once before asynchronous verification, retain it while verifying,
   then recheck its stage, deadline and session binding inside the commit
   transaction. Password login/registration also capture/CAS their epoch. A newer
   challenge or successful auth mutation invalidates older flows. Logout is
   cancellation and revokes its context even if a concurrent login completed
   while the logout body was being read.
6. Associate sessions from both login methods with their browser context until
   session expiry/revocation, independently of flow TTL. An additive nullable
   sessions column is sufficient; do not rebuild users. Epoch advancement revokes
   old context sessions, so late cookies can reference only revoked sessions.
   Link challenges keep the caller's currently proved session; legacy sessions
   can acquire context ownership when seen on a first-party auth mutation.
7. Cancel carries the original flow ID and affects only that flow. Flow-specific
   cookie names prevent late cleanup from clearing a newer flow's cookie. GIS
   has one active page owner; old popup callbacks cannot enter a newer nonce.
8. User creation, preferences, identity binding and session issuance commit in
   one transaction. A uniqueness race never merges accounts. React ignores
   callbacks/responses after unmount or identity changes and offers an explicit
   retry after an expired flow or SDK failure.

Cookie: HttpOnly, SameSite=Strict, Secure on HTTPS, max age 600 seconds. All
mutations keep exact Origin, JSON and X-IMStage-Request checks. Challenge and
credential endpoints are rate limited. Expired flow rows are pruned and bounded.
Google certificate requests have a bounded timeout and cache public keys.

## Product surfaces

The existing login and registration pages gain the official localized Google
button. Pending Google registration uses the existing terms and a verified,
non-editable email. Existing password forms continue to work when Google is
unconfigured or unavailable. Account settings show connected Google identity,
password reauthentication for linking/unlinking, and Google-only status. Update
the privacy notice with the actual identity fields stored.

Only permit Google's documented SDK/iframe endpoints if headers require it;
preserve other security headers. Provider setup belongs to a dedicated IMStage
Google Cloud project and runtime configuration outside Git. Do not reuse another
product's OAuth client. Public production audience and real Google sign-in must
be verified separately from fixtures.

## Delivery and evidence

Implement meaningful failure/replay/account-switch tests before code, then API
integration and browser fixtures for the forms. Review this authentication change
independently. Keep fake-token UI tests distinct from signature verification and
real Google acceptance. Run host tests, build and applicable CI; merge a linked
PR, let the checked-main Mac updater publish, and verify frontend/API revisions,
real Google login, refresh, logout, saved works and password-login regression.
Keep the issue open until actual provider configuration and acceptance finish.

Creating/publishing the Google client and selecting a real Google account for
acceptance may require a concrete browser confirmation; complete the reviewable
implementation and configuration preparation before that final step.
