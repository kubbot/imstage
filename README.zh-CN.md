# IMStage

面向 Web、MCP 和 API 的开源聊天场景创作工具。

**当前处于早期开发阶段：本地 Eval 标注工具可用；此基线尚无生产聊天渲染器、MCP 或 API 服务。**

[English](README.md) · [产品说明](docs/product-brief.md) · [设计简报](design/BRIEF.md)

## 产品方向

通过对话描述场景，生成可编辑的聊天内容与模拟截图。Web 编辑器和 MCP/API 复用相同的结构化数据与渲染能力，服务于设计、教学、叙事创作及合成评测数据。

计划支持多平台模板、单聊与群聊、人物头像、消息时间与手机状态、图片及定位等消息、普通截图与长截图，以及上传截图后提取结构化内容并继续编辑。

Web 端计划提供免费使用；托管 MCP/API 计划使用账号绑定的 key 和预付额度。额度、AI 成本、收费能力边界和价格尚未确定。开源自部署属于产品方向。

## 本地 Eval 标注台

需要 Node.js 22 或更新版本：

```sh
npm --prefix tools/eval ci
npm --prefix tools/eval start
```

打开 `http://127.0.0.1:4421`，录入问题与素材、导入实际输出 PNG、标注好坏、确认金标，再导出用于 Git/CI 的数据。普通截图和长截图分别记录规格。个人数据保存在忽略目录 `.local/eval/`；Git/CI 导出仅包含明确标为合成且经人工审核的金标。

验证命令：`npm --prefix tools/eval test` 和 `npm --prefix tools/eval run selftest`。GitHub 的 **Eval harness** 检查评测器正反例；尚未接通的生产渲染器不属于此绿灯的证明范围。

详见 [评测设计](docs/evaluation.md) 和 [工具使用说明](tools/eval/README.md)。

## 初始化边界

初始化阶段建立了本地项目、GitHub、Vercel、Open Design、ChatGPT 项目及相关文档。本阶段按用户请求增加 Eval，不扩大模型调用、登录、支付、生产渲染器、API 或 MCP 的实现范围。

目录用途见 [README](README.md)。Eval 独立于产品目录启动。

## 开源协作

采用 [MIT License](LICENSE)。提交改动前阅读 [贡献说明](CONTRIBUTING.md)；安全问题通过 [安全报告流程](SECURITY.md) 私下报告。示例素材使用合成或已获授权的内容，生成结果应明确表达模拟属性。
