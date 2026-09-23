# ChatGPT creation flow: implementation decisions

Checked 2026-09-21 against the installed repository and current official sources.

## Starting state

`main` at `8daa190` contains an MCP placeholder only. The isolated MCP branch starts from the already committed editor implementation `32523b0`, because it contains the active scene model and rendering work. This is a dependency branch, not proof those editor changes are merged or publicly deployed. The running editor service and its user databases are outside this task's write scope.

## Product flow

ChatGPT interprets the user's request and writes structured scene content. IMStage validates and persists it, applies explicit edits, and renders images. This MCP path does not need a second model call or an IMStage provider API key. Image generation and screenshot interpretation are separate capabilities and must not be claimed from deterministic rendering.

1. Discover supported scene fields and rendering constraints.
2. Create an identified scene from the user's requested content.
3. Render a named revision and show the visual result.
4. Resolve a follow-up against the same scene and stable element IDs.
5. Apply an atomic edit using the expected revision; render the new result.

Persist content and revisions server-side. Conversation history and widget state help select the artifact but are not the authority for stored content. Retry keys prevent duplicate writes. Revision mismatches return recovery information rather than overwriting a newer edit.

## Reference projects and patterns

- [OpenAI MCP server guide](https://developers.openai.com/plugins/build/mcp-server): focused tools, accurate annotations, structured output, stable identifiers, and concise initialization instructions.
- [OpenAI UI integration](https://developers.openai.com/plugins/build/chatgpt-ui): data operations separated from a final render tool; `_meta.ui.resourceUri` and the standard MCP Apps bridge, with optional ChatGPT compatibility extensions.
- [Official shopping cart example](https://github.com/openai/openai-apps-sdk-examples/tree/main/shopping_cart_python): retain an artifact identifier across turns and associate the widget session with it. Our persistent revisions go beyond the example's in-memory cart.
- [Official Pizzaz examples](https://github.com/openai/openai-apps-sdk-examples/tree/main/pizzaz_server_node): tools return structured results and an associated visual resource.
- [MCP Apps specification overview](https://modelcontextprotocol.io/docs/extensions/apps): keep visual interactions inside the conversation and allow bidirectional updates through the sandboxed bridge.

## Installation and acceptance

[ChatGPT connection instructions](https://developers.openai.com/plugins/deploy/connect-chatgpt) require developer-mode access plus either a reachable HTTPS MCP endpoint or a configured private tunnel. [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) can reach a loopback service without exposing the server publicly. It additionally requires a tunnel ID, a runtime credential with Tunnels Read/Use, and association with the intended ChatGPT workspace. These are account/runtime prerequisites, not properties proven by repository tests.

Acceptance must distinguish protocol tests, image correctness, live tunnel readiness, tool discovery in ChatGPT, and actual create/follow-up/render execution inside ChatGPT. None substitutes for another. Record only observed results.
