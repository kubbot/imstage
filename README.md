# IMStage

Author synthetic chat scenes for tests, teaching and evaluation datasets.

[Try IMStage →](https://imstage.org/?lang=en) · [简体中文](README.zh-CN.md) · [Contribute](CONTRIBUTING.md)

> **GitHub disclaimer — testing and learning only.** IMStage produces
> **synthetic chat content** for software testing, teaching and
> evaluation-dataset annotation. **Not for any commercial use. Anti-abuse:** never fabricate evidence, commit fraud,
> defame anyone, impersonate any real person or organisation, or mislead
> anyone about whether generated content is real. Output is synthetic and must
> never be presented as evidence of a real conversation. Use fictional assets
> or assets you are properly authorised to use (authorised avatars and real
> place names are fine). Every preview and export carries the
> **“AI生成 / 虚构 · AI-generated / Fictional”** watermark by default (a
> per-project/per-scene switch may turn it off; the AI can never change your
> choice).

- **Edit directly.** Change messages, people, avatars, timestamps and device settings. Undo mistakes and keep separate local sessions.
- **Create with words.** The hosted Agent drafts and revises synthetic scenes after sign-in.
- **Reuse your work.** Save editable templates, expose names and photos as variables, and create project variations with shared rules.
- **Export the result.** Download a normal frame or a long PNG, or keep the editable scene as JSON. Every PNG (including crops and MCP renders) carries the default-on fictional watermark.
- **Use your own tools.** Self-host the account API and Agent, or connect a client to the authenticated MCP service.

Scenes render in the selected chat template skin — IMStage generic plus WeChat,
WhatsApp, iMessage, Instagram, Xiaohongshu and Slack. These are approximate
style previews for synthetic content: independent of any messaging platform,
with no third-party logos, trademarks or pixel-level interface clones.

## Run locally

Use Node.js **22.18–22.x**.

```sh
npm ci
npm run dev
```

Open [localhost:4417](http://127.0.0.1:4417). To build and run the production app:

```sh
npm run build
npm start
```

Configure server-side provider credentials to use the Agent. Manual editing and
PNG export work without provider keys.

## Hosting and integrations

The hosted website uses Vercel for the frontend and a persistent server for
accounts, saved scenes and Agent requests. Provider secrets stay on the server.
Local sessions stay in the current browser.

Connect ChatGPT through the [account connection page](https://imstage.org/#/connect).
The account MCP endpoint (`/api/mcp`) uses OAuth login and shares your Web saved
scenes. Self-hosted `/mcp` retains its administrator-configured instance token
and separate scene store.

**Audit and retention.** Every hosted generation (web Agent, project batches,
portrait generation, AI-supplied content saved through either MCP surface and
hosted render outputs) writes one durable audit record: run id, time, account
id, policy version, status and scene hash — never raw prompts, screenshots or
tokens; the hash is a digest and stores no raw content. Audit rows have a
**90-day primary retention** and are deleted by a periodically running cleanup
job (up to about 6 hours late). Operational data (saved scenes, projects,
project rules, batch prompts) is stored separately per account, and deploy-side
backups keep **14 versions** under their own policy — not every copy disappears
on day 90. **Limitation:** anonymous local editing and PNG export upload no
scene contents and create **no** server audit record (the page still loads
static assets and ordinary access logs exist); the default-on watermark is rendered
client-side and travels with each export instead. See
[privacy notes](https://imstage.org/#/privacy) and
[terms](https://imstage.org/#/terms).

[Templates and batch creation](docs/templates-and-projects.md) · [Deploy and operate](deploy/README.md) · [Account API](services/api/README.md) · [Agent configuration](services/agent/README.md) · [MCP tools](services/mcp/README.md)

## Development

```sh
npm test
npm run test:ui  # Playwright; installed Google Chrome by default
```

For bundled Chromium, run `npx playwright install chromium`, then
`IMSTAGE_BROWSER=chromium npm run test:ui`. See [contributing](CONTRIBUTING.md).

Built-in conversations and portraits are synthetic fiction; user-supplied
avatars and place names must be fictional or properly authorised. Payment,
transfer, red-packet and balance message types are removed; real-screenshot
reference editing is disabled on all public surfaces (internal offline
evaluation tools keep their research code but are unreachable publicly). The
disabled workflow does not guarantee that arbitrary uploaded pixels could not
themselves be a screenshot — upload only fictional or authorised material.

## License and commercial use

New versions are distributed under the **source-available non-commercial
license** in [LICENSE](LICENSE) — testing, learning and research only; **not**
OSI-approved open source. Earlier releases were MIT-licensed and keep those
terms; the historical text is preserved in
[LICENSE-MIT-LEGACY](LICENSE-MIT-LEGACY). Nothing revokes the earlier MIT
license retroactively.

Separate commercial engagements cover **private / closed-source test sets,
evaluation datasets and annotation deliverables**, arranged by email under
independent agreements. They are outside the public tool’s license. The business contact address is listed on the terms page and marked
“not published yet” until one exists.

Independent of any messaging platform; no trademarks of third parties are used.
