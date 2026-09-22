# Wukang Road: from instruction to an image message

Design read: an AI storytelling product for creators, with a candid street-photo narrative and a visible prompt-to-conversation mechanism. Native CSS, existing React renderer; variance 7, motion 6, density 4.

The former coffee hero had working local editing and reliable PNG export, but the invitation carried little tension and hid the product's AI origin. The user rejected its realism and drama. The invariant is now: see one instruction become believable dialogue, a pause, a photo, and a response; then take that editable scene into the real Agent.

## Bounded direction tree

D1 A: a director's prompt becomes a conversation on screen. Spatial grammar: prompt left, phone right, timed progress connecting them. Signature: message arrival and photo reveal. Anti-reference: a static template editor with an AI badge.
D1 B: a photo-led short story, with an inset chat and later creator controls. Signature: a photograph resolves the opening question. Anti-reference: a fashion campaign with a decorative phone.

D2 A1: process first → dialogue/photo payoff → edit/export → real Agent. A2: final result first → reverse playback → prompt. A1 wins because the requested AI sending visualization is the primary proof; A2 remains a replay/skip control rather than the main journey.

D3 parent rendered low-fidelity A/B desktop and A mobile evidence under ignored `.local/wukang/`. A wins: prompt and full conversation coexist, whereas B makes the photo dominant and the chat small/detached. Keep B as a credible later image-expansion treatment. These are layout studies; production must use the shared renderer and generated asset, not the placeholder boxes.

Reference mechanisms (not copied visual systems): [Screen Studio](https://screen.studio/) makes a controlled playback demonstrate the product; [Descript](https://www.descript.com/) relates text edits to media output; [Runway](https://runway.com/) leads with concrete visual work. Translate these into prompt → messages → image, with a clear replay boundary.

## Story and honesty

All people and dialogue are fictional. The woman is 27. The generated photograph is an illustrated scene set near Wukang Mansion, not evidence of a real meeting. Use concise visible `AI 合成示例 · 可重播` / `AI-made example · Replayable` copy. Animated progress replays this authored example; it does not claim that a paid model is running on each visit. A separate CTA opens a new real Agent session with this scene and an editable prompt, without auto-sending or overwriting previous drafts.

The scene: “你到哪里了？” → “武康路。等我，给你发张照片。” → typing/photo preparation → the passerby photo → “刚请路人帮我拍的。认得出我吗？” → “看见你了。别动，我过来。” English uses WhatsApp and equivalent natural dialogue with the same fictional adult and Shanghai location.

Motion should have a beginning and end, explicit pause/replay/show-result controls, no endless loop, and a complete static result for reduced-motion visitors. Background/offscreen playback pauses. Images have bounded same-origin loading, retry, portable data URIs for export/handoff. No decorative photo overlays in downloaded PNGs. Mobile preserves a visible CTA and useful chat preview; the image can be opened larger.

## Asset

`apps/web/public/assets/stories/wukang-evening.webp` was made with the built-in ImageGen tool on 2026-09-22 and encoded as WebP without content alteration. Prompt: a fictional 27-year-old Chinese woman, attractive, long dark hair, fitted black sleeveless midi dress and a light cardigan; waiting for a date by Wukang Mansion, Shanghai; warm evening light, plane trees, passerby smartphone framing, realistic skin and street detail, fully clothed, no UI/text/watermark. No real person's reference photo was supplied.

Functional acceptance: animation controls and cancellation, zh/en locale switches mid-playback, image failure/retry, portable photo in actual PNG and Agent handoff, prior-draft preservation, keyboard/reduced motion, light/dark/mobile. Taste acceptance remains the user's judgment, not a fabricated numerical score.
