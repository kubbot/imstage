# IMStage

Open-source conversation scene creation for the Web, MCP, and API.

**Status: runnable React website/editor with email-password accounts and a self-hosted scene library. Live AI generation, managed cloud hosting and MCP are not connected.**

[简体中文](README.zh-CN.md) · [Product brief](docs/product-brief.md) · [Design brief](design/BRIEF.md) · [Contributing](CONTRIBUTING.md)

## Direction

IMStage is planned as a shared conversation rendering service with a conversational Web editor and programmatic MCP/API access. Intended uses include product design, teaching, storytelling, and synthetic evaluation fixtures.

Planned capabilities include platform-specific conversation templates, individual and group conversations, editable participant profiles, message and device timestamps, media and location cards, normal and long screenshot export, and conversion of uploaded screenshots into editable structured data.

The public Web experience is intended to offer free use. Hosted MCP/API access is planned around account-bound keys and prepaid usage; exact quotas, AI costs, and pricing remain undecided. Self-hosting is part of the open-source direction.

## Repository map

| Path | Reserved purpose |
| --- | --- |
| `apps/web/` | Official website and Web editor |
| `packages/schema/` | Shared conversation data contracts |
| `packages/renderer/` | Deterministic scene rendering |
| `services/api/` | Hosted API boundary |
| `services/mcp/` | MCP adapter |
| `design/` | Open Design brief and future design handoff |
| `docs/` | Product scope, setup, and planning context |

`apps/web/` is runnable (React + TypeScript + Vite). The shared packages and MCP directory remain reserved boundaries; the API now provides local/self-hosted authentication and owned scenes; the frontend renderer is currently local to the web app.

## Run and verify

Requires Node.js >=22.18 <23 (verified with 22.23.2). Run from the repository root:

```sh
npm ci
npm run dev             # Web :4417 + account API :4419
npm run build
npm start               # built app + API, same port; stop dev first
npm test
npm run test:ui         # Google Chrome is the default test browser
```

For bundled Chromium: `npx playwright install chromium`, then `IMSTAGE_BROWSER=chromium npm run test:ui`. On this development Mac, use `dev-storage-guard new-artifact imstage-ui` and set `IMSTAGE_ARTIFACT_DIR` to the returned directory before UI tests.

Website: `/`; prompt-first creation: `/#/create`; editor: `/#/studio`; scene library: `/#/templates`; usage and integration status: `/#/docs`. The default theme follows the system; light/dark overrides persist locally. See [design review](design/REVIEW.md) and [verification](design/VERIFICATION.md).

See [prompt-first design and generation boundary](design/PROMPT-FIRST.md) for the new streaming Mars example, asset provenance and provider limitations. The local example replays authored content; arbitrary live AI generation is not connected.

## Current scope

The browser editor supports synthetic templates, per-message editing, participants and local images, undo/redo, versioned local drafts, and PNG/JSON downloads. Normal PNG export is 360×640 logical pixels at 2× resolution; long export includes all content. The scene data drives both preview and export.

UI templates are **visual approximations**, not certified replicas of a specific platform version. Natural-language generation, screenshot recognition, managed cloud persistence, charging and live rendering MCP/API are future work. Local/self-hosted accounts and saved scenes are implemented. The static frontend is deployable to Vercel; see [deployment and verification](docs/deployment.md).

## Responsible use

Generated scenes are intended to be simulations, not evidence of real conversations, identity, payments, or transactions. Use synthetic or authorized assets. Platform names and visual conventions belong to their respective owners; IMStage is an independent project.

## License

[MIT](LICENSE) © 2026 IMStage contributors.

## Accounts and saved scenes

`/#/login`, `/#/register`, `/#/workspace`, and `/#/account` implement real sessions and an owner-isolated SQLite scene library. Guest drafts remain in the browser until explicitly saved to an account. Account data defaults to ignored `.local/app/`. The unified Node service is separate from Vercel static deployment; OAuth, email verification and email password recovery are not configured. See [core Web/auth design](docs/core-web-auth.md) and [API configuration](services/api/README.md).
