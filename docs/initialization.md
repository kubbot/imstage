# Initialization scope

## Included

- Documentation-only repository with an MIT license, contribution guide, security reporting guide, issue templates, PR template, and agent instructions.
- Reserved source directories without executable application code or dependencies.
- GitHub repository initialization.
- Empty Vercel project and Git repository connection where supported, with no product deployment.
- Open Design project, working directory, and design brief.
- ChatGPT project, project instructions, and source context.

## Deferred until explicitly requested

Website and editor implementation, visual prototypes, rendering, API/MCP endpoints, authentication, storage, provider credentials, model calls, billing, CI for application code, custom domains, and production deployment.

## Platform responsibilities

GitHub is the source of truth for maintained documentation and future code. Vercel is reserved for the future website/Web deployment; backend and rendering placement remain undecided. Open Design holds design work and handoff artifacts. ChatGPT project sources are snapshots and should be refreshed when the repository brief changes.

Machine-specific paths, private workspace URLs, IDs, and setup verification are kept in the ignored `.local/initialization.md` file, not in the public repository.
