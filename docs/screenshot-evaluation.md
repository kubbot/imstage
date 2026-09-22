# Screenshot editing evaluation

The owner supplied 11 screenshots and concrete editing requests. They form a private dataset with an authored question, difficulty level, source analysis, explicit reference answer, localized edit regions, protected regions and allowed replacement assets for each case. The local workspace shows source, proposed reference, and actual model output side by side. Human review and confirming a golden are separate actions.

## What this evaluates

The runner sends the task, source screenshot, platform, dimensions and authorized asset metadata to DeepSeek. It does **not** send expected edits, reference images, source analysis or scores. DeepSeek returns a constrained JSON edit plan. The deterministic browser renderer overlays escaped text and fixed image frames on the original screenshot, with all network requests disabled.

This is a screenshot-editing baseline. It does not certify fresh cross-platform conversation rendering, image/video synthesis by DeepSeek, or UI fidelity beyond the edited regions. Replacement photographs were generated separately; media UI overlays and the map illustration are deterministic. Reference outputs are proposals, not automatically approved goldens. Human visual review is still required for typography, naturalness, aesthetics, localization and valid reference boundaries.

| Level | Challenge |
| --- | --- |
| 1 | A single text replacement |
| 2 | Repeated name/avatar consistency |
| 3 | Long contact names, fixed media sizes and location cards |
| 4 | Compound contact edits, mixed photo/video albums and desktop layout |
| 5 | Full visible-language localization with contact details |

Automatic checks cover output dimensions/platform, expected edit matching (normalized text or permitted variants and asset IDs), normalized-box overlap, image-frame size within two source pixels, text overflow, and pixel preservation outside reference edit regions. A required failure cannot be hidden by the aggregate score. A subset, missing key, malformed plan or failed provider call never counts as a full pass. Position matching is part of the `semantic` check in the initial scoring implementation; that name does not imply an independent semantic model judge.

## Local use

```sh
npm --prefix tools/eval ci
node tools/eval/benchmark.mjs validate --dataset .local/datasets/chat-screenshot-edits-v1
node tools/eval/benchmark.mjs render-expected --dataset .local/datasets/chat-screenshot-edits-v1 --out .local/eval/benchmark
# Supply DEEPSEEK_API_KEY through a protected server environment.
node tools/eval/benchmark.mjs run --dataset .local/datasets/chat-screenshot-edits-v1 --out .local/eval/benchmark
node tools/eval/server.mjs
```

Open `http://127.0.0.1:4421/dataset.html`. Select a case, read its task and reference answer, and inspect each image at full size. Label a reference or actual output good/bad; bad labels require a reason. Only a previously good image can be explicitly confirmed as golden. A change to the dataset, reference, source, asset, runtime binding or rendered bytes invalidates stale artifacts/reviews. Reviews persist in the private local store. They are not automatically exported as public goldens or pushed to GitHub.

`--limit N` restricts cases and marks the report as a subset. `--resume` only accepts matching dataset, task, model, provider endpoint, prompt/runtime versions, provider/renderer mode and verified PNG bytes. Failed or uncertain requests are not automatically retried. Avoid concurrent CLI writers to the same output directory. Use a distinct output directory to retain separate experiments.

## GitHub integration

`.github/workflows/deepseek-eval.yml` runs manually or when the encrypted bundle/workflow changes on trusted `main` or the implementation branch. It performs offline control tests, authenticates/decrypts the dataset, makes at most 11 serial model calls with a 90-second per-call timeout, and publishes only `report.json` / `report.md`. A failed model benchmark makes the job fail; it does not silently replace failed outputs with references. Ordinary pull-request harness tests do not need private data or provider keys.

Configure repository secrets using [GitHub's secret instructions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets):

- `DEEPSEEK_API_KEY`: model credential, only passed to the generation step.
- `IMSTAGE_EVAL_DATASET_KEY`: 32 random bytes encoded as 64 hex characters, only passed to decryption.

The encrypted archive contains only the validated manifest and referenced files. Raw screenshots, reference text, model answers and generated images never enter public artifacts or logs. Decrypted job data is removed on exit. `IMSTAGE_EVAL_RUNNER_LABEL` is an optional trusted-runner label; without it the job uses GitHub-hosted Ubuntu. Do not route untrusted fork code to a runner that can access these secrets. If Actions billing prevents a job from starting, local checks do not substitute for a successful remote run.

To package updated private data, set the dataset key in the process environment and use `benchmark.mjs pack --dataset DIR --bundle FILE.imb`. `unpack --bundle FILE.imb --out EMPTY_DIR` authenticates and validates the archive, rejects path traversal, symlinks, duplicates and tampering, and only writes a new/empty destination. Keep the key in protected local storage and GitHub Secrets; never commit it.

## Reference provenance

US fictional phone numbers use the [NANPA reserved 555-0100 through 555-0199 range](https://www.nanpa.com/numbering/555-line-numbers). The Shanghai hotel address was checked against the [official Accor hotel listing](https://all.accor.com/hotel/A5G7/index.en.shtml). The supplied source frames have no street-address field in two contact cards, so those tasks explicitly request adding one. Ambiguous mixed-language conversation content is replaced by explicitly authored dialogue, not claimed as a verified literal translation.

当前 runtime 为共享 DeepSeek Agent 工具循环。历史报告字段 `counts.providerCalls` 计数每例 Agent 入口调用（每例可有多次上游请求），不能据此计算 token 或 API 账单。工具轨迹保存在私有记录，不包含在公开指标产物。CI 另行执行真实 `images/generations` 与 `images/edits` smoke gate。
