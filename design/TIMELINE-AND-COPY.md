# 时间线、图片输入与快速复制

2026-09-21，接续编辑工作台。使用合成场景，无用户截图、真实人物或账号信息进入仓库，未使用 Pi。

## 用户现在可以做什么

- 将 PNG/JPEG/WebP 拖到左侧整个创作面板，或粘贴、选择图片；最多 3 张，每张 4 MB。上传错误不会清掉已选图片。
- 点击发送后参考图立即从输入框移到对应需求的聊天记录；失败和取消时恢复原需求及附件。右侧 AI 不消费左侧尚未发送的内容；左侧选择元素后仍会发送其参考图。
- 点选消息，分别编辑发送日期和时间。在画面属性中设置“故事中的今天”；实际消息的 ISO 日期决定分段，跨年日期保留年份，日期不会随查看时电脑时钟变化。
- 点击“复制图片”直接粘贴 PNG；复制和下载使用同一渲染函数。拒绝剪贴板权限或 API 不可用时，展示实际生成图片供长按/右键复制及下载，不显示虚假成功。
- 打开 `#/create?case=loan-anniversary` 即可编辑示例。示例草稿独立保存，不覆盖普通创作草稿；手机直接打开画布。

## 回归案例

`tools/eval/fixtures/loan-anniversary.json` 固定故事参考日期为 2026-09-21（Asia/Shanghai）：先展示 2025-09-21 借款与一年期约定，再展示 2026-09-21 归还 500 万元及收到确认。所有人物虚构，导出带“合成案例 · 虚构对话”。

运行 `npm run test:timeline`；检查其他生成结果可运行 `node tools/eval/timeline.mjs path/to/scene.json`。10 项确定性判定涵盖结构、iPhone 设备、冻结参考日、真实历史消息、约定、当日还款及收款人、日期顺序、唯一日期分隔与合成标识。失败退出码为 1。它是本案例的接受检查，不等于任意对话的通用语义评审。

真实 `deepseek-flash` 在空消息场景上独立生成了 11 条消息（6 条去年、5 条今天），返回完成并通过 10 项检查。原始输出、最终判定见 `evidence/loan-anniversary/ai-generated-scene.json` 与 `ai-evaluation.json`。初版判定只认“已归还”措辞，漏识别实际转账卡片；保留原始模型结果，补充“转账卡片 + 收款人确认”判定和未还/未收到/付款人反向反例后重新评测，未通过修改输出凑分。

渲染器还兼容旧草稿：隐藏与顶部重复的纯日期系统消息，但保留原数据供编辑；系统说明不会挤成逐字竖排。既有只写今天的故事不会被自动编造为去年借款，应从新案例重建或给消息设置真实日期。

## iPhone 验证

复用 Primary iPhone 17 Pro（iOS 26.5）模拟器，Safari 实际打开案例、缩放、复制，观察到“图片已复制”。测试在统一 iOS session 锁内完成，结束关闭本轮启动的模拟器。没有使用物理 iPhone。

Safari 实测暴露 CSS zoom 会重排字体，现已改为固定原生尺寸加 transform 整体缩放，使用 ResizeObserver 保留滚动空间；复测完整内容与换行不再随缩放改变。`iphone-safari-copy.jpg` 保存 Safari 完整画布与复制成功提示；桌面 Chrome 测试还读回并解码实际 PNG 剪贴板，宽 1206 px。样片 `sample.png` 为同一 SceneView 导出的 1206 px 宽长图，普通截图为 1206 × 2622。

## 实现依据

- [MDN File drag and drop](https://developer.mozilla.org/en-US/docs/Web/API/HTML_Drag_and_Drop_API/File_drag_and_drop)：文件拖拽及默认事件处理。
- [WebKit Async Clipboard API](https://webkit.org/blog/10855/async-clipboard-api/)：用户手势内立即调用 write，PNG 以 Promise 交给 ClipboardItem。
- [MDN Clipboard.write](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/write)：PNG 写入与权限拒绝处理。

本次交付范围为本机 4417 服务及独立工作分支，未合并 main 或发布公网。

## 自动验证结果

- 构建、TypeScript 与差异格式检查通过。
- `npm test`：294 / 294；现有 `npm run test:eval`：193 / 193。
- 本次受影响的浏览器验收：57 / 57，一次最终完整运行通过，覆盖图片拖拽、发送中清空、失败/取消恢复、左右 AI 附件隔离、PNG 剪贴板读回、权限失败替代操作、日期编辑与样例草稿隔离、设备尺寸、深浅色、键盘、无障碍和移动端。
- 跨年专用回归：6 项单元用例及案例 10 项判定通过；包含会被拒绝的错误时间线与虚假还款反例。
- 原长消息 UI 测试曾随机选择 guest 草稿键；现按登录用户草稿读取，最终完整运行通过。测试协议桩与上述真实模型生成证据分开保存。

## 本机发布读回

4417 已运行提交 `6d161ce` 的前端及 AI 后端，继续使用原有账号数据库；健康状态 ready，HTTP 入口 SHA-256 与本轮构建相同。真实登录会话执行一次合成场景的 @scene 修改，返回 HTTP 200 / done，6 条消息逐字段不变，去年与今天的 date 及 referenceDate 均完整保留。读回结果见 `evidence/loan-anniversary/local-readback.json`。仅内存中合成场景调用，未创建用户作品或写入人物库。

启动入口和回退入口记录在主目录忽略的 `.local/editor-active-release.json`；运行目录为本工作分支。后续切换服务版本时应沿用该记录核对来源。临时验收服务与测试数据库已清理，正式合成样片及报告保留在仓库。
