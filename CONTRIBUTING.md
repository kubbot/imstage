# Contributing

IMStage includes a React website/browser-local conversation editor and a separate local Eval workspace. Eval has server-side DeepSeek generation, annotation and screenshot benchmarks; the website has not been connected to that runtime. Hosted backend, billing and live MCP/API remain future phases.

1. Open an issue describing the problem, intended behavior, and scope.
2. Agree on the scope before adding runtime dependencies or major architecture.
3. Work on a branch and open a focused pull request.
4. Include verification evidence appropriate to the change and document unresolved limitations.

Use English or Simplified Chinese. Be respectful and discuss ideas rather than people. Use synthetic or authorized examples; omit credentials, personal conversations, and private screenshots.

Run `npm run build` and `npm test` for frontend changes. Use `npm run test:ui` for changed browser behavior; it defaults to local Google Chrome. See [run instructions](README.md#run-and-verify) and [verification coverage](design/VERIFICATION.md). Keep screenshots and fixtures synthetic, check both themes and mobile layouts, and distinguish local verification from CI or deployment.

For Eval changes, run `npm --prefix tools/eval ci`, `npm --prefix tools/eval test` and `npm --prefix tools/eval run selftest`. Follow [the evaluation design](docs/evaluation.md): use synthetic fixtures, preserve human approval provenance, and never refresh golden images automatically to make a failed comparison pass. The Eval harness workflow tests the infrastructure, not a production renderer.

Contributions are provided under the repository's MIT license.
