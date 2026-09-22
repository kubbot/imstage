/**
 * Bilingual copy for the scene library and the usage/privacy pages.
 *
 * Kept beside the landing copy so navigation to "Scenes" or "Docs" never
 * drops back into the other language. The privacy text states what actually
 * happens today: landing edits stay in the browser, an explicit account save
 * uploads scenes and media to the hosted service, and AI/MCP requests leave the
 * browser only when the visitor asks for them.
 */
import type { Locale } from './locale';
import type { SceneKind } from './scenes';

export type TemplateCategory = 'life' | 'product' | 'teaching';

export interface TemplateEntry {
  id: 'weekend' | 'launch' | 'welcome';
  kind: SceneKind;
  category: TemplateCategory;
  word: string;
  title: string;
  description: string;
}

export interface TemplatesCopy {
  label: string;
  title: string;
  lede: string;
  filters: Record<'all' | TemplateCategory, string>;
  searchLabel: string;
  searchPlaceholder: string;
  emptyTitle: string;
  emptyBody: string;
  reset: string;
  note: string;
  platform: string;
  open: string;
  entries: readonly TemplateEntry[];
}

export interface DocsCopy {
  label: string;
  title: string;
  lede: string;
  source: string;
  tabs: { web: string; mcp: string; templates: string; privacy: string };
  web: { tag: string; title: string; body: string; steps: readonly { title: string; detail: string }[]; callout: string; cta: string };
  mcp: { tag: string; title: string; body: string; authTitle: string; auth: readonly string[]; callout: string; link: string };
  templates: { title: string; body: string; steps: readonly { title: string; detail: string }[]; callout: string; link: string };
  privacy: { title: string; body: string; items: readonly { title: string; detail: string }[]; recovery: string; payment: string; cloudNote: string };
}

export const TEMPLATES_COPY: Record<Locale, TemplatesCopy> = {
  zh: {
    label: '场景灵感',
    title: '一个开场。无限种你的版本。',
    lede: '全部使用合成内容。挑一个喜欢的，进入工作台继续写。',
    filters: { all: '全部', life: '生活叙事', product: '产品演示', teaching: '教学示例' },
    searchLabel: '搜索场景',
    searchPlaceholder: '找一个场景',
    emptyTitle: '没有找到这个场景',
    emptyBody: '换个关键词，或者从空白故事开始。',
    reset: '查看全部场景',
    note: '模板是故事的起点。你可以修改每个细节，也可以在工作台新建自己的场景。',
    platform: '微信风格',
    open: '进入工作台',
    entries: [
      { id: 'weekend', kind: 'weekend', category: 'life', word: '去看海', title: '周末出逃计划', description: '一句“去看海吧”，是整个故事的开始。' },
      { id: 'launch', kind: 'product', category: 'product', word: '有想法', title: '好想法，群里见', description: '把一次灵感碰撞，编排成产品的开场。' },
      { id: 'welcome', kind: 'coffee', category: 'teaching', word: '初次见', title: '很高兴认识你', description: '从第一次打招呼开始，把沟通讲清楚。' },
    ],
  },
  en: {
    label: 'Scenes',
    title: 'One opening. Endless versions of yours.',
    lede: 'Everything is synthetic. Pick one and keep writing in the studio.',
    filters: { all: 'All', life: 'Everyday', product: 'Product', teaching: 'Teaching' },
    searchLabel: 'Search scenes',
    searchPlaceholder: 'Find a scene',
    emptyTitle: 'No scene matches that',
    emptyBody: 'Try another keyword, or start from a blank scene.',
    reset: 'Show all scenes',
    note: 'A template is a starting point. Edit every detail, or start a new scene in the studio.',
    platform: 'WhatsApp style',
    open: 'Open the studio',
    entries: [
      { id: 'weekend', kind: 'weekend', category: 'life', word: 'Seaside', title: 'Weekend escape', description: 'One “let’s see the sea” starts the whole story.' },
      { id: 'launch', kind: 'product', category: 'product', word: 'Ideas', title: 'Good idea, meet the group', description: 'Turn a round of ideas into a product opening.' },
      { id: 'welcome', kind: 'coffee', category: 'teaching', word: 'Hello', title: 'Good to meet you', description: 'From the first hello, make the conversation clear.' },
    ],
  },
};

export const DOCS_COPY: Record<Locale, DocsCopy> = {
  zh: {
    label: '使用与接入',
    title: '从你的浏览器，到你的工具链。',
    lede: '现在就可以编辑，也说明账号、AI 与 MCP 的真实边界。',
    source: '源代码',
    tabs: { web: '浏览器工作台', mcp: 'MCP / API', templates: '模板与真实 UI', privacy: '数据与隐私' },
    web: {
      tag: '免登录可用',
      title: '浏览器里的对话工作台',
      body: '打开工作台，无需登录即可使用本地示例。编辑、预览与导出都在当前浏览器完成。',
      steps: [
        { title: '选一个故事', detail: '从场景灵感开始，或在工作台新建空白场景。' },
        { title: '点选消息，修改细节', detail: '调整台词、发送人和时间。预览实时更新，改错可以撤销。' },
        { title: '保存你要的画面', detail: '导出普通截图或完整长图，也可以下载 JSON 备份可编辑场景。' },
      ],
      callout: '登录托管账号后，可以保存作品并使用 Agent 生成与截图参考编辑；AI 需要在服务端配置模型。',
      cta: '进入 Agent 创作',
    },
    mcp: {
      tag: '实例令牌',
      title: '让 Agent 使用同一个渲染器',
      body: 'Web、MCP 与 API 共用场景格式和渲染器，MCP 使用独立场景库。AI 理解修改意图，确定性渲染器负责排版输出。',
      authTitle: '访问方式',
      auth: [
        'MCP 使用管理员配置的实例 Bearer 令牌，读写独立于 Web 账号的场景库。',
        '不提供匿名或公开免费调用；商业 API key 与定价尚未实现。',
        '同一实例令牌可访问该 MCP 场景库；不要将令牌提供给不可信的人，泄露时立即轮换。',
      ],
      callout: 'MCP 已随服务端部署；接入需管理员提供实例令牌，不共用 Web 账号作品库。',
      link: '在仓库查看 MCP 说明',
    },
    templates: {
      title: '真实 UI，要有真实参照',
      body: '当前模板是视觉近似。微信与 WhatsApp 优先；具体系统与 App 版本的像素级校准仍待完成。',
      steps: [
        { title: '采集经过授权的真实截图', detail: '使用测试账号和合成对话，记录平台、系统、版本、设备与字体设置。' },
        { title: '按组件建立参考库', detail: '拆分状态栏、导航、头像、消息、时间和卡片，不混合不同版本的规则。' },
        { title: '同场景对照渲染', detail: '固定字体与尺寸，逐项检查布局、文本和关键状态，校准后再宣称准确还原。' },
      ],
      callout: '图像生成适合制作聊天里的图片素材。整张聊天界面应由程序渲染，保证修改可控、文字准确。',
      link: 'Apple 系统设计资源',
    },
    privacy: {
      title: '你的数据去了哪里',
      body: '免登录的官网编辑只发生在浏览器内存；只有你明确保存或使用 AI 时，数据才会离开浏览器。',
      items: [
        { title: '本机草稿', detail: '工作台草稿保存在当前浏览器。隐私模式、清理浏览器数据或更换设备都会丢失，重要内容请导出备份。' },
        { title: '账号与作品', detail: '登录后点击保存，场景与上传的图片会写入托管服务，并按账号隔离。' },
        { title: 'AI 生成', detail: '提交 Agent 请求时，提示词、当前场景与参考截图会发送到服务端配置的模型与图片服务。' },
        { title: 'MCP 访问', detail: 'MCP 使用管理员配置的实例令牌和独立场景库，不共用 Web 登录会话或“我的作品”，也不提供匿名调用。' },
      ],
      recovery: '当前未实现邮箱验证、邮箱找回密码或第三方登录；忘记密码需由自托管管理员处理。',
      payment: '托管站点不接入支付；商业 API key、额度与计费尚未实现。',
      cloudNote: '本机草稿没有云端备份；只有保存到账号的内容才会出现在“我的作品”。',
    },
  },
  en: {
    label: 'Docs',
    title: 'From your browser to your toolchain.',
    lede: 'Start editing now, and see the real boundaries of accounts, AI and MCP.',
    source: 'Source code',
    tabs: { web: 'Web studio', mcp: 'MCP / API', templates: 'Templates & real UI', privacy: 'Data & privacy' },
    web: {
      tag: 'No account needed',
      title: 'A conversation studio in the browser',
      body: 'Open the studio and use the local example without signing in. Editing, preview and export all happen in this browser.',
      steps: [
        { title: 'Pick a story', detail: 'Start from the scene library, or create a blank scene in the studio.' },
        { title: 'Select a message, edit the detail', detail: 'Change a line, a sender or a time. The preview updates live and edits can be undone.' },
        { title: 'Keep the frame you want', detail: 'Export a short screenshot or a long capture, or download the scene as JSON.' },
      ],
      callout: 'After signing in to the hosted service you can save work and use the Agent for generation and screenshot-based editing; the server must have a model configured.',
      cta: 'Open Agent creation',
    },
    mcp: {
      tag: 'Instance token',
      title: 'Let an Agent use the same renderer',
      body: 'Web, MCP and the API share a scene format and renderer; MCP keeps a separate scene store. AI interprets the edit; the deterministic renderer owns the layout.',
      authTitle: 'How access works',
      auth: [
        'MCP uses an administrator-configured Bearer token and a scene store separate from Web accounts.',
        'Anonymous or public free calls are not offered; commercial API keys and pricing are not implemented.',
        'The instance token grants access to its MCP scene store. Share it only with trusted clients and rotate it if leaked.',
      ],
      callout: 'MCP ships with the server and requires an instance token. It does not share Web account sessions or saved scenes.',
      link: 'Read the MCP notes in the repository',
    },
    templates: {
      title: 'Real UI needs real references',
      body: 'Templates are visual approximations. WeChat and WhatsApp come first; pixel calibration for a specific app or OS version is still pending.',
      steps: [
        { title: 'Capture authorised reference screenshots', detail: 'Use a test account and synthetic conversation, and record platform, OS, version, device and font settings.' },
        { title: 'Build a component reference library', detail: 'Separate status bar, navigation, avatars, messages, times and cards. Do not mix rules from different versions.' },
        { title: 'Render the same scene side by side', detail: 'Fix fonts and sizes, check layout, text and key states item by item, and only then claim accurate reconstruction.' },
      ],
      callout: 'Image generation is good for media inside a chat. The chat interface itself should be rendered by code so edits stay controllable and text stays accurate.',
      link: 'Apple system design resources',
    },
    privacy: {
      title: 'Where your data goes',
      body: 'Editing the public site without an account stays in browser memory; data leaves the browser only when you explicitly save or use AI.',
      items: [
        { title: 'Local drafts', detail: 'Studio drafts live in this browser. Private windows, clearing browser data or changing device lose them, so export anything important.' },
        { title: 'Account and work', detail: 'After you sign in and press save, scenes and uploaded images are written to the hosted service and isolated per account.' },
        { title: 'AI generation', detail: 'Submitting an Agent request sends the prompt, current scene and reference screenshots to the model and image services configured on the server.' },
        { title: 'MCP access', detail: 'MCP uses an administrator-configured instance token and a separate scene store; it does not share Web account sessions or saved scenes.' },
      ],
      recovery: 'Email verification, email password recovery and third-party sign-in are not implemented; a self-hosted admin handles forgotten passwords.',
      payment: 'The hosted site takes no payment; commercial API keys, quotas and billing are not implemented.',
      cloudNote: 'Local drafts have no cloud backup — only work saved to an account appears under “My scenes”.',
    },
  },
};
