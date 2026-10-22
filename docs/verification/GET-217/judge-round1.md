# 独立审查与实际 PNG judge 原始结论（首轮）

首轮审查与实际 PNG judge：**未通过验收**。发现 2 项 P1、2 项 P2；所有指定 case 均未达到 98 分。

审查基线 b34ac2ff236024c176980913a07834448ec9cca6，对象为首轮未提交差异。结果保留首轮失败状态，未据修复后的源码推定通过。

1. P1：X / Threads 页头布局损坏。SceneView 为两种模板输出返回、头像、标题、菜单四个子元素，但 studio.css 只有三列，四列修正仅覆盖 WhatsApp / Instagram。实际 x-*-shared.png、threads-*-shared.png 均显示标题挤入右侧窄列、菜单换行；Threads 的真实下载 PNG 同样出现。
2. P1：新增平台的 HTML 路径丢失引用和媒体内容。四个平台的 HTML PNG 均确认：A 丢失引用；B 图片变占位、相册变普通文字；C 链接缩略图和副标题消失。纯函数复现也确认 quote、内嵌图片、链接副标题、相册 caption 均未保留。
3. P2：平台默认圆角没有生效。var(--scene-radius,var(--social-radius)) 被全局 --scene-radius:8px 覆盖，20/12/22/14px 平台默认值未生效，实际共享 PNG 与 HTML 的气泡形状不一致。
4. P2：新测试不足以完成冻结验收。B/C 直接 setContent 截图，未提供对应 case 的真实编辑、撤销、刷新恢复和 PNG 下载证据；文本标记与整体宽度断言也未发现上述内容丢失。首轮 15/16，X 编辑下载因浏览器关闭失败，产品根因尚不能确定。

未发现 P0。目录、类型、Agent 枚举、MCP 平台声明和共享组件编译路径已接通；未确认这些位置存在新的安全或 custom-layout 回归。

实际查看 24 张 A/B/C PNG、3 张真实下载 PNG及3张移动端截图。H/T/F/E/R 对应冻结 rubric 的20/25/25/20/10分。R=0表示未验证，不表示已证实功能损坏。

|平台|Case|路径|H/T/F/E/R|总分|
|---|---|---|---|---:|
|X|A|shared|12/20/24/16/6|78|
|X|B|shared|12/20/24/16/0|72|
|X|C|shared|12/20/24/16/0|72|
|X|A|HTML|18/20/20/14/0|72|
|X|B|HTML|18/20/10/10/0|58|
|X|C|HTML|18/20/18/13/0|69|
|Jike|A|shared|19/23/25/20/10|97|
|Jike|B|shared|19/23/25/20/0|87|
|Jike|C|shared|19/22/25/20/0|86|
|Jike|A|HTML|18/22/20/14/0|74|
|Jike|B|HTML|18/22/10/10/0|60|
|Jike|C|HTML|18/22/18/13/0|71|
|Threads|A|shared|12/20/24/16/10|82|
|Threads|B|shared|12/20/24/16/0|72|
|Threads|C|shared|12/20/24/16/0|72|
|Threads|A|HTML|18/20/20/14/0|72|
|Threads|B|HTML|18/20/10/10/0|58|
|Threads|C|HTML|18/20/18/13/0|69|
|Xiaohongshu|A|shared|19/23/25/20/10|97|
|Xiaohongshu|B|shared|19/23/25/20/0|87|
|Xiaohongshu|C|shared|19/22/25/20/0|86|
|Xiaohongshu|A|HTML|18/22/20/14/0|74|
|Xiaohongshu|B|HTML|18/22/10/10/0|60|
|Xiaohongshu|C|HTML|18/22/18/13/0|71|

原始评分理由：X/Threads shared 页头损坏；X A下载链路未完成。Jike/XHS shared A内容及真实操作证据齐，但默认圆角、页头副标题对比不足；B长 token 与媒体未见横向溢出但缺操作证据；C长图完整但卡片副标题较淡且缺操作证据。HTML A缺引用、自身时间低对比，与共享输出不一致；HTML B图片及相册内容丢失；HTML C链接缩略图、副标题缺失。

阻断项：X/Threads 页头内容被挤压；HTML 引用和媒体丢失；X 真实下载证据缺失。B/C 操作证据、既有 WeChat/WhatsApp 回归、CI 和生产验收未在首轮 judge 中验证。纯色小图只能证明当前样本的渲染，不能证明其他宽高比媒体表现。

更正记录：图片工具曾裁切显示下载 PNG 顶部，导致初步误报水印缺失；该判断已撤回。直接读取文件像素确认 Jike、Threads、Xiaohongshu 三张720×1280下载 PNG均在 y=92..141 存在完整暗色水印带。

Judge 调用计数1。执行身份：原生 Codex；精确实际模型标识不可得。未使用 Pi、外部付费服务、API key，未另派 agent，未修改文件。修复后产物未复核，本报告不构成修复关闭。
