# IMStage

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Creators preparing synthetic conversations for product demonstrations, teaching, test datasets and evaluation. GET-283 asks for a social content studio with the artwork at the centre of the workflow.

## Product Purpose

Connect an AI client, optionally choose account defaults, create a synthetic conversation, then edit and download the same work. The website also supports local manual editing and export without a model call.

## Operating Context

React + Vite frontend, existing account API and independent MCP service. Web and MCP reuse the conversation contract and deterministic renderer. The creator can work in light, dark or system site themes; the Studio retains its existing neutral dark shell, while artwork uses its own platform colours.

## Capabilities and Constraints

- Preserve client-specific OAuth instructions, explicit consent, real connection status, retry and disconnect. Optional onboarding must not block OAuth.
- Preserve account isolation, browser drafts, recovery, undo, template switching, local editing, PNG export and optional watermark preferences. Account defaults never rewrite existing artwork.
- Synthetic content disclosure defaults on. Public reference-screenshot editing and payment messages remain disabled. Source remains non-commercial; no billing or new provider is introduced here.
- Provider credentials remain server-side. Unconfigured, failed and cancelled generation must remain visible. Synthetic browser tests do not establish real paid-provider or host acceptance.

## Brand Commitments

Keep IMStage's existing identity and restrained neutral/warm-accent system. GET-283 names WeChat/Xiaohongshu chat imagery and Linear's compact interaction density as qualitative references, without authorizing a pixel-clone claim.

## Evidence on Hand

Confirmed scope: `../../docs/product-brief.md`, `../../design/BRIEF.md`, and GET-283. Existing code and `../../docs/get-256-studio-chrome.md` establish the incumbent UI. No version-specific chat screenshot gold standard was supplied.

## Product Principles

- Show the complete artwork before optional technical details.
- Keep creation, editing and download adjacent to the work.
- Make setup optional where existing defaults suffice.
- Preserve truthful states and a recoverable next action.

## Open Decisions

Pricing, public-directory installation, provider budgets and exact native-platform visual certification are outside this change.
