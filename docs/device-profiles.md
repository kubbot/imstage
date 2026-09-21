# 设备截图配置（Device profiles）

状态：已实现代码注册表、渲染差异、工作台设备选择及预览/导出尺寸切换。本页只说明已经落地的事实，不声称任何官方 App 版本已通过像素级认证。

## 目的

同一份 `Scene`（人物、消息、时间、背景、外观）在不同设备配置下复用同一个 `SceneView` 渲染路径，只改变设备外观、安全区和排版指标。注册表是框架无关的纯数据 + 纯函数，编辑器、渲染器和测试共用。

- 代码：`apps/web/src/studio/device-profiles.ts`
- 渲染：`apps/web/src/studio/SceneView.tsx` 输出 `data-device`
- 样式：`apps/web/src/studio/studio.css`（`data-device` 选择器）
- 模型：`Scene.deviceProfileId?`，由 `validateScene` 校验并随草稿持久化
- 用例：`tools/eval/fixtures/device-fidelity.json` + `tests/device-profiles.test.mjs`

## 注册表

| id | surface | 逻辑尺寸 | DPR | 导出像素 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `legacy360` | ios | 360 × 640 | 2 | 720 × 1280 | 兼容旧版默认外观，无设备专属样式 |
| `iphone-15-pro` | ios | 393 × 852 | 3 | 1179 × 2556 | 原生面板 1179 × 2556 |
| `pixel-8` | android | 360 × 800 | 3 | 1080 × 2400 | 原生面板 1080 × 2400 |
| `macos-window` | desktop | 1000 × 720 | 2 | 2000 × 1440 | 固定尺寸的桌面窗口预设，不是硬件屏幕声明 |

`DEVICE_PROFILES` 只包含上表四项。`deviceProfile(scene)` 另外提供两个“兼容回退”，它们不出现在可选列表中：

- `legacy-android`：场景没有显式 id、`surface = android` 时的 360 × 640 @2x 回退。
- `legacy-desktop`：场景没有显式 id、`surface = desktop` 时的 900 × 640 @2x 回退。
- 其余情况回退 `legacy360`（ios）。

## 权威像素规格 vs 本项目的逻辑缩放

官方给出的是**硬件原生像素**，本项目渲染与截图使用**逻辑（CSS）坐标**：

- iPhone 15 Pro：Apple 支持文档列出 1179 × 2556 原生像素；本项目选择 393 × 852 逻辑点 @3x。来源：<https://support.apple.com/111829>。
- Pixel 8：Google 支持文档列出 1080 × 2400 原生像素；本项目选择 360 × 800 逻辑 dp @3x。来源：<https://support.google.com/pixelphone/answer/7158570?hl=en>。
- `macos-window` 只是一个 1000 × 720 @2x 的桌面窗口预设，用于桌面版式与导出，**不代表**任何具体 Mac 屏幕或窗口分辨率。

上述选择是项目内的可复现约定，方便注册表、测试和导出尺寸一致；不代表某个官方 App 版本、系统版本或主题已经逐像素验证通过。

## 解析规则

```ts
deviceProfile(scene): DeviceProfile
```

1. `scene.deviceProfileId` 是已知 id，且其 `surface` 与场景有效 surface 一致 → 使用该配置。
2. 否则 → 按有效 surface 回退到 legacy 预设（ios/android/desktop）。
3. 函数是纯函数且全定义：未知 id 或 surface 不匹配时在渲染期安全回退，不抛异常。

有效 surface 由 `normaliseSurface` 决定：`android` / `desktop` 原样，其它值（含 `undefined`）视为 `ios`。

## 校验与持久化

`validateScene` 的行为：

- `deviceProfileId` 可选；提供时必须是字符串。
- 未知 id → 报错 `未知设备配置：…`，整个场景校验失败（不会静默丢弃）。
- id 的 `surface` 与场景有效 surface 不匹配 → 报错 `…不匹配`。
- **只对显式 id 校验 surface**；没有显式 id 的旧场景按 surface 正常通过，且不会被自动写入 `deviceProfileId`。
- 通过校验的场景会保留 `deviceProfileId`，`serializeDraft` / `parseDraft` 往返不丢失。

## 渲染差异

`SceneView` 输出 `data-device="<id>"`，父级预览/导出 frame 负责实际宽高（渲染器不内联写死尺寸）。

- **iPhone 15 Pro**：iOS 状态栏与安全区（顶部时间区、底部 home indicator 区域），微信使用更接近原生的字号、头像尺寸与气泡间距。
- **Pixel 8**：Android 状态栏与底部手势导航条，微信同样使用更接近原生的排版指标。
- **macOS 窗口**：桌面标题栏（交通灯）与更宽松的桌面输入栏，**不显示**移动端状态栏。
- **legacy 回退**：没有任何设备专属选择器命中，保持原有通用外观。

截图内容契约：

- 标准截图：消息区 `overflow: hidden`，按 frame 高度裁切，输入栏保持可见，不导出滚动条。
- 长截图：父级 frame 标记 `data-mode="full"`，消息区允许全部消息撑高 frame。
- 不绘制任何设备边框/bezel；`data-device` 只影响内容内的系统 UI 与排版。

## 评估用例

`tools/eval/fixtures/device-fidelity.json` 用同一份 `semanticContent`（同一组人物、同顺序、同时间的消息）描述三台设备（iPhone 15 Pro / Pixel 8 / macOS 窗口），并声明必需的人工复核项：

- avatar 类：头像可读、不拉伸、朝向正确。
- realism 类：微信排版/气泡间距、桌面标题栏与输入栏、无移动状态栏。
- 通用要求：标准/长截图行为、无设备边框。

这些是合成夹具，**不是**已批准的产品金标，也不进入私有数据或原始金标；像素级结论仍以人工视觉复核为准。

## 测试

```bash
node --test tests/device-profiles.test.mjs
npm run typecheck
```

覆盖：注册表与官方像素换算、回退解析、显式 id 的校验/拒绝不匹配/草稿往返，以及评估夹具与注册表的一致性。
