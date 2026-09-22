# Creator experience — direction and delivery gates

2026-09-23. User-authorized implementation, including deployment and merge after applicable checks.

## Product invariant

The visitor is a creator, designer or developer who needs a believable chat scene, then a series of related scenes. Their tension is not finding a pretty screenshot: it is retaining control over dialogue, people, imagery and layout while changing a few things repeatedly. They should understand that an instruction becomes editable structured content, feel able to shape it, and submit their own request immediately.

The defensible product truth is one scene contract rendered by Web and MCP, with local editing, deterministic export, reusable templates and explicit per-item differences. A landing animation is an authored demonstration; only a submitted instruction starts a real Agent run. Neither model compliance nor screenshot reconstruction is pixel-perfect by definition.

## Evidence and bounded direction tree

Baseline desktop, mobile, later sections and the English workspace were captured under the private creator-flow evidence folder. The existing shared renderer and working PNG export are strengths. The large tinted device container, playback controls, oversized workspace labels and slogans hide the useful mechanics. The English workspace still shows Chinese controls. Functional reliability and visual judgment are separate gates.

**Theorem A — one scene becomes a series.** An open editorial composition keeps one editable scene beside a short sequence: describe → refine → vary. Its signature is a scene that changes meaning as the visitor scrolls, then opens into independent variants. Content first, restrained typography, no dashboard card wrapper. Anti-reference: a video landing page with decorative progress bars.

**Theorem B — a creator's sheet.** A centered prompt opens a broad working sheet and a contact sheet of variations. Spatial grammar is a notebook with margins, not a marketing funnel. Its signature is a page expanding into a collection. Anti-reference: generic SaaS feature cards.

For A, architecture A1 keeps one scene pinned alongside the input and two short chapters, then changes contrast for templates; architecture A2 begins with a centered prompt and expands into a wide canvas/contact sheet (the surviving B challenger). Both were rendered at 1440×900 and 390×844, with first viewport and representative middle sections.

**Selection: A1.** A makes the scene legible in the first viewport, keeps the input prominent, and can connect scrolling directly to editing and variation. B puts most product proof below the first desktop fold and repeats a container around an already contained phone. Preserve B as a challenger, do not combine both into a crowded hero. Prototype rows reused one export to test composition only; production variants must actually differ and cannot imply generated results from those placeholders.

## Implementation system

- Warm paper, dark ink, existing rust accent. Use the existing theme tokens for dark mode.
- Desktop title 64–76 px; mobile 40–46 px. Workspace body 13–14 px, secondary labels at least 12 px.
- The hero input and submit are one compact composer. Keep the visitor's draft across locale changes and handoff.
- Three readable scroll chapters. Use IntersectionObserver for discrete narrative state, native scroll-driven CSS for optional continuous transforms, and static readable fallbacks. No timers pretending to generate, no scroll-jacking, no playback controls.
- Show the real SceneView. Chapter two highlights an actual message and exposes a meaningful edit; chapter three shows independent scene variants. Keep photo enlargement and real PNG export discoverable without competing with Send.
- Mobile has a natural reading order and bounded scene scale; no overflowing three-phone fan. Reduced motion removes transforms and staged concealment without hiding content.
- Examples represent concrete jobs: narrative, product support, localization, onboarding, evaluation variants and event coordination. Use actual editable fixtures, concise labels and focused actions.

## Shared product model

A template is a versioned scene snapshot with typed named variables. It can preserve a structured custom layout or a reference screenshot with explicit editable regions. Creating a template is an intentional reusable snapshot, while editing ordinary scenes and people autosaves.

A project stores common instructions and defaults. A batch freezes the template and rules, then combines them with per-item variables and instructions. New results have independent scene IDs. Name/avatar/photo replacements are explicit targets, not fragile string substitution.

Web account data remains account-scoped. The current MCP server is an authenticated instance workspace with its own database; new MCP project/template/batch tools stay in that boundary. The calling AI supplies structured content/variants to MCP. Web generation uses the existing Agent runtime and limiter. Do not silently attach an instance bearer token to a Web user's private database.

Custom layouts use bounded declarative tokens in the shared Scene contract, never arbitrary HTML, JavaScript or CSS. Screenshot reconstruction and source-preserving edits remain distinguishable in the UI and docs.

## Mechanism references

- [Linear](https://linear.app/): show the product workflow rather than a repeated feature list.
- [iPhone Air](https://www.apple.com/iphone-air/): retain one focal object while changing what the viewer understands.
- [Notion project templates](https://www.notion.com/en-us/templates/category/projects?nxtPslug=projects&paid=free): reusable working structures, not decorative presets.
- [Notion offline behavior](https://www.notion.com/help/use-pages-offline): distinguish local durability, cloud acknowledgement and conflicts. Notion's documented offline mode is desktop/mobile; this is not a claim about its Web implementation.
- [MDN scroll-driven animations](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Scroll-driven_animations): progressive enhancement for scroll-linked presentation.

## Acceptance checklist

- [ ] GitHub icon, full useful EN/ZH interface, compact left workspace, no filler banner.
- [ ] Explicit homepage submit reaches one fresh session and runs once, including login; reload cannot replay an uncertain paid run.
- [ ] Local durability, automatic cloud scene and contact updates, clear offline/conflict/recovery, identity isolation.
- [ ] Templates can be created, reused and edited; custom layout and screenshot-derived workflow are real.
- [ ] Project variants and MCP project/template/batch tools persist independent outputs with bounded validation.
- [ ] Scroll narrative, desktop/mobile/dark/reduced-motion evidence and real interaction.
- [ ] Relevant tests, independent review, exact-head CI, actual deployment and merge readback.
