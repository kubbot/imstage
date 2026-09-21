# IMStage MCP

A private, persistent ChatGPT creation and follow-up editing service. ChatGPT authors the content; IMStage validates, saves, applies precise patches, and renders it with the same `SceneView` and CSS as the Web editor. No second model/provider API call is made.

```sh
npm ci
npm run build:mcp
IMSTAGE_MCP_DATA_DIR=/absolute/private/imstage-mcp IMSTAGE_MCP_TOKEN='<local secret>' npm run dev:mcp
```

The service binds `127.0.0.1:4421/mcp` (override `IMSTAGE_MCP_PORT`). Use a secret environment file for normal operation instead of putting the token in shell history. The active Web/API database is never opened.

Five tools expose capabilities, create, read, update, and render. Mutations return a stable scene ID and revision. Updates are atomic and reject stale revisions. Idempotency keys make retries safe; reuse the same key with exactly the same arguments. A render returns real PNG content and a `ui://` MCP Apps preview with a follow-up field and host-mediated download.

The supported platforms and message types match the Web studio. Original-screenshot overlay editing is explicitly rejected in this MCP release. Media cards are static representations, not playable audio/video. Templates are visual approximations, not certified platform replicas.

`npm run test:mcp` builds the shared static renderer, exercises the real SDK HTTP client, and tests the widget in Chromium. Run `npm run build` for frontend/type validation. See [ChatGPT installation and acceptance](../../docs/chatgpt-mcp.md) and [reference decisions](../../docs/mcp-design-decisions.md).
