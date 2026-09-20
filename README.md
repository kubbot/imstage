# IMStage

Open-source conversation scene creation for the Web, MCP, and API.

**Status: early development. A local evaluation/annotation tool is available; the production conversation renderer, API and MCP service are not implemented on this baseline.**

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

The product directories above remain reserved on this baseline. The independently runnable evaluation tool lives in `tools/eval/`.

## Local evaluation lab

Use Node.js 22 or later:

```sh
npm --prefix tools/eval ci
npm --prefix tools/eval start
```

Open `http://127.0.0.1:4421` to create cases, upload inputs and actual PNG outputs, label quality, and explicitly approve golden images. Data stays in ignored `.local/eval/`. Git/CI exports are limited to explicitly synthetic, reviewed cases.

```sh
npm --prefix tools/eval test
npm --prefix tools/eval run selftest
```

The **Eval harness** GitHub workflow checks the evaluator using positive and negative synthetic controls across Linux, macOS and Windows. It does not certify an unconnected production renderer. See [evaluation design](docs/evaluation.md) and [tool and manifest reference](tools/eval/README.md).

## Current scope

- Establish the open-source repository and contribution conventions.
- Initialize a Vercel project without publishing an application.
- Initialize an Open Design project and its brief without generating UI.
- Initialize a ChatGPT project with shared instructions and product context.

Roadmap items are proposals and are not delivery commitments. See [initialization scope](docs/initialization.md).

## Responsible use

Generated scenes are intended to be simulations, not evidence of real conversations, identity, payments, or transactions. Use synthetic or authorized assets. Platform names and visual conventions belong to their respective owners; IMStage is an independent project.

## License

[MIT](LICENSE) © 2026 IMStage contributors.
