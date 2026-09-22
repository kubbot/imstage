/**
 * Bilingual copy for the public website.
 *
 * One source of truth for the landing page, the marketing navigation/footer
 * and the document title/description, so the two languages can never drift
 * apart. Keep sentences short: the page promises, it does not lecture.
 */
import type { Locale } from './locale';

export interface SiteCopy {
  skip: string;
  nav: { main: string; home: string; projects: string; templates: string; docs: string; openSource: string; login: string; account: string; workspace: string; start: string };
  theme: { group: string; light: string; dark: string; system: string };
  locale: { group: string; zh: string; en: string };
  menu: { open: string; close: string };
  footer: { tagline: string; templates: string; docs: string; github: string; license: string; note: string };
  notFound: { title: string; body: string; back: string };
  loading: string;
  storageNotice: string;
  description: string;
  titles: { home: string; create: string; studio: string; templates: string; docs: string; login: string; register: string; workspace: string; account: string; projects: string; fallback: string };
}

export const SITE_COPY: Record<Locale, SiteCopy> = {
  zh: {
    skip: '跳到主要内容',
    nav: { main: '主导航', home: 'IMStage 首页', projects: '项目', templates: '场景灵感', docs: '使用与接入', openSource: 'GitHub 开源仓库', login: '登录', account: '账号', workspace: '我的作品', start: '开始创作' },
    theme: { group: '外观主题', light: '浅色', dark: '深色', system: '跟随系统' },
    locale: { group: '界面语言', zh: '中文', en: 'EN' },
    menu: { open: '打开导航', close: '关闭导航' },
    footer: { tagline: '给每段对话，一个舞台。', templates: '场景灵感', docs: '使用与接入', github: 'GitHub', license: 'MIT License', note: '为设计、教学与虚构叙事而作' },
    notFound: { title: '这个场景还没有开场。', body: '页面不存在，回到首页继续创作。', back: '返回首页' },
    loading: '正在准备…',
    storageNotice: '当前浏览器无法保存主题偏好，本次切换仍然有效。',
    description: 'IMStage，开源聊天场景创作工具。写一句指令，让 AI 写出对白、生成画面，再导出 PNG。',
    titles: {
      home: '一句话，让故事发生',
      create: '一句话创作',
      studio: '工作台',
      templates: '场景灵感',
      docs: '使用与接入',
      login: '登录',
      register: '注册',
      workspace: '我的作品',
      account: '账号设置',
      projects: '项目',
      fallback: '让对话，成为作品',
    },
  },
  en: {
    skip: 'Skip to content',
    nav: { main: 'Main navigation', home: 'IMStage home', projects: 'Projects', templates: 'Scenes', docs: 'Docs', openSource: 'GitHub repository', login: 'Sign in', account: 'Account', workspace: 'My scenes', start: 'Start creating' },
    theme: { group: 'Appearance', light: 'Light', dark: 'Dark', system: 'System' },
    locale: { group: 'Interface language', zh: '中文', en: 'EN' },
    menu: { open: 'Open navigation', close: 'Close navigation' },
    footer: { tagline: 'A stage for every conversation.', templates: 'Scenes', docs: 'Docs', github: 'GitHub', license: 'MIT License', note: 'Made for design, teaching and fiction' },
    notFound: { title: 'This scene never opened.', body: 'The page does not exist. Head back home.', back: 'Back home' },
    loading: 'Getting ready…',
    storageNotice: 'This browser cannot save the theme preference; the change still applies for this session.',
    description: 'IMStage is an open-source conversation staging tool. Write one prompt, let AI write the dialogue and create the image, then export a PNG.',
    titles: {
      home: 'One prompt. A story unfolds.',
      create: 'Create from a sentence',
      studio: 'Studio',
      templates: 'Scenes',
      docs: 'Docs',
      login: 'Sign in',
      register: 'Create account',
      workspace: 'My scenes',
      account: 'Account settings',
      projects: 'Projects',
      fallback: 'Turn a conversation into a keepsake',
    },
  },
};

export interface LandingCopy {
  eyebrow: string;
  h1a: string;
  h1b: string;
  promise: string;
  promptLabel: string;
  promptHint: string;
  promptPlaceholder: string;
  needPrompt: string;
  primary: string;
  secondary: string;
  exporting: string;
  exportDone: string;
  exportFail: string;
  retry: string;
  avatarLoading: string;
  avatarError: string;
  avatarRetry: string;
  photoLoading: string;
  photoError: string;
  photoRetry: string;
  storyLabel: string;
  storyProcess: string;
  storyIdle: string;
  storyPlaying: string;
  storyPaused: string;
  storyDone: string;
  storyControls: string;
  storyPause: string;
  storyResume: string;
  storyPlay: string;
  storyReplay: string;
  storyShowResult: string;
  storyBoundary: string;
  storyPreparing: string;
  handoffLoading: string;
  handoffStorage: string;
  photoZoom: string;
  photoClose: string;
  photoCaption: string;
  previewNote: string;
  synthetic: string;
  capabilitiesLabel: string;
  capabilitiesTitle: string;
  capabilities: readonly { title: string; detail: string }[];
  useCases: readonly string[];
  scenariosLabel: string;
  scenariosTitle: string;
  scenariosLede: string;
  scenarioUse: string;
  scenarioActive: string;
  contrastLabel: string;
  contrastTitleA: string;
  contrastTitleB: string;
  contrastLede: string;
  fields: { person: string; line: string; clock: string };
  personPlaceholder: string;
  linePlaceholder: string;
  clockPlaceholder: string;
  exportAction: string;
  exportPreparing: string;
  exportReady: string;
  exportPreviewLabel: string;
  exportCaption: string;
  exportRegenerate: string;
  exportError: string;
  reset: string;
  contrastNote: string;
  openLabel: string;
  openTitle: string;
  openLede: string;
  openRows: readonly { title: string; detail: string; tag: string }[];
  openGithub: string;
  faqLabel: string;
  faqTitle: string;
  faq: readonly { q: string; a: string }[];
  ctaTitle: string;
  ctaBody: string;
  ctaAction: string;
  footerNote: string;
}

export const LANDING_COPY: Record<Locale, LandingCopy> = {
  zh: {
    eyebrow: '开源的聊天场景创作工具',
    h1a: '一句话，',
    h1b: '让故事发生。',
    promise: 'AI 写对白、生成画面，全部可编辑。',
    promptLabel: '你的指令',
    promptHint: '写下你的指令；点击发送后立即开始一次 AI 创作。',
    promptPlaceholder: '描述一个场景，例如一次见面的地点。',
    primary: '发送并创建',
    needPrompt: '先写下一句指令，再交给 AI 创作。',
    secondary: '导出这张画面',
    exporting: '正在导出 PNG…',
    exportDone: 'PNG 已导出。',
    exportFail: '导出失败，请重试。',
    retry: '重试',
    avatarLoading: '正在载入合成头像…',
    avatarError: '合成头像加载失败，画面暂用文字头像。',
    avatarRetry: '重新加载头像',
    photoLoading: '正在载入示例照片…',
    photoError: '示例照片加载失败，暂不能导出完整画面。',
    photoRetry: '重新加载照片',
    storyLabel: 'AI 合成示例 · 可重播',
    storyProcess: '示例过程',
    storyIdle: '准备回放',
    storyPlaying: '回放中',
    storyPaused: '已暂停',
    storyDone: '回放完成 · 全部可编辑',
    storyControls: '示例回放控制',
    storyPause: '暂停',
    storyResume: '继续',
    storyPlay: '播放',
    storyReplay: '重播',
    storyShowResult: '查看完整结果',
    storyBoundary: '此处为合成示例回放；AI 创作由你点击发送。',
    storyPreparing: '正在生成照片…',
    handoffLoading: '场景还在准备，暂时不能带到创作页。',
    handoffStorage: '浏览器无法暂存这份场景，暂时不能带到创作页；请释放存储空间后重试。',
    photoZoom: '放大照片',
    photoClose: '关闭大图',
    photoCaption: 'AI 合成照片 · 非真实人物',
    previewNote: '微信 · 中文',
    synthetic: '合成示例 · 非真实聊天',
    capabilitiesLabel: '可以做什么',
    capabilitiesTitle: '四件事，做到可靠。',
    capabilities: [
      { title: '直接编辑', detail: '改一句台词、一个名字、一个时间。' },
      { title: '真实渲染', detail: '同一份场景渲染微信与 WhatsApp 等模板。' },
      { title: '截图导出', detail: '普通截图或完整长图，导出真实 PNG。' },
      { title: 'Agent 与 MCP', detail: '服务端工具循环；MCP 通过实例令牌使用独立场景库。' },
    ],
    useCases: ['产品演示', '教学示例', '叙事素材', '合成评测'],
    scenariosLabel: '场景起点',
    scenariosTitle: '从一个场景开始。',
    scenariosLede: '都是合成的日常对话，可以直接改。',
    scenarioUse: '用这个场景开始',
    scenarioActive: '当前场景',
    contrastLabel: '从一句话到一张图',
    contrastTitleA: '改一个词，',
    contrastTitleB: '画面跟着变。',
    contrastLede: '人物、台词和时间各自修改，不会打乱其他内容。',
    fields: { person: '对话的人', line: '我说的话', clock: '画面时间' },
    personPlaceholder: '写下名字',
    linePlaceholder: '写下你要说的话',
    clockPlaceholder: '例如 15:02',
    exportAction: '导出 PNG',
    exportPreparing: '正在生成导出预览…',
    exportReady: '这是真实导出的 PNG 文件，不是贴图。',
    exportPreviewLabel: '导出结果',
    exportCaption: '导出文件不包含编辑高亮与操作控件。',
    exportRegenerate: '重新生成预览',
    exportError: '导出预览生成失败，可以重试。',
    reset: '回到初始',
    contrastNote: '预览与导出读取同一份场景。',
    openLabel: '开源与自托管',
    openTitle: '代码在你手里。',
    openLede: '前端可静态托管；账号、作品库与 Agent 由 Node 服务提供，模型凭据只在服务端读取。',
    openRows: [
      { title: '浏览器本地编辑', detail: '免登录可用，草稿只保存在当前浏览器。', tag: '已实现' },
      { title: '账号与 Agent', detail: '注册账号后保存作品，并使用已配置模型的 Agent 创作。', tag: '托管已部署' },
      { title: 'MCP 与 API', detail: 'MCP 使用管理员配置的实例令牌与独立场景库；商业 API key 尚未实现。', tag: '令牌访问' },
    ],
    openGithub: '在 GitHub 查看',
    faqLabel: '细节说明',
    faqTitle: '开始之前。',
    faq: [
      { q: '页面上这些对话是真的吗？', a: '不是。所有场景、人物头像、时间与地点都是合成的虚构内容，仅用于演示工具，不代表任何真实聊天、真人身份或交易记录。' },
      { q: '我的内容保存在哪里？', a: '试用页面的编辑只在当前页面内存中，刷新即消失。进入工作台后，草稿保存在当前浏览器；登录账号并点击保存后，场景与素材会写入托管服务，按账号隔离。清理浏览器数据会删除本机草稿。' },
      { q: '可以导出什么？', a: '可以导出普通截图或包含完整对话的长图 PNG，也可以下载 JSON 场景数据。导出尺寸由设备配置决定，例如 iPhone 17 Pro 为 1206 × 2622。' },
      { q: '能还原真实 App 的截图吗？', a: '目前是视觉近似，尚未针对具体系统与 App 版本做像素级校准。请用于设计、教学和虚构叙事，不要当作真实截图证据。' },
      { q: '托管服务和 MCP 怎么收费？', a: '项目采用 MIT 许可，浏览器本地编辑免费。托管站点已可注册使用；AI 能力需要服务端配置模型。MCP 使用实例令牌和独立场景库，不开放匿名调用，定价与商业 API key 尚未实现。' },
    ],
    ctaTitle: '下一段对话，等你开场。',
    ctaBody: '免登录试改与导出，或进入工作台开始新的场景。',
    ctaAction: '开始创作',
    footerNote: '合成示例 · 非真实聊天',
  },
  en: {
    eyebrow: 'Open-source conversation staging',
    h1a: 'One prompt.',
    h1b: 'A story unfolds.',
    promise: 'AI writes the dialogue and creates the image — all editable.',
    promptLabel: 'Your instruction',
    promptHint: 'Write your instruction; sending starts one AI run.',
    promptPlaceholder: 'Describe a scene, for example a place to meet.',
    primary: 'Send & create',
    needPrompt: 'Write an instruction before handing it to AI.',
    secondary: 'Export this frame',
    exporting: 'Exporting PNG…',
    exportDone: 'PNG exported.',
    exportFail: 'Export failed. Please try again.',
    retry: 'Retry',
    avatarLoading: 'Loading synthetic avatars…',
    avatarError: 'Synthetic avatars failed to load; using text avatars.',
    avatarRetry: 'Reload avatars',
    photoLoading: 'Loading the example photo…',
    photoError: 'The example photo failed to load; the full frame cannot be exported yet.',
    photoRetry: 'Reload photo',
    storyLabel: 'AI-made example · Replayable',
    storyProcess: 'Authored process',
    storyIdle: 'Ready to replay',
    storyPlaying: 'Replaying',
    storyPaused: 'Paused',
    storyDone: 'Replay complete · fully editable',
    storyControls: 'Example playback controls',
    storyPause: 'Pause',
    storyResume: 'Resume',
    storyPlay: 'Play',
    storyReplay: 'Replay',
    storyShowResult: 'Show result',
    storyBoundary: 'A synthetic example replay; you press send when you create with AI.',
    storyPreparing: 'Creating the photo…',
    handoffLoading: 'The scene is still preparing, so it cannot be carried to the studio yet.',
    handoffStorage: 'This browser cannot stage the scene, so it cannot be carried to the studio. Free some storage and retry.',
    photoZoom: 'View photo larger',
    photoClose: 'Close photo',
    photoCaption: 'AI-made photo · fictional person',
    previewNote: 'WhatsApp · English',
    synthetic: 'Synthetic demo · not a real chat',
    capabilitiesLabel: 'What it does',
    capabilitiesTitle: 'Four things, done properly.',
    capabilities: [
      { title: 'Edit directly', detail: 'One line, one name, one timestamp.' },
      { title: 'Real renderer', detail: 'WeChat, WhatsApp and more from one scene.' },
      { title: 'Screenshot output', detail: 'Short or long capture, exported as real PNG.' },
      { title: 'Agent & MCP', detail: 'Server-side tool loop; MCP uses an instance token and a separate scene store.' },
    ],
    useCases: ['Product demos', 'Teaching', 'Storytelling', 'Synthetic fixtures'],
    scenariosLabel: 'Starting points',
    scenariosTitle: 'Start from a scene.',
    scenariosLede: 'Synthetic everyday conversations you can edit right away.',
    scenarioUse: 'Use this scene',
    scenarioActive: 'Current scene',
    contrastLabel: 'From one line to one file',
    contrastTitleA: 'Change one word,',
    contrastTitleB: 'the frame follows.',
    contrastLede: 'Names, lines and the clock change one at a time, without disturbing the rest.',
    fields: { person: 'The other person', line: 'Your line', clock: 'Phone clock' },
    personPlaceholder: 'Write a name',
    linePlaceholder: 'Write your line',
    clockPlaceholder: 'For example 15:02',
    exportAction: 'Export PNG',
    exportPreparing: 'Generating the export preview…',
    exportReady: 'This is a real exported PNG file, not a mock-up.',
    exportPreviewLabel: 'Exported file',
    exportCaption: 'The file contains no editor highlights or controls.',
    exportRegenerate: 'Regenerate preview',
    exportError: 'The export preview could not be generated. Try again.',
    reset: 'Reset',
    contrastNote: 'Preview and export read the same scene.',
    openLabel: 'Open source & self-hosting',
    openTitle: 'The code is yours.',
    openLede: 'The frontend can be hosted statically; accounts, the scene library and the Agent are served by Node, and model credentials are read only on the server.',
    openRows: [
      { title: 'Local editing', detail: 'Works without an account; drafts stay in this browser.', tag: 'Implemented' },
      { title: 'Account & Agent', detail: 'Create an account to save work and generate with a configured model.', tag: 'Hosted' },
      { title: 'MCP & API', detail: 'MCP uses an administrator-configured instance token and a separate store; commercial API keys are not implemented.', tag: 'Token access' },
    ],
    openGithub: 'View on GitHub',
    faqLabel: 'The details',
    faqTitle: 'Before you start.',
    faq: [
      { q: 'Are these conversations real?', a: 'No. Every scene, avatar, timestamp and place is synthetic fiction used to demonstrate the tool. Nothing here represents a real chat, a real person or a transaction.' },
      { q: 'Where is my work saved?', a: 'Edits on this page live in memory and disappear on reload. In the studio, drafts are stored in this browser; after you sign in and save, scenes and media are written to the hosted service, isolated per account. Clearing browser data deletes local drafts.' },
      { q: 'What can I export?', a: 'A short screenshot or a long capture of the full conversation as PNG, plus the scene as JSON. Output size follows the device profile — an iPhone 17 Pro export is 1206 × 2622.' },
      { q: 'Does it recreate real app screenshots?', a: 'It is a visual approximation and is not pixel-certified against a specific app or OS version. Use it for design, teaching and fiction, not as screenshot evidence.' },
      { q: 'How are hosting and MCP priced?', a: 'The project is MIT-licensed and local editing is free. The hosted site is open for registration; AI features need a model configured on the server. MCP uses an instance token and separate scene store rather than anonymous calls, and pricing and commercial API keys are not implemented.' },
    ],
    ctaTitle: 'Your next conversation starts here.',
    ctaBody: 'Edit and export without an account, or open the studio and begin a new scene.',
    ctaAction: 'Start creating',
    footerNote: 'Synthetic demo · not a real chat',
  },
};
