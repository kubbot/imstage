# IMStage contributor instructions

## Scope

The repository is in early development. The user authorized the local evaluation/annotation phase in `tools/eval/`; see `docs/evaluation.md`. Other product phases, deployment and paid services still require an explicit user request. Keep Eval harness checks distinct from production renderer acceptance.

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
