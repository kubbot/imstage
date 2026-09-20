# Private screenshot edit benchmark

`chat-screenshot-edits-v1.imb` is an AES-256-GCM authenticated encrypted dataset. Its 11 owner-supplied screenshots, tasks, proposed reference edits and replacement assets remain encrypted in Git. There are no plaintext images or conversation extracts in this directory.

Coverage: WeChat, WhatsApp, Instagram; iOS and desktop; difficulty 1–5; text replacement, repeated identities, contact cards, fixed media frames, video-thumbnail affordances, location cards and localization. The collection tests edits to existing screenshots, not complete reconstruction from a conversation schema or video generation.

Keys stay in `IMSTAGE_EVAL_DATASET_KEY` and `DEEPSEEK_API_KEY` GitHub Secrets. A key is not included in this repository. See [the workflow and local review guide](../../docs/screenshot-evaluation.md).
