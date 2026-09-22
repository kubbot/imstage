# Wukang AI story — acceptance record

The landing page now starts with a fictional Wukang Road conversation: an
instruction becomes short dialogue, typing indicators, a passerby photograph
and a final reply. Chinese uses WeChat; English uses WhatsApp. Both use the
same fictional adult and matching synthetic portrait. The design direction
and image provenance are recorded in `WUKANG-STORY.md` and
`../apps/web/public/assets/stories/README.md`.

## Behavior and boundaries

- Nine authored beats take approximately 9.3 seconds. The visible label says
  “AI 合成示例 · 可重播” / “AI-made example · Replayable”. Homepage playback
  does not call a model or pretend to generate new content from edited input.
- Pause, resume, replay and complete-result controls are available. Playback
  pauses when hidden or off screen; a manual pause never resumes automatically.
  Reduced motion starts with the complete result. Explicit replay still pauses
  off screen, and entrance animations remain disabled.
- “Create with AI” opens a new real Agent session with the visitor's instruction,
  complete conversation, portrait and photograph. Navigation waits for portable
  assets and successful session storage. Loading/storage failures preserve the
  input and expose a recoverable error. Sending remains an explicit action.
- The instruction survives locale changes and reload. Photo zoom supports
  Escape and restores focus. Export always captures all five messages and the
  photograph as a 1206 × 2622 PNG.
- Asset reads are bounded, same-origin and converted to data URIs before export
  or handoff. Photo and avatar failures have separate retry controls.
- Existing coffee, weekend and product scenarios retain their roles and explicit
  routes. Shared SceneView, the scene contract and MCP renderer are unchanged;
  this increment requires no backend upgrade.

## Verification

- Production build passed; all 378 Node tests passed.
- Full browser suite: 126 of 127 passed initially. The remaining photo-retry
  test also blocked the new portrait because its route matched all story
  assets. Its fault injection now targets the photograph specifically; recovery
  still requires the export control to become enabled. All 18 Wukang browser tests
  passed on rerun, covering the corrected failure and recovery path.
- Independent review passed with no unresolved findings. Review verified combined
  hidden/off-screen eligibility, reduced-motion replay, durable handoff,
  localized preparation and unchanged shared rendering.
- Desktop 1440 × 900, mobile 390 × 844, English, Chinese and dark-mode captures
  were inspected. The desktop story and controls fit without clipping; mobile
  retains the primary CTA and has no horizontal overflow.
- Repository screenshots and social preview use the actual browser output.
  A recording preserves the full animation. Local production smoke verified
  bilingual PNG export, no automatic model calls, and prompt/photo persistence.

Live deployment identifiers, real Agent verification and latest-head CI state
are recorded in the PR. Visual quality is a reviewed design judgment, not an
automatically certified numerical score. The photographs depict synthetic
characters and do not document a real meeting.
