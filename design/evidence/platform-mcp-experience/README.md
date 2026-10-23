# Platform and MCP evidence

2026-10-23. Synthetic content only.

| File | Observed surface |
| --- | --- |
| parent-desktop-whatsapp.png | Main-agent browser, local desktop 1440x1000; WhatsApp selected, real shared SceneView. |
| parent-mobile-instagram.png | Main-agent browser, local 390x844; compact platform strip and Instagram DM preview. |
| parent-english-dark.png | Main-agent browser, English/dark full page with the selected preview and existing gallery. |
| parent-handoff-instagram.png | Main-agent browser, new creator session preserving Instagram and four example messages. |
| local-bridge-long-dark.png | Main-agent browser, v3 local MCP Apps bridge with a real 390x2808 PNG. Visible label explicitly distinguishes this from ChatGPT host acceptance. |
| web-export-instagram.png | Actual 1206x2622 PNG downloaded from the creator. |
| live-mcp-wechat.png | Actual independent MCP output from the existing runtime, 390x844. |
| live-mcp-whatsapp.png | Actual independent MCP output from the existing runtime, 390x844. |

The live MCP runtime used v2 and was separate from the public account backend.
A later long-image call timed out. These images do not prove a v3 deployment,
account connection or real-host edit/download acceptance. Protocol-harness
layout fixtures are deliberately excluded from product evidence.

See ../../platform-mcp-experience-acceptance.md for commands and remaining gates.
