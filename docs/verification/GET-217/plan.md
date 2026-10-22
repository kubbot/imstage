# GET-217 platform support implementation plan

Goal: add X, Jike and Threads synthetic direct-message templates and verify Xiaohongshu through the existing conversation editor and real PNG export. Public feeds, account publishing and brand-perfect cloning are outside the chat-scene contract.

Architecture: one framework-neutral platform catalog feeds scene validation, localized selectors, Agent enums and MCP capabilities. Bounded adapter tokens determine the social chat chrome in React and deterministic HTML; the MCP PNG renderer compiles the same React view.

Constraints: retain existing platforms, synthetic content, default disclosure, custom-layout override and all safety controls. No paid provider or new credentials. Use this isolated branch only.

1. [ ] Catalog and tools: add failing platform round-trip/tool/renderer tests, implement shared catalog and propagate selectors/capabilities. Reject unknown platforms.
2. [ ] Rendering: add four explicit social-chat adapters, distinctive header/composer/avatar/bubble treatments; preserve content, custom appearance and watermark. Verify long multilingual text, media and width bounds.
3. [ ] Acceptance: use real browser editor actions and downloaded PNGs for each requested platform, plus narrow/long variants. Save inputs, operation log, assertions and outputs. No API interception for acceptance.
4. [ ] Independent review; fix and reverify confirmed P0/P1. PR and newest-head CI, merge and deploy the same commit. Repeat production acceptance before Linear Done.

Review focus: unknown platform rejection; existing-scene compatibility; custom layout override; CJK/long token wrapping and media bounds; preview/export consistency and disclosure.

## Frozen LLM judge protocol (before implementation/evaluation)

Independent native Codex sub-agent evaluates actual final PNGs plus browser evidence, not source promises. Record the inherited model identity (or unavailable exact identifier), invocation count, complete raw findings, per-case/category scores and failures. No external API/key.

Cases per platform: A standard 390px bilingual exchange with explicit synthetic labels and quote; B narrow 320px long text/unbroken token plus image/album; C long export with system state, voice transcript and media cards. UI actions cover platform selection, message edit, undo, refresh persistence and PNG download. Existing WeChat/WhatsApp regression included separately.

Each case: platform-specific information hierarchy and coherent chrome 20; typography/wrapping/contrast/spacing 25; exact content/media fidelity and completeness 25; export consistency/bounds/absence of artifacts 20; editing and recovery evidence 10. Deduct for every observed defect. Missing evidence is unverified, never automatically passing. Any clipped/overlapped content, false capability, absent requested platform, or broken export is a blocking defect regardless of total. Success requires every designated case >=98/100, no blocking defects, independent code review, CI and production acceptance. Do not lower weights, remove failing cases or round up scores to meet the threshold. Preserve all attempts. Fix only evidence-backed issues and rerun affected cases.

Status: preflight verified at b34ac2f, issue In Progress and no dependencies. Existing dependency lock is identical to the shared read-only installation; reuse via local symlink. All prior services remain untouched. Test artifacts: registered GET-217 directory, copied formal evidence here before cleanup.
