# Contributing

IMStage is in early development. The local Eval tool is independently runnable; production rendering and service boundaries remain under design.

1. Open an issue describing the problem, intended behavior, and scope.
2. Agree on the scope before adding runtime dependencies or major architecture.
3. Work on a branch and open a focused pull request.
4. Include verification evidence appropriate to the change and document unresolved limitations.

Use English or Simplified Chinese. Be respectful and discuss ideas rather than people. Use synthetic or authorized examples; omit credentials, personal conversations, and private screenshots.

For Eval changes, run `npm --prefix tools/eval ci`, `npm --prefix tools/eval test` and `npm --prefix tools/eval run selftest`. Follow [the evaluation design](docs/evaluation.md): use synthetic fixtures, preserve human approval provenance, and never refresh golden images automatically to make a failed comparison pass. The Eval harness workflow tests the infrastructure, not a production renderer.

Contributions are provided under the repository's MIT license.
