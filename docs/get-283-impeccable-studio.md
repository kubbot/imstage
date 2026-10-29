# GET-283 — Impeccable scene studio refinement

The result card opens with the whole conversation image, including long images. Editing and download sit directly below it. Reading at full width or original size remains available under “查看尺寸”; only those explicit modes introduce a keyboard-scrollable reading region. Scene identifiers and revisions stay under “更多”. Failed images and rejected follow-up requests retain their existing recovery behavior.

The connection page uses a compact client picker and offers a direct route to the web studio. Account setup puts save and skip before avatar fields, uses a live SceneView preview and removes redundant card containers. The empty canvas explains the next action and returns to the AI input even when the creator previously opened the element list. Existing account, draft, undo, platform, theme, watermark and export boundaries remain intact.

## Impeccable workflow

Installed the official [Impeccable 4.8.0 skill](https://github.com/pbakaus/impeccable) with `npx impeccable install --providers=cursor --scope=project`. The direct skill-bundle download failed its TLS connection; the same official release bundle and detached signature were downloaded through GitHub's API and passed to the official installer through `IMPECCABLE_BUNDLE_PATH`. The installer verified the bundle and installed the Cursor skill, agent and hook. The optional engine pre-cache also encountered the release-download TLS failure; the npm package's platform engine was available and ran context and detection locally.

`/impeccable init` is a skill workflow rather than a terminal subcommand. Its confirmed product record is [PRODUCT.md](../apps/web/PRODUCT.md), based on the existing approved product brief, design brief and this issue. No new provider, price, runtime or visual-platform claim was invented. The selected app flow is Operate: refinement of the existing brand and Studio palette.

| Pass | Applied change |
| --- | --- |
| distill | Whole-image default, optional size controls, fewer nested setup containers |
| clarify | Action-oriented empty state and concise platform label; errors and recovery preserved |
| onboard | Early skip/save, client-specific connection instructions, web-studio entry |
| polish | 1440/768/390 px checks, input focus, keyboard reading, theme and export isolation |
| detect | Seven changed UI targets; two existing accent-border findings fixed; final result `[]` |

The context command reported no active detector hook for this Codex session, so detection was run manually. The clean scan is a mechanical result, not a human visual-quality score.

## Verification

- Production build and MCP renderer build passed. The generated renderer is unchanged.
- Complete serial host suite: **710 passed**, no failure or skip. The first run omitted the test-only MCP SSR build and failed five bootstrap checks; rebuilding and rerunning the full suite resolved them.
- Result-card suite: **12 passed**, including complete long images, opt-in keyboard scrolling, PNG download, failed image replacement, follow-up retry and theme precedence.
- Existing connection/preferences/layout/Studio browser cases: **38 passed**. New GET-283 cases: **5 passed** on the final source, including return from the element list and immediately reachable skip. The initial mobile assertion checked a button after its panel had intentionally closed; its ordering was corrected.
- Existing Studio cases downloaded real WeChat, Xiaohongshu and Jike PNGs and checked disclosure, dimensions and identical artwork pixels across site themes. No platform skin was changed.
- Independent agent review found one P2 input-tab restoration bug; fixed, covered and independently rechecked. No unresolved P0/P1. `git diff --check` passed.

Browser plugin was unavailable; validation used the repository's Playwright workflow with one worker. All data is synthetic, accounts/database are local and disposable, and model/image requests were mocked or absent. Screenshots and raw results are in [the evidence directory](verification/GET-283/evidence/). Only result-card before/after images compare the same rendered conversation against the original and changed widget implementations; other images show the final web UI.

## Release status and limits

PR, latest-head CI, merge and frontend production readback are recorded in the linked issue and release receipt once available. No paid evaluation was run. The final diff does not match the paid DeepSeek workflow paths: it changes `services/mcp/widget.mjs`, not `services/agent/**`, `packages/**` or the workflow.

Backend publication is blocked by SSH host-identity mismatch on the existing deployment target. Both the default ED25519 negotiation and the already-known ECDSA algorithm failed strict host-key verification. Trust records were not changed and no remote command ran. The backend requires identity confirmation from a trusted server console before publishing the changed MCP card. Frontend publication cannot establish that the live MCP runtime has updated.

No version-specific WeChat/Xiaohongshu screenshot gold standard was supplied. Their existing chat styles and Linear-like compact controls are qualitative references; native pixel equivalence, real host-app acceptance, paid generation and complete live OAuth/account flow are not claimed by these synthetic checks. GET-283 remains incomplete until the required production acceptance is finished.
