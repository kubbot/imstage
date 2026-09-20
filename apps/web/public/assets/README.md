# 火星场景素材

## `mars-companions.png`

2026-09-20 使用内置 imagegen 工具生成，作为聊天中的图片消息。不是用户本人的照片，也不是现实事件的记录；同行者为虚构成人。应用内注明 AI 合成和虚构场景。

最终提示词：

> Use case: photorealistic-natural. Asset type: image message inside a fictional chat scene creator named IMStage. Primary request: a cinematic but candid photograph of Elon Musk and a fictional adult travel companion together exploring Mars, both wearing credible modern white pressure spacesuits with transparent closed helmet visors, Musk recognizable and smiling slightly, the companion an unidentifiable fictional adult (not the user's likeness). Rust-red Martian ground, distant ridges, fine dust, soft copper sunlight, beautiful natural photography, spontaneous travel selfie composition, two people medium close in foreground with generous Mars landscape behind them. Landscape 3:2. Fictional sci-fi travel scene. No text, no captions, no chat interface, no logos or watermarks. This is a photo asset to be placed in deterministic React chat UI, not an image of a UI.

## `elon-x-avatar.jpg`

2026-09-20 通过公开资料代理 `https://api.fxtwitter.com/elonmusk` 返回的 `screen_name: elonmusk` 与 `avatar_url` 核对，再从 X CDN 获取。头像为火箭发射图；不能因为用户提及马斯克，就把另一个人像猜成其当前头像。

- 账号来源：[Elon Musk on X](https://x.com/elonmusk)
- 原图：[X CDN](https://pbs.twimg.com/profile_images/2053244804520427520/m8mdWZCG_400x400.jpg)
- 此副本是有采集日期的参考，不是实时同步。第三方素材的权利仍归原权利人，仓库代码的 MIT 许可不改变其权利。

火星定位底图是代码绘制的示意组件，不是地图服务返回的真实导航数据。
