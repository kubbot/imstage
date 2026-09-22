# IMStage MCP

A private, persistent ChatGPT creation and follow-up editing service. ChatGPT authors the content; IMStage validates, saves, applies precise patches, and renders it with the same `SceneView` and CSS as the Web editor. No second model/provider API call is made.

```sh
npm ci
npm run build:mcp
IMSTAGE_MCP_DATA_DIR=/absolute/private/imstage-mcp IMSTAGE_MCP_TOKEN='<local secret>' npm run dev:mcp
```

The service binds `127.0.0.1:4421/mcp` (override `IMSTAGE_MCP_PORT`). Use a secret environment file for normal operation instead of putting the token in shell history. The active Web/API database is never opened.

Sixteen tools cover scene creation/editing/rendering, reusable templates, project rules and deterministic batch creation. Mutations return a stable scene ID and revision. Updates are atomic and reject stale revisions. Idempotency keys make retries safe; reuse the same key with exactly the same arguments. A render returns real PNG content and a `ui://` MCP Apps preview with a follow-up field and host-mediated download.

Create a project, save a template with typed name/photo variables, then call `imstage_create_batch` with independent items. A batch validates every item before saving all outputs in one transaction; its receipt freezes the rules and template revision. The calling AI supplies the content and images. See [schemas, workflow and limits](../../docs/templates-and-projects.md).

The supported platforms and message types match the Web studio. Bounded custom layouts use the same renderer. Original-screenshot overlay editing is explicitly rejected in this MCP release. Media cards are static representations, not playable audio/video. Templates are visual approximations, not certified platform replicas.

`npm run test:mcp` builds the shared static renderer, exercises the real SDK HTTP client, and tests the widget in Chromium. Run `npm run build` for frontend/type validation. See [ChatGPT installation and acceptance](../../docs/chatgpt-mcp.md) and [reference decisions](../../docs/mcp-design-decisions.md).
