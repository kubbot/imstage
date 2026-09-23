# Screenshot avatar fidelity — 2026-09-21

Structured screenshot reconstruction now prefers `extract_image` over text-only image generation. The tool binds original uploaded pixels to a participant, message/album item or background after normal scene/scope validation. It uses attachment indices rather than model-supplied image data or URLs, respects EXIF orientation, bounds decoded size/crop geometry, and returns a labeled source preview for visual verification.

For avatars, existing source-pixel side-avatar detection refines approximate model coordinates to the complete square. Ambiguous/missing matches return candidate boxes for another selection; they never silently choose the first person. Unsupported layouts fall back to the requested near-square crop and visual verification. This is not universal avatar detection.

With screenshot attachments, generating a missing avatar without first extracting its reference is rejected. Enhancement forwards the retained avatar to the existing image-edit provider, with instructions to preserve the visible subject, features, pose, composition, background and colors. Landscape/illustration avatars remain landscape/illustration. Explicitly requested new avatars and text-only scene creation still work. Unresolved extraction failures cannot be reported as completed tasks.

## Evidence

- `npm test`: 304 passed; `npm run test:eval`: 193 passed; `npm run build`: passed.
- Focused source tests: 10 passed, including exact source pixels, scope isolation, cancellation, invalid/ambiguous crops, EXIF rotation, failed-tool completion prevention, and exact reference-image bytes passed to the provider.
- Live DeepSeek Flash run with the committed synthetic iPhone screenshot `evidence/visible-crop/export.png`: succeeded in one extraction, no image generation. The saved 120 × 120 avatar is pixel-identical to its source rectangle. See `evidence/source-avatar/result.json` and `crop.png`.
- An earlier live probe exposed inaccurate model crop coordinates. Source edge calibration fixed this observed case; tests retain the approximate-coordinate regression.

The live check proves original-pixel reuse in this synthetic case. Reference forwarding is tested independently; this change does not claim a live generated portrait similarity score or recovery of details absent from the source. No private user screenshot is included in this evidence.
