# Website and ChatGPT onboarding

User accepted the product-led direction on 2026-09-23. This change keeps the existing story renderer and brand, removes workspace navigation from the public header, and integrates ChatGPT setup into the landing journey.

## Design decision

Read: marketing homepage for creators and teams making product demos, stories and training material. Preserve warm red accent, current typography and real scene output. Design variance 6, motion 4, density 3. Existing story scroll motion stays; the new connection section does not add decorative looping animation.

A: artifact-led split. A starter prompt is paired with a real SceneView launch-team conversation, then an explicit setup action. B: centered instruction-led section with a larger prompt and a three-step band. Both were rendered in the browser at desktop width; A also checked at 390 px. A is selected because the output category stays visible alongside the instruction; B hides the artifact and could describe any text tool. B retained only in local comparison evidence, not as a production route. This is a design judgment, not a conversion-rate claim.

Before evidence from the live site: desktop, mobile, scenario gallery, and open-source/connection section. Existing direct-edit interaction worked. The existing technical status list is replaced with a concrete connection journey. Commercial examples appear first; no invented customers, prices, results or testimonials.

## Interaction

- Homepage: no Projects/Templates/Docs top navigation, GitHub 24 px in a 44 px target. Workspace navigation remains reachable within app routes and footer.
- ChatGPT feature: authored rendered output, copyable starter prompt, link to /#/connect. No fake installed/connected state.
- Setup: public canonical endpoint from server configuration, manual add guidance, authorization, starter prompt. OpenAI directory publication is independent and is not represented as done.
- Consent: explicit Allow or Cancel; login/registration preserve the opaque request. Show the actual requesting client, return hostname, current account and scopes.
- Account: list/revoke grants, separately disclosed personal tokens. Tokens are shown once, not saved in browser storage or URLs.
- OAuth status is Authorized until a real token use is recorded. A copied URL or opened tab is not success.

## References

- https://linear.app/ (workflow-led evidence)
- https://lovable.dev/ (describe, build, refine journey)
- https://www.raycast.com/ (focused start action)
- https://help.figma.com/hc/en-us/articles/35326636109975-Use-ChatGPT-with-Figma (connect at the point of use)
- https://developers.openai.com/plugins/build/auth (OAuth account linking)
- https://developers.openai.com/plugins/deploy/connect-chatgpt (manual setup and host validation)
- https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization (resource discovery, PKCE, audience)
- https://react.dev/reference/react/useEffect (external request cleanup)

## Verification

- `npm test`: 448 passed, including OAuth replay, wrong audience, account isolation, hidden-tool rejection, delayed-body revocation and revocation during rendering.
- `connections-live.spec.ts`: browser registration preserves the OAuth return, explicit consent exchanges a real code, MCP creates a saved scene, the browser edits it, MCP reads the edit and the real renderer emits a PNG, then revocation rejects the old token (401). The callback belongs to a synthetic test client; this is not ChatGPT-host acceptance.
- Seven additional UI cases cover setup, one-time token display, cancellation, failures, two locales, mobile overflow and WCAG checks.
- Public deployment and actual ChatGPT acceptance are recorded separately after release; no directory publication is claimed.

## Visual evidence

Synthetic material only: [homepage](evidence/onboarding/home-desktop.png), [A](evidence/onboarding/direction-a.png), [B](evidence/onboarding/direction-b.png), [mobile feature](evidence/onboarding/feature-mobile.png), [setup](evidence/onboarding/setup-desktop.png). These captures show the local interface, not production or third-party acceptance.
