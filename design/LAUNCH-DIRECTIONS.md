# IMStage — 官网上线方向 A/B（原型记录）

状态：2026-09-22。本轮只交付两个可本地运行的官网原型，用于视觉挑选，不是最终官网，也没有改动生产入口。

**2026-09-22 后续：方向 A 已被选中并进入生产实现。** 生产页面不再引用原型 CSS，并取消了原型里重复的第二个手机（改为真实导出文件卡片）。实现范围、需求对照与验证记录见 [LAUNCH-ACCEPTANCE.md](LAUNCH-ACCEPTANCE.md)；本文件保留原型阶段的判断依据与二分品牌定理。

- 原型 A：`apps/web/design/launch-a.html` → `apps/web/src/marketing/prototypes/launch-a.tsx`
- 原型 B：`apps/web/design/launch-b.html` → `apps/web/src/marketing/prototypes/launch-b.tsx`
- 共用：`shared.tsx`（语言/主题/按钮/品牌）、`scenes.ts`（合成日常场景）、`shared.css`
- 渲染：两个原型都直接渲染生产组件 `apps/web/src/studio/SceneView`，复用 `studio/model` 的 Scene，没有自制假截图。

## 二分品牌定理

**当且仅当访客能在 5 秒内改掉对话里的一句话、并看到真实渲染结果跟着变，IMStage 才成立。**

静态成品图无法单独证明编辑能力。本轮用“改动沿同一条 Scene 传到真实渲染”作为可操作的验收标准，比较两个方向：

1. 访客看清楚「写下 → 改一句 → 导出」，并愿意动手试 → 方向成立。
2. 访客只看到一张好看但静止的聊天图 → 方向不成立，即使视觉更精致。

这里只做二选一的判断依据，不给出绝对分数，也不声称 95 分之类的结论；A/B 只在“机制可见性、浏览效率、空间气质”上比较相对强弱。

## 共同约束

- 品牌连续性：沿用现有 `Mark`（`components.tsx`）与克制的暖红 `--pf-accent`（浅色 `#b63a22`、深色 `#ff805f`）；平台气泡颜色属于产品输出，不参与官网主题。
- 语言：`中文 / EN` 分段控件。中文 → 微信模板 + 中文内容；English → WhatsApp 模板 + 英文内容。预览内所有文字、设备时间、地点、群聊提示都随语言切换。
- 主题：浅色 / 跟随系统 / 深色，只有 HTML 入口里的一次启动脚本读取 `imstage-prototype-theme`，不写应用的 `imstage-theme`。
- 内容：咖啡、周末、产品讨论三条合成日常；无真人、无真实聊天、无虚构指标、无技术术语、无 AI 闪光装饰。
- 依赖：仅用现有 `react`、`@tabler/icons-react`、`html-to-image`；没有新增依赖。
- 无障碍：分段控件有 `role="group"` 与 `aria-label`，可编辑行有 `<label>`，可滚动/可点选元素有本地化标签，`prefers-reduced-motion` 下关闭动效。
- 生产隔离：`index.html` 与 `vite.config.ts` 未改动，原型不进入生产构建产物。

## 旅程 A — 对话导演台 Conversation Stage

**信息旅程**：先读一句承诺 → 立刻改一句话 → 看真实画面响应 → 再进入细节控制。

- 首屏（`launch-a`）非对称双栏：左侧大字号排版（两行标题，第二行暖红），标题下紧接一条与展示体同号的**可编辑台词**；右侧是舞台灯池上的 348×754 长屏设备，显示完整微信/WhatsApp 对话（状态栏、头像、绿色气泡、定位卡、输入栏都来自共享渲染器）。
- 编辑款台词会立即改写 Scene 中的对应消息，右侧画面同步；右侧设备旁标注「实时预览」「微信 · 中文 / WhatsApp · English」与「合成示例 · 非真实聊天」。
- 步骤条 `01 写下 / 02 改一句 / 03 导出`，用行分隔符连接，突出第二步。
- 后续区块（`pa-console`）是**细节控制台**：对话的人、我说的话、画面时间三个字段 + 「导出这张画面」（真实 `html-to-image` 导出 PNG）+「回到初始」。控制台与首屏读同一份 Scene，改一处两处同步，用于证明“可编辑”不是演示动画。
- 空间语言：舞台。暖色光晕、垂直节奏、单场景放大，信息密度低。

## 旅程 B — 场景作品集 Scene Gallery

**信息旅程**：先给结果（三件成品），再用三拍解释这段对话怎么成立。

- 首屏（`launch-b`）紧凑承诺块：一行标签、两行标题、一句说明、两个按钮；CTA 在 443px。
- 下方是**横向展览**：三块不同色底（clay / sage / slate）的美术展板，各含真实 SceneView 输出、超大编号 `01–03` 与场景名；未选中展板轻微旋转错落，点选后抬起 22px、描边转暖红、编号转暖红，下方焦点条同步更新场景名、说明与「用这个场景开始」。
- 后续区块（`pb-beats`）是**叙事三拍**：左侧一张 340×737 完整渲染，右侧 `开场 / 回应 / 收束` 三拍横排，节点用细线串起，文字直接来自当前选中场景的消息。切换场景时三拍同步替换。
- 空间语言：画廊。横向节奏、大编号、细规则线、暖墙光晕、无表单感。

## 参考 References

- [screen.studio](https://screen.studio/)：先展示可带走的成品，再谈功能；B 的场景墙采用这一顺序。
- [tldraw](https://www.tldraw.com/) / [Excalidraw](https://excalidraw.com/)：把摩擦降到“直接碰到作品”；A 首屏的编辑行采用这一原则。
- 既有设计记录：[REVIEW.md](REVIEW.md)（品牌色、间距节奏、D3/D4 结论）、[BRIEF.md](BRIEF.md)（Agent 与手动编辑的关系）。

## 反参考 Anti-references

- 密集开发控制面板：参数堆叠、术语表、调试味。
- 通用模板商城：同质卡片墙、只看成品看不到修改过程。
- 通用 AI 官网：星光图标、紫色渐变、抽象“智能”口号。
- 假数据仪表盘：编造的百分比、增长率、用户数。
- 手工拼出来的假聊天界面：与真实渲染器不一致的 DOM。

## 本地运行与验证

```bash
npm ci --no-audit --no-fund
npm run typecheck
# 原型入口（Vite dev server 直接服务任意 HTML）
npx vite --host 127.0.0.1 --port 4418 --strictPort
# http://127.0.0.1:4418/design/launch-a.html
# http://127.0.0.1:4418/design/launch-b.html
```

本轮实际执行的验证（Chrome + Playwright，`@axe-core/playwright`）：

1. `npm run typecheck` 通过。
2. 两个原型：标题恰好两行（中英、桌面与 390px 均逐行验证）、首屏 CTA 在 900px 内（A 678px / B 443px）、中文 `data-platform=wechat`、英文 `data-platform=whatsapp`、预览文案随语言切换、深色主题生效。
3. 真实渲染链路：A 的编辑行与控制台字段改动都到达 SceneView；A 的导出按钮产生真实 `.png` 下载。
4. B：三块展板、恰好一个选中、点选后焦点标题与三拍同步更新。
5. 布局：A 在 1440/1280/1200/1125px 下舞台面板不压正文列、设备不出视口；B 展板不重叠；390/360/414px 无横向溢出，顶部控件不越界。
6. 无障碍：axe（wcag2a/2aa/21a/21aa）在浅色、深色、390px 移动端均无 critical/serious 问题；`prefers-reduced-motion` 下正常渲染且无报错。
7. 浏览器控制台无脚本错误（仅入口自带的 favicon 已改为内联品牌 SVG，不再产生 404）。

## 边界

- 原型不接入真实 Agent、账号、保存或 MCP；导出按钮只证明“同一渲染器可导出”，不代表后端能力。
- 文字、时间、图片素材均为合成内容；地点卡是渲染器自带的示意样式，不声称与真实 App 像素一致。
- 最终官网的信息架构、文案和页面数量仍未决定；本轮不交付生产页面，也不修改 `App.tsx`。
