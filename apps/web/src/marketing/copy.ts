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
  footer: { tagline: string; templates: string; docs: string; github: string; license: string; terms: string; privacy: string; note: string };
  notFound: { title: string; body: string; back: string };
  loading: string;
  storageNotice: string;
  description: string;
  titles: { home: string; create: string; studio: string; templates: string; docs: string; login: string; register: string; workspace: string; account: string; projects: string; fallback: string };
}

export const SITE_COPY: Record<Locale, SiteCopy> = {
  zh: {
    skip: '跳到主要内容',
    nav: { main: '主导航', home: 'IMStage 首页', projects: '项目', templates: '模板', docs: '使用与接入', openSource: 'GitHub 开源仓库', login: '登录', account: '账号', workspace: '我的作品', start: '开始创作' },
    theme: { group: '外观主题', light: '浅色', dark: '深色', system: '跟随系统' },
    locale: { group: '界面语言', zh: '中文', en: 'EN' },
    menu: { open: '打开导航', close: '关闭导航' },
    footer: { tagline: '合成对话，用于测试与评测。', templates: '模板', docs: '使用与接入', github: 'GitHub', license: '源码可得 · 不可商用', terms: '使用条款', privacy: '隐私与留存', note: '仅供测试与学习 · 禁止伪造证据、欺诈、诽谤与冒充 · AI 生成虚构内容' },
    notFound: { title: '这个场景还没有开场。', body: '页面不存在，回到首页继续创作。', back: '返回首页' },
    loading: '正在准备…',
    storageNotice: '当前浏览器无法保存主题偏好，本次切换仍然有效。',
    description: 'IMStage：合成聊天场景与评测数据集标注创作工具。仅供测试与学习，不得用于伪造证据、欺诈、诽谤或冒充；导出图片固定带有 AI生成/虚构 标识。',
    titles: {
      home: '合成对话，用于测试与评测',
      create: '一句话创作',
      studio: '工作台',
      templates: '模板',
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
    nav: { main: 'Main navigation', home: 'IMStage home', projects: 'Projects', templates: 'Templates', docs: 'Docs', openSource: 'GitHub repository', login: 'Sign in', account: 'Account', workspace: 'My scenes', start: 'Start creating' },
    theme: { group: 'Appearance', light: 'Light', dark: 'Dark', system: 'System' },
    locale: { group: 'Interface language', zh: '中文', en: 'EN' },
    menu: { open: 'Open navigation', close: 'Close navigation' },
    footer: { tagline: 'Synthetic conversations for tests & evaluation.', templates: 'Templates', docs: 'Docs', github: 'GitHub', license: 'Source-available · non-commercial', terms: 'Terms', privacy: 'Privacy & retention', note: 'Testing and learning only · no fabricated evidence, fraud, defamation or impersonation · AI-generated fiction' },
    notFound: { title: 'This scene never opened.', body: 'The page does not exist. Head back home.', back: 'Back home' },
    loading: 'Getting ready…',
    storageNotice: 'This browser cannot save the theme preference; the change still applies for this session.',
    description: 'IMStage authors synthetic chat scenes and evaluation dataset annotations. Testing and learning only — never fabricated evidence, fraud, defamation or impersonation. Every export carries a fixed AI-generated / fictional label.',
    titles: {
      home: 'Synthetic conversations for tests & evaluation',
      create: 'Create from a sentence',
      studio: 'Studio',
      templates: 'Templates',
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
  openDocs: string;
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
    eyebrow: '合成聊天测试与评测数据集创作工具',
    h1a: '一句话，',
    h1b: '生成一份合成对话数据。',
    promise: '为测试、教学与评测标注生成虚构对话，全部可编辑、可导出。',
    promptLabel: '你的指令',
    promptHint: '写下你的指令；点击发送后立即开始一次 AI 创作。',
    promptPlaceholder: '描述一个待生成的合成对话场景。',
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
    previewNote: '通用 IMStage 聊天 · 中文',
    synthetic: '合成示例 · 非真实聊天',
    capabilitiesLabel: '可以做什么',
    capabilitiesTitle: '四件事，做到可靠。',
    capabilities: [
      { title: '直接编辑', detail: '改一句台词、一个名字、一个时间。' },
      { title: '通用渲染', detail: '同一份场景渲染为通用 IMStage 聊天界面，不复刻任何真实平台。' },
      { title: '截图导出', detail: '普通截图或完整长图，导出真实 PNG，固定带 AI生成/虚构 标识。' },
      { title: 'Agent 与 MCP', detail: '在网页或 ChatGPT 中创作合成数据集，继续编辑同一份作品。' },
    ],
    useCases: ['测试样本', '教学示例', '评测数据集', '标注素材'],
    scenariosLabel: '场景起点',
    scenariosTitle: '让下一份内容，更有画面。',
    scenariosLede: '产品演示、沟通培训，或一个好故事。选一段，写成你的版本。',
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
    openLabel: '源码与自托管',
    openTitle: '代码在你手里。',
    openLede: '源码可得（非商业许可），可自行托管用于测试与学习。账号、作品库与 Agent 由服务端提供，模型凭据只在服务端读取。',
    openRows: [
      { title: '浏览器本地编辑', detail: '免登录可用，草稿只保存在当前浏览器。', tag: '已实现' },
      { title: '账号与 Agent', detail: '注册账号后保存作品，并使用已配置模型的 Agent 创作。', tag: '托管已部署' },
      { title: 'MCP 与 API', detail: '通过登录授权接入 ChatGPT，或为其他客户端生成个人访问令牌。', tag: '账号授权' },
    ],
    openGithub: '在 GitHub 查看',
    openDocs: '接入与自托管',
    faqLabel: '细节说明',
    faqTitle: '开始之前。',
    faq: [
      { q: '页面上这些对话是真的吗？', a: '不是。所有输出都是为测试、教学与评测数据集标注生成的合成内容，不证明任何真实人物说过或做过什么，也不能作为真实对话的证据。人物与地点可以是虚构素材，也可以是你有权使用的真实素材（如授权头像、真实地名）。每张预览与导出图片都固定带「AI生成 / 虚构」标识，无法关闭。' },
      { q: '可以用来伪造聊天记录、转账记录或证据吗？', a: '不可以。支付、转账、红包、余额类消息已全面移除；严禁伪造证据、欺诈、诽谤、冒充他人或误导他人，违者自负责任。真实截图参考编辑已停用，不提供重建真实截图的流程；上传素材请只使用虚构或已获授权的内容。' },
      { q: '我的内容保存在哪里？', a: '试用页面的编辑只存在内存中，刷新即消失。工作台草稿自动保存在当前浏览器；登录后自动同步到服务器，按账号隔离。匿名的本地编辑与导出不上传场景内容，也不会留下服务端审计记录（页面仍会加载静态资源并产生常规访问日志），详见隐私说明。托管生成会记录最小化审计（运行 id、时间、账号、策略版本、状态与场景哈希，不含原文或图片），保留 90 天并由周期性清理任务删除；保存的作品、项目规则与批量提示词属于运营数据，部署侧备份另保留 14 个版本。' },
      { q: '可以导出什么？', a: '普通截图或包含完整对话的长图 PNG，也可以下载 JSON 场景数据。所有导出（含裁切与 MCP 渲染）都带固定的 AI生成/虚构 标识。' },
      { q: '托管服务和 MCP 怎么收费？', a: '源码许可为非商业的源码可得许可，仅供测试、学习与研究；浏览器本地编辑免费。商业使用仅限另行书面约定的私有/闭源测试与评测数据集及标注交付，接受邮件咨询；联系邮箱见使用条款页，暂未公布时会在该页注明。' },
    ],
    ctaTitle: '下一段对话，等你开场。',
    ctaBody: '免登录试改与导出，或进入工作台开始新的场景。',
    ctaAction: '开始创作',
    footerNote: '合成示例 · 非真实聊天',
  },
  en: {
    eyebrow: 'Synthetic chat authoring for tests & evaluation datasets',
    h1a: 'One prompt.',
    h1b: 'A synthetic dataset entry.',
    promise: 'Fictional conversations for tests, teaching and evaluation annotations — all editable, all exportable.',
    promptLabel: 'Your instruction',
    promptHint: 'Write your instruction; sending starts one AI run.',
    promptPlaceholder: 'Describe the synthetic conversation you need.',
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
    previewNote: 'Generic IMStage chat · English',
    synthetic: 'Synthetic demo · not a real chat',
    capabilitiesLabel: 'What it does',
    capabilitiesTitle: 'Four things, done properly.',
    capabilities: [
      { title: 'Edit directly', detail: 'One line, one name, one timestamp.' },
      { title: 'Generic renderer', detail: 'One independent IMStage chat UI — never a clone of a real platform.' },
      { title: 'Screenshot output', detail: 'Short or long capture, exported as real PNG with the fixed AI-generated / fictional label.' },
      { title: 'Agent & MCP', detail: 'Author dataset scenes on the web or in ChatGPT, then keep editing the same scene.' },
    ],
    useCases: ['Test fixtures', 'Teaching', 'Evaluation datasets', 'Annotations'],
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
    openLabel: 'Source & self-hosting',
    openTitle: 'The code is yours.',
    openLede: 'Source-available under a non-commercial license for testing and learning; self-hostable. Accounts, the scene library and the Agent run on the server; model credentials are read only there.',
    openRows: [
      { title: 'Local editing', detail: 'Works without an account; drafts stay in this browser.', tag: 'Implemented' },
      { title: 'Account & Agent', detail: 'Create an account to save work and generate with a configured model.', tag: 'Hosted' },
      { title: 'MCP & API', detail: 'Authorize ChatGPT with your account, or create a personal token for another client.', tag: 'Account access' },
    ],
    openGithub: 'View on GitHub',
    openDocs: 'Setup & self-hosting',
    faqLabel: 'The details',
    faqTitle: 'Before you start.',
    faq: [
      { q: 'Are these conversations real?', a: 'No. All output is synthetic content for tests, teaching and evaluation annotations — it proves nothing that any real person said or did and must never be used as evidence of a real conversation. People and places may be fictional or real material you are authorised to use (an authorised avatar, a real place name). Every preview and export carries a fixed “AI生成 / 虚构” (AI-generated / Fictional) label that cannot be disabled.' },
      { q: 'Can I fabricate chat logs, payment records or evidence?', a: 'No. Payment, transfer, red-packet and balance messages are removed entirely. Fabricating evidence, fraud, defamation, impersonation and misleading use are prohibited. Real-screenshot reference editing is disabled and no real-screenshot rebuild workflow is offered; upload only fictional or properly authorised material.' },
      { q: 'Where is my work saved?', a: 'Edits on this page live in memory and disappear on reload. Studio drafts save in this browser and sync to the server after sign-in, isolated per account. Anonymous local editing and export upload no scene contents and create no server audit record (the page still loads static assets and ordinary access logs exist) — see the privacy notes. Hosted generation records a minimal audit (run id, time, account, policy version, status and scene hash — never prompts or images) with a 90-day primary retention cleaned up periodically; saved scenes, project rules and batch prompts are operational data and deploy-side backups keep 14 versions.' },
      { q: 'What can I export?', a: 'A short screenshot or a long PNG capture, plus the scene as JSON. Every export (including crops and MCP renders) carries the fixed AI-generated / fictional label.' },
      { q: 'How is hosting or commercial use priced?', a: 'The source-available license is non-commercial (testing, learning and research only); local editing is free. Commercial use is limited to separately agreed private / closed-source test and evaluation datasets and annotation deliverables, arranged by email enquiry; the contact address is listed on the terms page and marked “not published yet” until one exists.' },
    ],
    ctaTitle: 'Your next conversation starts here.',
    ctaBody: 'Edit and export without an account, or open the studio and begin a new scene.',
    ctaAction: 'Start creating',
    footerNote: 'Synthetic demo · not a real chat',
  },
};
