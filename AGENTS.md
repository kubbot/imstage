# IMStage contributor instructions

## Scope

The user authorized the runnable React frontend/website publication and an independently runnable local Eval workspace on 2026-09-20. Eval includes real DeepSeek text/image calls, deterministic rendering, a private screenshot-edit dataset and GitHub evaluation integration. The website editor and Eval are separate runtimes; do not imply the website has live AI or shared service integration. Other hosted backend, billing and MCP/API work remains separately scoped.

Read `docs/product-brief.md` and `design/BRIEF.md` before future implementation. Distinguish accepted requirements, proposals, and unresolved decisions. Directory placeholders do not constitute architecture approval.

## Collaboration

- Preserve unrelated local changes. Use an isolated worktree when necessary.
- Use `codex/<description>` branches for future work and review changes before merging.
- Never commit credentials, personal conversations, raw user screenshots, local project IDs, or account configuration. Keep local setup records under ignored `.local/`.
- Prefer synthetic fixtures and small, independently reviewable changes.
- Validate actual changed behavior. Do not claim that a placeholder, draft design, or configured service is a working feature.
- Record verification and any remaining blockers clearly.

## Future boundaries

Web and MCP/API should share one conversation contract and rendering path. AI-assisted interpretation and asset generation should remain distinct from deterministic rendering. Provider credentials must remain server-side. Actual runtimes, frameworks, protocols, and cost controls remain to be selected.
