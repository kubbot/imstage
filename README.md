# IMStage

Open-source conversation scene creation for the Web, MCP, and API.

**Status: runnable React website and local conversation editor, plus a separate note-first Eval workspace with DeepSeek generation, private screenshot benchmarks and human review. The website does not yet share the Eval generation runtime; hosted API and MCP remain unconnected.**

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

`apps/web/` is runnable (React + TypeScript + Vite). The Eval schema/renderer is implemented separately; the frontend renderer is currently local to the web app.

## Run and verify

Requires Node.js 22.x (verified with 22.23.2). Run from the repository root:

```sh
npm ci
npm run dev             # http://127.0.0.1:4417
npm run build
npm run preview         # same port; stop the dev server first
npm test
npm run test:ui         # Google Chrome is the default test browser
```

For bundled Chromium: `npx playwright install chromium`, then `IMSTAGE_BROWSER=chromium npm run test:ui`. On this development Mac, use `dev-storage-guard new-artifact imstage-ui` and set `IMSTAGE_ARTIFACT_DIR` to the returned directory before UI tests.

Website: `/`; prompt-first creation: `/#/create`; editor: `/#/studio`; scene library: `/#/templates`; usage and integration status: `/#/docs`. The default theme follows the system; light/dark overrides persist locally. See [design review](design/REVIEW.md) and [verification](design/VERIFICATION.md).

See [prompt-first design and generation boundary](design/PROMPT-FIRST.md) for the new streaming Mars example, asset provenance and provider limitations. The local example replays authored content; arbitrary live AI generation is not connected.

The shared schema and deterministic renderer are implemented for the Eval path; other product integrations remain separate. The independently runnable evaluation tool lives in `tools/eval/`.

## Local evaluation lab

Use Node.js 22 or later:

```sh
npm --prefix tools/eval ci
npm --prefix tools/eval start
```

Configure a server-side `DEEPSEEK_API_KEY` (see the tool reference), then open `http://127.0.0.1:4421`. Write a sentence or paste an image to generate a chat PNG, judge the result, and explicitly approve a golden. WeChat / iOS / normal screenshot are defaults; target options remain optional. Data stays in ignored `.local/eval/`. Git/CI exports are limited to explicitly synthetic, reviewed cases.

```sh
npm --prefix tools/eval test
npm --prefix tools/eval run selftest
```

The **Eval harness** GitHub workflow checks the evaluator using positive and negative synthetic controls across Linux, macOS and Windows. It does not certify an unconnected production renderer. See [evaluation design](docs/evaluation.md) and [tool and manifest reference](tools/eval/README.md).

The private screenshot dataset is available at `/dataset.html` in the Eval server. See [screenshot evaluation and CI](docs/screenshot-evaluation.md).

## Website scope

The browser editor supports synthetic templates, per-message editing, participants and local images, undo/redo, versioned local drafts, and PNG/JSON downloads. Normal PNG export is 360×640 logical pixels at 2× resolution; long export includes all content. The scene data drives both preview and export.

UI templates are **visual approximations**, not certified replicas of a specific platform version. For the website, arbitrary live generation and screenshot recognition remain unconnected; accounts, hosted persistence, charging and live MCP/API are future work. The static frontend is deployable to Vercel; see [deployment and verification](docs/deployment.md).

## Responsible use

Generated scenes are intended to be simulations, not evidence of real conversations, identity, payments, or transactions. Use synthetic or authorized assets. Platform names and visual conventions belong to their respective owners; IMStage is an independent project.

## License

[MIT](LICENSE) © 2026 IMStage contributors.
