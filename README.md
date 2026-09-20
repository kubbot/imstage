# IMStage

Open-source conversation scene creation for the Web, MCP, and API.

**Status: project initialization only. No application, API, MCP server, or rendering engine is implemented yet.**

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

These directories are placeholders, not runnable packages. There are no install, development, build, or deployment commands yet. Frameworks and infrastructure dependencies will be selected when implementation is authorized.

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
