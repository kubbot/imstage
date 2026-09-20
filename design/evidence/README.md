# 设计与导出证据

2026-09-20，使用合成示例，在 macOS Chrome 中重新采集。桌面截图为 1440×1200，移动截图为 390×844；没有私人聊天或账号数据。图片证明前端呈现和输出，不代表真实平台像素一致性。

| 阶段 | 截图 |
| --- | --- |
| 原始 OpenDesign | [改版前](before-desktop.png) |
| 方向探索 | [A 对话导演台](direction-a.png) · [B 场景作品集](direction-b.png) |
| 最终官网 | [浅色](home-light.png) · [深色](home-dark.png) |
| 场景展示 | [浅色](gallery-light.png) · [深色](gallery-dark.png) |
| 接入区域 | [浅色](integration-light.png) · [深色](integration-dark.png) |
| 工作台 | [浅色](studio-light.png) · [深色](studio-dark.png) |
| 移动端 | [官网](home-mobile.png) · [场景预览](home-mobile-preview.png) · [工作台](studio-mobile.png) |
| 实际 PNG 下载 | [普通截图](export-standard.png) · [完整长图](export-long.png) |

最终选择 A 的可见编辑机制，吸收 B 的场景浏览结构；依用户偏好提供同一信息架构下的浅/深色主题，默认跟随系统。详细取舍见 [设计评审](../REVIEW.md)。

`scripts/capture-design.mjs` 可重新采集最终 11 张界面截图。PNG 下载文件来自 `tests/ui/frontend.spec.ts` 的实际导出验收，并非另行拼接的效果图。探索源码保存在 [explorations.html](../explorations.html)，仅供设计比较，不作为应用入口。
