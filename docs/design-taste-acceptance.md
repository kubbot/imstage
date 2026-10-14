# Conversation atelier design acceptance

Design work began 2026-10-14. Implementation and verification continue on 2026-10-15. Direction and A/B rationale: [design record](../design/TASTE-2026-10.md). This record distinguishes local verification from production delivery.

## Changes

- The homepage introduces a real editable synthetic sample on a worktable. Its quick reply editor shares Scene state with the existing edit chapter, PNG export and a separate “Keep editing” handoff. The primary Send/Create action still deliberately starts a fresh AI task.
- The phone width responds to viewport height. A complete sample and its export action fit the 1280 × 720 desktop first viewport. Mobile uses document flow, with readable fields and no overlapping note. Reduced motion keeps the scene static.
- A fixed featured sample sits above eight stable scenario choices. Selecting a sample no longer moves the chosen control into another row. Scroll reveals fade without translating the interactive sections.
- One adaptive semantic palette, typography, materials, borders and focus rules cover the website, AI creation workspace, manual editor, projects, platform choices, template library, saved works, account, preferences, connections and docs. Output chat skins remain independent of these outer UI rules.
- Mobile navigation opens to its links; Escape closes it and restores focus. Login decoration uses the real synthetic renderer and follows Chinese/English. Consent and legal text are preserved.
- Account/project/connection views load by route using [React lazy/Suspense](https://react.dev/reference/react/lazy). The measured main JS chunk changed from 546.61 kB (174.31 kB gzip) before this loading adjustment to 441.57 kB (144.49 kB gzip), including the route-load recovery UI. These are build sizes, not measured LCP/INP or real-device speed claims.

## Product contracts

No backend, provider, schema, licensing or billing change. Session persistence, autosave, navigation protection, undo, platform selection, cropping, watermark preference, synthetic disclosure, policy validation and deterministic export continue to use the existing contracts. Browsing examples and continuing an edited example do not invoke a model. Existing restrictions on payments and screenshot reconstruction remain in place.

## Verification ledger

- TypeScript and production build passed locally.
- Core tests: 634 passed, zero failures, with two test processes to control local resource use.
- An initial 118-case browser run produced 116 passes and two failures in the new regressions. One exposed movement from the scroll-reveal transform; recorded before/after transforms changed while scroll position and element height remained identical. The second exposed an unavailable local OCR binary, so export verification now compares the actual decoded PNG pixels before/after the reply edit, validates disclosure pixels and checks the exact text in both preview and the continued workspace.
- The final relevant browser rerun passed all 118 cases with one worker, including the three new design regressions and mobile keyboard navigation. It covers homepage/editing/export, responsive layouts, accessibility, account, preferences, project defaults, templates and connections.
- Independent review, current-head CI, merge and production readback are pending.

## Deployment limitation observed before this change

The existing production account API returned HTTP 421, and Agent capability reads failed. The configured upstream also presented a different SSH host identity and an HTTPS certificate that did not match the configured address. Host verification was not bypassed. A confirmed current upstream endpoint has been requested from the owner. Frontend preview and local acceptance can proceed; production account/AI acceptance requires this condition to be resolved or explicitly recorded as still unavailable.

## Taste and testing limits

Visual evidence compares the prior website, two rendered directions and successive implementation revisions. These are design judgments and browser simulations, not proof of objectively surpassing another brand, conversion gains, real-phone Safari behavior, screen-reader usability or sustained frame rates. No absolute self-authored quality score is used.
