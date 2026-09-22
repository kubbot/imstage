# Bilingual launch verification

2026-09-22. Direction A, Conversation Stage, was selected after comparing the
[editable stage and scene gallery prototypes](LAUNCH-DIRECTIONS.md). The final
page exposes a real editable line and its rendered result in the first viewport.
No aesthetic score is self-awarded.

## Visual and interaction evidence

- [English / WhatsApp](../docs/images/landing-en.png) and [Chinese / WeChat](../docs/images/landing-zh.png): actual browser captures at 1440 × 900, 2× pixel density.
- Desktop shows the complete device and caption. At 390 × 844, the primary actions and first two messages are visible; no horizontal overflow.
- The homepage, scene library, documentation, navigation and footer are bilingual. Language follows explicit URL, saved choice, then browser preference.
- Synthetic portraits are embedded as data URIs in exported and handed-off scenes. Asset failures show a retry action; failed loading cannot claim a successful export.
- Direct edits update the shared SceneView. Export produces a real 1206 × 2622 PNG. A DOM snapshot fixes the downloaded scene before asynchronous image/font work; changing the header language mid-export cannot change that file.
- The preview queue rejects stale results and renders the latest edit. Tests hold font readiness to reproduce edits and language changes during rendering, then compare PNG bytes.
- New English sessions use WhatsApp. Existing drafts survive language changes and new-session entry. The internal Agent/account editor interface remains primarily Chinese.
- Light/dark themes, reduced motion, keyboard navigation and automated WCAG A/AA checks were exercised. These checks do not replace a complete manual accessibility audit.

## Verification

- Production TypeScript/Vite build passes.
- Node model/API/Agent/MCP tests: 362 passed, zero failed.
- Evaluation harness tests: 193 passed; synthetic positive/negative controls pass. This verifies evaluator behavior, not universal screenshot reconstruction accuracy.
- Final full browser verification: 111 passed, zero failed, including download-during-language-switch.
- Independent reviews covered the deployment, integrated editor/MCP changes and marketing state handling. Confirmed issues were fixed: proxy auth bucket isolation, upload ceiling, locale entry, asynchronous PNG state and MCP authorization wording.

## Hosted verification and boundaries

The Vercel frontend uses an HTTPS rewrite to a persistent server. Live checks
passed registration, secure session cookies, save/readback, wrong-origin rejection,
DeepSeek editing, logout/login and persistence across container replacement.
A real browser signed in, reloaded, opened a saved scene and downloaded its full
PNG. An 18 MiB request reached API validation through Vercel/Nginx (this is a
transport check, not a successful image-generation request).

Authenticated MCP list/create/get/render returned a real PNG. MCP uses an
administrator-configured instance token and a database separate from Web accounts;
it does not inherit Web account access or share the Web saved-scene library.
Target-host integrations such as ChatGPT need their own client acceptance.

TLS issuance, automated certificate-renewal dry-run and consistent SQLite backups
were verified. Backups are currently on the same server, not off-host disaster
recovery. The final custom domain awaits its domain name and DNS provider.

GitHub-hosted CI is blocked before execution by an account billing lock. Local
checks and verified deployments are reported separately; the lock is not treated
as passing CI. Hosted billing, per-customer API keys and email password recovery
are not implemented. Templates are visual approximations; reconstruction can need
manual correction.
