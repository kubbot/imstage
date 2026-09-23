# GET-47 — artwork result card

The MCP result card keeps the complete PNG visible at its natural aspect ratio, with a height limit and no enlargement above its intrinsic resolution. Readers can choose fit width for long images or original size for detailed inspection. Technical identifiers remain in More → Artwork information. Edit, download and further actions share one toolbar; a compact prompt and shortcuts use the host's follow-up mechanism.

Editing opens the account-owned scene through the host's external-link capability, or reveals a safe HTTPS link when that capability is unavailable. Standalone scenes keep in-conversation editing. Avatar/style/mark editing uses the existing Web editor; the card does not claim unsupported native controls. IMStage cannot change the host's brand row or code controls.

Missing or failed render results clear the previous image and download target. Failed follow-ups retain their draft and permit retry. Host acceptance is described as waiting for a result, never as a completed edit. Downloads capture the displayed render and do not open a stale asynchronous upload after a newer result arrives.

## Verification

- `node --test tests/mcp-widget.test.mjs`: 6 passed, including actual browser bridge, legacy OpenAI metadata, aspect ratio, stale-result clearing and rejected follow-up recovery, non-result host updates and asynchronous download races.
- Synthetic desktop and 390 px screenshots inspected locally; production/real host acceptance remains a separate delivery step.

## Sources

- [OpenAI component bridge](https://developers.openai.com/plugins/reference#windowopenai-component-bridge): feature detection, follow-up messages and external links.
- [MCP Apps open-link request](https://apps.extensions.modelcontextprotocol.io/api/interfaces/app.McpUiOpenLinkRequest.html): `ui/open-link` with a URL.

Independent review found three P2 issues (host globals, mobile menu bounds, stale download status). All were fixed, covered by regression tests and independently rechecked; no P0/P1 remain in the card review.
