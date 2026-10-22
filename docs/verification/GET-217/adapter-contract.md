# 合成聊天平台适配契约

本分支包含 IMStage、微信、小红书、iMessage、WhatsApp、Slack、Instagram、X、即刻和 Threads。它们是合成对话/私信模板；不代表支持公开信息流、笔记发布、真实社交登录或账号操作。生产交付状态以 GET-217 验收记录为准。

`packages/schema/platforms.mjs` 是 Web 校验、Agent 工具枚举和 MCP 能力清单的唯一平台目录；新平台必须同时添加强类型声明、平台模板和渲染实现。四个 social chat adapter 提供版本、头像规则、页头、气泡、输入栏与双语文案。用户自定义布局绕过 social token；显式 appearance 优先于平台默认值。MCP PNG 使用编译的同一个 React SceneView。离线 HTML 渲染对引用、安全内嵌图、相册及静态卡片保留内容；远程图片 URL 不加载。

新增平台不能只改枚举：必须验证场景往返、真实 select_template 工具、共享/HTML渲染、编辑与撤销、刷新恢复、实际PNG下载、水印像素和窄屏/长文/媒体边界。媒体静态样本不代表视频播放或语音转录。现有 Telegram 仅为离线 legacy renderer 标识，不属于本分支 Web/API 已验收平台。

本次输入全部合成；未登录真实社交平台、未向这些账号发布内容。没有调用新付费服务或 Token Plan。
