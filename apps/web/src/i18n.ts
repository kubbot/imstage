/**
 * Centralised zh/en interface copy for the creator workspace.
 *
 * Rules:
 * - Interface, status and default-example text is translated here.
 * - User content, persisted names, provider output and protocol enums are never
 *   translated (they stay exactly as stored/served).
 * - The Chinese strings intentionally match the pre-existing UI so the
 *   deterministic suites keep asserting the same labels.
 * - No runtime DOM text rewriting: every consumer reads the typed value.
 */
import { useMemo } from 'react';
import { useLocale } from './marketing/LocaleContext';
import type { Locale } from './marketing/locale';
import type { MessageType, Platform } from './studio/model';

export type { Locale };

export interface CommonCopy {
  retry: string;
  cancel: string;
  close: string;
  save: string;
  saved: string;
  loading: string;
  offline: string;
  conflict: string;
  signIn: string;
  signInToSave: string;
  dismiss: string;
}

export interface SessionsCopy {
  reading: string;
  savedLocal: string;
  saving: string;
  waiting: string;
  notSaved: string;
  saveFailed: string;
  manage: string;
  busySwitch: string;
  newSession: string;
  newSessionHint: string;
  retrySave: string;
  saveAsNew: string;
  listLabel: string;
  listTitle: string;
  closeList: string;
  searchLabel: string;
  searchPlaceholder: string;
  noResults: string;
  nameLabel: string;
  saveName: string;
  openSession: (title: string) => string;
  current: string;
  messages: (count: number) => string;
  rename: (title: string) => string;
  renameTitle: string;
  duplicate: string;
  deleteLabel: (title: string) => string;
  deleteTitle: string;
  deleteConfirm: (title: string) => string;
  confirmDelete: string;
  keep: string;
  footer: string;
  restoring: string;
  retryRead: string;
  openScene: string;
  duplicateSuffix: string;
  openFailed: string;
  actionFailed: string;
}

export interface AgentCopy {
  panelLabel: string;
  panelBusy: string;
  leftPanelLabel: string;
  tabAi: string;
  tabElements: string;
  expandWide: string;
  expandNarrow: string;
  expandHint: string;
  contextSummary: string;
  standalone: string;
  readingPeople: string;
  peopleFailed: string;
  defaultPerson: (name: string) => string;
  defaultPersonUnset: string;
  configure: string;
  projectRules: string;
  currentProject: string;
  manageProjects: string;
  sampleLink: string;
  dropTitle: string;
  dropOr: string;
  ideas: readonly string[];
  capabilitiesError: string;
  capabilityConnected: (model: string) => string;
  capabilityImageReady: string;
  capabilityImageMissing: string;
  capabilityModelMissing: string;
  capabilityConnecting: string;
  keepScreenshot: string;
  keepScreenshotNotice: string;
  imageReadFailed: string;
  composerLabel: string;
  composerPlaceholder: string;
  composerEditPlaceholder: string;
  composerEditSelected: string;
  composerEditAll: string;
  composerScopeAll: string;
  composerScopeOnly: (label: string) => string;
  composerScopeSwitch: string;
  composerShortcut: string;
  send: string;
  sendEdit: string;
  stop: string;
  loginCreate: string;
  uploadHint: string;
  dragWaiting: string;
  dragReady: string;
  dragFormats: string;
  dropEntry: string;
  dropEntryAction: string;
  welcomeLabel: string;
  mobileChat: string;
  mobileCanvas: string;
  mobileBusy: string;
  undo: string;
  redo: string;
  more: string;
  downloadJson: string;
  downloadSceneJson: string;
  errorStorage: string;
  closeNotice: string;
  platform: string;
  device: string;
  genericDevice: string;
  updating: string;
  editLayers: (count: number) => string;
  messageCount: (count: number) => string;
  exportRange: string;
  longShot: string;
  standardShot: string;
  copyPng: string;
  copying: string;
  exportPng: string;
  exporting: string;
  copyReady: string;
  copyInstruction: string;
  copyDownload: string;
  copyAlt: string;
  canvasEmptyTitle: string;
  canvasEmptyBody: string;
  canvasCaption: (label: string, width: number, height: number, full: boolean) => string;
  canvasCaptionFullHeight: string;
  canvasPointHint: string;
  pointHint: string;
  zoomOut: string;
  zoomFit: string;
  zoomIn: string;
  elements: string;
  inspectorLabel: string;
  inspectorSelectionAll: string;
  inspectorMessage: (index: number) => string;
  inspectorPerson: string;
  inspectorPatch: string;
  inspectorFrame: string;
  inspectorClose: string;
  inspectorProperties: string;
  inspectorAi: string;
  inspectorAiTitleSelected: (label: string) => string;
  inspectorAiTitleAll: string;
  inspectorAiIntro: string;
  inspectorAiEntry: (selected: boolean) => string;
  inspectorAiNote: string;
  inspectorSuggestionsMessage: readonly string[];
  inspectorSuggestionsPerson: readonly string[];
  inspectorSuggestionsAll: readonly string[];
  peopleTitle: string;
  peopleClose: string;
  transcriptAi: string;
  transcriptEdit: string;
  transcriptYou: string;
  transcriptModel: string;
  transcriptScoped: string;
  transcriptAttachments: string;
  transcriptAttachmentAlt: (index: number) => string;
  transcriptSubmitted: string;
  transcriptTools: (count: number) => string;
  transcriptToolRunning: string;
  transcriptToolError: string;
  intentInterrupted: string;
  intentFailed: string;
  intentRetry: string;
  intentDismiss: string;
  intentPersistFailed: string;
  intentQueued: string;
  thinking: string;
  sceneUpdated: string;
  sceneUpdatedShort: string;
  peopleSaved: string;
  peopleSaveFailed: (message: string) => string;
  stopped: string;
  generateFailed: string;
  noChanges: string;
  signInToCreate: string;
  maxAttachments: string;
  extraAttachments: string;
  exportPreparing: string;
  exportDone: string;
  exportFailed: string;
  copyPreparing: string;
  copyDone: string;
  copyBlocked: string;
  copyFailed: string;
  renderFailed: string;
  frameNotReady: string;
  imageFailed: string;
  attachmentAlt: (index: number) => string;
  removeAttachment: (index: number) => string;
  addAttachment: string;
  editLabel: string;
  editAllPlaceholder: string;
  workspaceLabel: string;
  creationArea: string;
  leaveConfirm: string;
  undoNotice: string;
  redoNotice: string;
  closePreview: string;
  collapsePanel: string;
  expandPanel: string;
  liveCanvas: string;
  referenceCaption: string;
  canvasZoom: string;
  zoomFitShort: string;
  zoomFitHint: string;
  platformSwitched: string;
  selectionPersonHint: string;
  selectionFrameHint: string;
  switchWhole: string;
  inspectorTabs: string;
  copyDialogLabel: string;
  loginHandoffFailed: string;
  toolLabels: Readonly<Record<string, string>>;
}

export interface PeopleCopy {
  help: string;
  reading: string;
  reload: string;
  autoSave: string;
  applyTo: string;
  selfSuffix: string;
  defaultPerson: string;
  savedPerson: string;
  use: string;
  edit: string;
  remove: string;
  empty: string;
  saveCurrent: string;
  clearDefault: string;
  editPerson: string;
  createPerson: string;
  addPerson: string;
  newMemberHint: string;
  name: string;
  avatar: string;
  removeAvatar: string;
  upload: string;
  clear: string;
  describePortrait: string;
  generateAvatar: string;
  generatingAvatar: string;
  stopGenerating: string;
  makeDefault: string;
  portraitGenerated: string;
  portraitFailed: string;
  savedOk: string;
  applied: (name: string) => string;
  removed: string;
  savedCurrent: string;
  autoSaveUpdated: string;
  defaultCleared: string;
  uploadFailed: string;
  noAvatar: string;
  avatarAlt: (name: string) => string;
  pendingAlt: string;
  unsaved: string;
  localPending: string;
  cacheFailed: string;
  caching: string;
  cloudSynced: string;
  syncing: string;
  useCloudVersion: string;
  retrySave: string;
  nameInvalid: string;
  loadFailed: string;
  keepLocal: string;
  conflict: string;
  conflictNotice: string;
}

export interface AccountCopy {
  workspaceKicker: string;
  workspaceStory: string;
  workspaceTitle: (name: string) => string;
  workspaceLede: string;
  newConversation: string;
  startKicker: string;
  startTitleA: string;
  startTitleB: string;
  startBody: string;
  openEditor: string;
  miniTitle: string;
  miniLineA: string;
  miniLineB: string;
  miniInspiration: string;
  libraryTitle: string;
  searchLabel: string;
  searchPlaceholder: string;
  reload: string;
  fetching: string;
  emptyTitle: string;
  emptyBody: string;
  emptyErrorTitle: string;
  emptyErrorBody: string;
  openLocalDraft: string;
  noMatch: (query: string) => string;
  clearSearch: string;
  untitled: string;
  newSceneTitle: string;
  selfName: string;
  otherName: string;
  cardMessages: (count: number) => string;
  cardSaved: string;
  cardEdit: (title: string) => string;
  cardDelete: (title: string) => string;
  deleteTitle: string;
  deleteBody: (title: string) => string;
  keepWork: string;
  confirmDelete: string;
  deleting: string;
  navWorks: string;
  navProjects: string;
  navInspiration: string;
  navLocalDraft: string;
  navAccount: string;
  sidebarNote: string;
  loginKicker: string;
  registerKicker: string;
  loginTitle: string;
  registerTitle: string;
  loginLede: string;
  registerLede: string;
  nameLabel: string;
  namePlaceholder: string;
  emailLabel: string;
  passwordLabel: string;
  passwordHint: string;
  loginBusy: string;
  registerBusy: string;
  createAccount: string;
  login: string;
  haveAccount: string;
  firstTime: string;
  goLogin: string;
  goRegister: string;
  cannotLogin: string;
  tryEditor: string;
  loginHelp: string;
  instanceNote: string;
  showPassword: string;
  hidePassword: string;
  gateTitle: string;
  gateUnavailable: string;
  gateBody: string;
  gateUnavailableBody: string;
  reconnect: string;
  toLogin: string;
  authLoading: string;
  openingWork: string;
  openWorkFailed: string;
  openWorkFailedBody: string;
  backToWorks: string;
  notSaved: string;
  savedToAccount: string;
  savingToAccount: string;
  offlineSavedLocal: string;
  conflictNotice: string;
  deletedNotice: string;
  saveCopy: string;
  openServerVersion: string;
  autosaveNote: string;
  recoveredNote: string;
  draftRecoverable: string;
  draftStorageFailed: string;
  workDirty: string;
  workSaved: string;
  beforeUnload: string;
  accountKicker: string;
  accountLede: string;
  backWorksLong: string;
  changePassword: string;
  changePasswordBody: string;
  passwordMinHint: string;
  updating: string;
  signOutBody: string;
  accountTitle: string;
  accountBody: string;
  currentPassword: string;
  newPassword: string;
  updatePassword: string;
  logout: string;
  updated: string;
  sessionExpired: string;
  backWorks: string;
  workTitleLabel: string;
  saveWorks: string;
  savedCloud: string;
  cloudSaving: string;
  cloudSaved: string;
  cloudOffline: string;
  cloudConflict: string;
  cloudError: string;
  cloudIdle: string;
  cloudPending: string;
  syncNow: string;
}

export interface ProjectsCopy {
  listKicker: string;
  listTitle: string;
  listLede: string;
  newProject: string;
  nameLabel: string;
  namePlaceholder: string;
  rulesLabel: string;
  rulesPlaceholder: string;
  platformLabel: string;
  create: string;
  creating: string;
  loading: string;
  emptyTitle: string;
  emptyBody: string;
  sceneCount: (count: number) => string;
  updated: string;
  open: string;
  delete: string;
  deleteConfirm: string;
  deleteTitle: string;
  keep: string;
  confirmDelete: string;
  deleting: string;
  back: string;
  detailRules: string;
  prompts: string;
  promptsHint: string;
  addPrompt: string;
  promptPlaceholder: string;
  generate: string;
  generating: string;
  cancel: string;
  jobStatus: Readonly<Record<string, string>>;
  taskStatus: Readonly<Record<string, string>>;
  progress: (done: number, total: number) => string;
  noTasks: string;
  openScene: string;
  history: string;
  jobFailed: string;
  partial: string;
  reason: string;
  noProjects: string;
  limit: string;
  dupe: string;
  reload: string;
  noRules: string;
  cancelWarning: string;
  leaveConfirm: string;
  settingsSaved: string;
  needPrompt: string;
  maxPrompts: (count: number) => string;
  needPlatform: string;
  maxItems: (count: number) => string;
  openFailed: string;
  missing: string;
  scenesVersion: (count: number, version: number) => string;
  conflictNotice: string;
  reloadConfirm: string;
  rulesNote: string;
  saving: string;
  saveProject: string;
  works: string;
  noWorks: string;
  detach: string;
  attachWork: string;
  chooseWork: string;
  attach: string;
  batch: string;
  batchHint: (prompts: number, items: number) => string;
  platformShort: string;
  taskRunning: string;
  promptCount: (count: number) => string;
  success: string;
  failed: string;
  total: (count: number) => string;
  retryFailed: string;
  view: string;
  aboutBatch: string;
  batchNote: string;
  batchNote2: string;
  manageAll: string;
}

export interface ElementCopy {
  pickerLabel: string;
  sceneOption: string;
  personOption: (name: string) => string;
  messageOption: (index: number, label: string) => string;
  personSection: string;
  avatarAlt: (name: string) => string;
  changeAvatar: string;
  removeAvatar: string;
  name: string;
  subtitle: string;
  messagePosition: string;
  selfSide: string;
  otherSide: string;
  messageSection: string;
  messageText: string;
  sendDate: string;
  sender: string;
  system: string;
  messageTime: string;
  messageType: string;
  mediaSection: string;
  currentMedia: string;
  replaceMedia: string;
  uploadMedia: string;
  removeMedia: string;
  albumCaption: (index: number) => string;
  replaceImage: string;
  removeImage: string;
  addAlbumImage: string;
  quoteSection: string;
  subtitleField: string;
  quoteField: string;
  frameSection: string;
  headerText: string;
  deviceTime: string;
  battery: string;
  storyToday: string;
  dateHelp: string;
  dateText: string;
  composerText: string;
  watermark: string;
  backgroundSection: string;
  background: string;
  backgroundImage: string;
  clearImage: string;
  deviceSection: string;
  device: string;
  genericDevice: string;
  addSection: string;
  addMessage: string;
  addMember: string;
  newMember: string;
  newMessage: string;
  newPhoto: string;
  appearanceSection: string;
  textColor: string;
  bubbleColor: string;
  fontSize: string;
  radius: string;
  spacing: string;
  width: string;
  height: string;
  auto: string;
  restoreAppearance: string;
  arrangeSection: string;
  moveUp: string;
  moveDown: string;
  duplicate: string;
  deleteMessage: string;
  readFailed: string;
  navHelp: string;
  navFrame: string;
  navPersonSection: string;
  navSelf: string;
  navOther: string;
  navMessageSection: string;
  navAddMessage: string;
  navEmpty: string;
  navReferenceHelp: string;
  navReferenceFull: string;
  navReferenceText: string;
  navReferenceImage: string;
  navReferenceEmpty: string;
}

export interface AppCopy {
  messageTypes: Record<MessageType, string>;
  platforms: Record<Platform, string>;
  reference: { title: string; selected: string; all: string; text: string; image: string; axes: readonly string[]; font: string; color: string; background: string; remove: string };
  common: CommonCopy;
  sessions: SessionsCopy;
  agent: AgentCopy;
  people: PeopleCopy;
  account: AccountCopy;
  projects: ProjectsCopy;
  elements: ElementCopy;
}

const zh: AppCopy = {
  messageTypes: { text:'文字', image:'图片', location:'位置', system:'系统提示', contact:'联系人', transfer:'转账', voice:'语音', video:'视频', link:'链接', album:'相册' },
  platforms: {wechat:'微信',whatsapp:'WhatsApp',imessage:'iMessage',xiaohongshu:'小红书',instagram:'Instagram',slack:'Slack'},
  reference: {title:'编辑层与位置',selected:'选中编辑层',all:'全部编辑层',text:'文字',image:'图片素材',axes:['左','上','宽','高'],font:'字号（源像素）',color:'文字颜色',background:'底色',remove:'移除此编辑层'},
  common: {
    retry: '重试', cancel: '取消', close: '关闭', save: '保存', saved: '已保存', loading: '正在准备…',
    offline: '离线，已保存到本机', conflict: '版本冲突', signIn: '登录', signInToSave: '登录保存作品', dismiss: '关闭',
  },
  sessions: {
    reading: '正在读取会话…', savedLocal: '已保存到本机', saving: '正在保存…', waiting: '等待保存…', notSaved: '尚未保存',
    saveFailed: '无法保存会话，请检查浏览器存储空间。',
    manage: '管理创作会话', busySwitch: 'AI 正在创作 · 停止后可切换', newSession: '新建会话', newSessionHint: '新建会话，保留当前内容',
    retrySave: '重试保存', saveAsNew: '另存为新会话',
    listLabel: '创作会话列表', listTitle: '创作会话', closeList: '关闭会话列表',
    searchLabel: '搜索会话', searchPlaceholder: '搜索名称或内容', noResults: '没有找到相关会话，试试其他关键词。',
    nameLabel: '会话名称', saveName: '保存名称',
    openSession: (title) => `打开会话：${title}`, current: '当前会话 · ',
    messages: (count) => `${count} 条消息`,
    rename: (title) => `重命名：${title}`, renameTitle: '重命名', duplicate: '复制当前会话',
    deleteLabel: (title) => `删除：${title}`, deleteTitle: '删除会话',
    deleteConfirm: (title) => `删除「${title}」的本机会话？已保存到“我的作品”的内容不受影响。`,
    confirmDelete: '确认删除会话', keep: '保留会话',
    footer: '会话仅存此浏览器 · 画面可另存到“我的作品”',
    restoring: '正在恢复创作会话…', retryRead: '重试读取会话', openScene: '场景可另存到“我的作品”',
    duplicateSuffix: '副本', openFailed: '会话库无法打开', actionFailed: '操作失败，当前内容已保留。',
  },
  agent: {
    panelLabel: '创作助手', panelBusy: '正在创作', leftPanelLabel: '左侧面板', tabAi: 'AI 创作', tabElements: '元素',
    expandWide: '恢复创作区宽度', expandNarrow: '拓宽创作区', expandHint: '也可拖动分隔线调整宽度',
    contextSummary: '人物与项目', standalone: '独立创作',
    readingPeople: '正在读取人物…', peopleFailed: '人物库连接失败 · 点击重试',
    defaultPerson: (name) => `我的默认人物：${name}`, defaultPersonUnset: '尚未设置', configure: '配置 →',
    projectRules: '项目规则', currentProject: '当前项目', manageProjects: '管理项目 →',
    sampleLink: '打开合成案例 · 去年借款，今天归还 ↗',
    dropTitle: '把图片拖到这里', dropOr: '或点击选择参考图',
    ideas: ['和朋友约周末去上海看展，聊得轻松一点', '生成一段 WhatsApp 英文旅行对话，最后发一个地点', '根据截图重建聊天，把对方名字改成小满'],
    capabilitiesError: '连接状态读取失败 · 重试',
    capabilityConnected: (model) => `${model} · 消息配图已连接`, capabilityImageReady: '消息配图已连接', capabilityImageMissing: '生图服务待配置',
    capabilityModelMissing: '模型服务待配置', capabilityConnecting: '正在连接 Agent…',
    keepScreenshot: '保留原截图布局进行编辑', keepScreenshotNotice: '已保留原截图布局，输入想修改的内容。', imageReadFailed: '图片无法读取，请重试。',
    composerLabel: '描述想生成的聊天', composerPlaceholder: '写一句话，或粘贴一张聊天截图…',
    composerEditPlaceholder: '把这句话改得更自然…', composerEditSelected: '仅修改选中元素', composerEditAll: '编辑整个对话',
    composerScopeAll: '当前范围 · 整个对话', composerScopeOnly: (label) => `仅修改 · ${label}`, composerScopeSwitch: '切换',
    composerShortcut: '⌘ / Ctrl + Enter', send: '开始生成', sendEdit: '发送修改', stop: '停止生成', loginCreate: '登录创作 →',
    uploadHint: '拖入、粘贴或上传图片 · 最多 3 张，每张 4 MB',
    dragWaiting: '请等待当前操作完成', dragReady: '松开，添加参考图片', dragFormats: 'PNG、JPEG、WebP · 最多 3 张',
    dropEntry: '把图片拖到这里', dropEntryAction: '或点击选择参考图', welcomeLabel: '开始创作',
    mobileChat: '创作 Chat', mobileCanvas: '渲染画面', mobileBusy: '生成中',
    undo: '撤销上次修改', redo: '重做上次修改', more: '更多', downloadJson: '下载场景 JSON', downloadSceneJson: '下载场景 JSON 备份',
    errorStorage: '浏览器暂时无法保存草稿，请保存作品或下载场景 JSON。', closeNotice: '关闭提示',
    platform: '目标聊天平台', device: '截图设备', genericDevice: '通用尺寸（当前系统）',
    updating: '正在更新画面…', editLayers: (count) => `${count} 个编辑层`, messageCount: (count) => `${count} 条消息`,
    exportRange: '导出图片范围', longShot: '长截图', standardShot: '普通截图',
    copyPng: '复制图片', copying: '复制中', exportPng: '导出 PNG', exporting: '导出中',
    copyReady: '图片已准备好', copyInstruction: '长按或右键图片，选择复制图片。', copyDownload: '下载 PNG', copyAlt: '可长按复制的聊天图片',
    canvasEmptyTitle: '实时渲染', canvasEmptyBody: '你的第一句话，从这里开始。',
    canvasCaption: (label, width, height, full) => `${label} · ${width} × ${full ? '自动高度' : height} px · ${full ? '点选消息或头像编辑' : '上下拖动调整截取位置 · 复制当前可见画面'}`,
    canvasCaptionFullHeight: '自动高度', canvasPointHint: '点选消息或头像编辑', pointHint: '点选画面中的元素，即可编辑',
    zoomOut: '缩小画布', zoomFit: '适应画布', zoomIn: '放大画布', elements: '元素编辑',
    inspectorLabel: 'Vibe Edit', inspectorSelectionAll: '整个对话', inspectorMessage: (index) => `消息 ${index}`,
    inspectorPerson: '人物', inspectorPatch: '截图编辑层', inspectorFrame: '画面与界面', inspectorClose: '关闭 AI 编辑',
    inspectorProperties: '属性', inspectorAi: 'AI 修改',
    inspectorAiTitleSelected: (label) => `只修改${label}`, inspectorAiTitleAll: '改进整个对话',
    inspectorAiIntro: '说出想要的效果，修改后可以随时撤销。',
    inspectorAiEntry: (selected) => `让 AI 改进${selected ? '这个元素' : '整个对话'}`,
    inspectorAiNote: '直接编辑即时生效 · 所有修改均可撤销',
    inspectorSuggestionsMessage: ['表达更自然', '更简短一点', '补充一点细节'],
    inspectorSuggestionsPerson: ['生成自然光头像', '改成插画风头像'],
    inspectorSuggestionsAll: ['让对话更自然', '统一气泡与文字风格'],
    peopleTitle: '人物与头像', peopleClose: '关闭人物库',
    transcriptAi: 'AI 创作记录', transcriptEdit: '元素修改记录', transcriptYou: '你', transcriptModel: 'IMStage',
    transcriptScoped: ' · 局部编辑', transcriptAttachments: '已提交的参考图片',
    transcriptAttachmentAlt: (index) => `已提交参考图 ${index}`, transcriptSubmitted: '已随这条需求提交',
    transcriptTools: (count) => `${count} 个工具步骤`, transcriptToolRunning: '正在更新画面…', transcriptToolError: '未完成',
    intentInterrupted: '上次请求在运行中被打断，为避免重复计费不会自动重试。',
    intentFailed: '提交的请求未完成。',
    intentRetry: '重试发送', intentDismiss: '知道了', intentQueued: '已提交，正在准备发送…',
    intentPersistFailed: '无法在本机保留这次发送意图，未开始生成。请检查存储后重试。',
    thinking: '正在理解你的想法…',
    sceneUpdated: '画面已更新，可以继续说想改哪里。',
    sceneUpdatedShort: '画面已更新。',
    peopleSaved: '画面已更新，人物与头像已存入人物库。',
    peopleSaveFailed: (message) => `画面已保留，但人物未保存：${message}`,
    stopped: '已停止，收到的内容已保留。',
    generateFailed: '生成失败，请重试。',
    noChanges: 'Agent 没有返回可用的场景修改，请补充需求后重试。',
    signInToCreate: '登录后即可让 Agent 开始创作。',
    maxAttachments: '最多添加 3 张参考图片，请先移除一张。',
    extraAttachments: '最多添加 3 张，超出的图片未加入。',
    exportPreparing: '正在导出…',
    exportDone: 'PNG 已导出。',
    exportFailed: '图片导出失败，画面仍保留，请重试或下载场景文件。',
    copyPreparing: '正在准备复制图片…',
    copyDone: '图片已复制，可以直接粘贴到聊天或文档。',
    copyBlocked: '浏览器未允许直接复制，可在图片上长按或右键复制，也可下载 PNG。',
    copyFailed: '图片生成失败，未复制。请重试或导出 PNG。',
    renderFailed: '图片渲染失败',
    frameNotReady: '画面尚未准备好',
    imageFailed: '无法生成图片',
    attachmentAlt: (index) => `参考图片 ${index}`,
    removeAttachment: (index) => `移除参考图片 ${index}`,
    addAttachment: '添加参考图片',
    editLabel: '描述想怎样修改',
    editAllPlaceholder: '让整段对话更有生活感…',
    workspaceLabel: 'Agent 对话创作台',
    creationArea: '创作区',
    leaveConfirm: '浏览器无法保留当前内容。离开会丢失未保存的修改，确定离开？', undoNotice: '已撤销画面修改。', redoNotice: '已重做画面修改。', closePreview: '关闭图片预览',
    collapsePanel: '收起左侧面板', expandPanel: '展开左侧面板', liveCanvas: '实时聊天画面', referenceCaption: '按原图布局编辑',
    canvasZoom: '画布缩放', zoomFitShort: '适应', zoomFitHint: '点击恢复自适应', platformSwitched: '已切换平台，请描述需求生成新的聊天画面。',
    selectionPersonHint: '姓名、头像与人物资料', selectionFrameHint: '调整对话的内容与视觉细节', switchWhole: '切换为整个对话',
    inspectorTabs: '编辑方式', copyDialogLabel: '图片复制备选方式',
    loginHandoffFailed: '暂时无法保留登录前的输入，请先下载场景文件，并复制你的需求。',
    toolLabels: { extract_image: '保留截图原图', update_element: '调整元素', read_text: '读取文字位置', inspect_region: '查看局部', set_edits: '修改编辑层', render_preview: '检查渲染', create_scene: '编排对话', upsert_message: '更新消息', delete_message: '移除消息', generate_image: '生成图片' },
  },
  people: {
    help: '保存人物与头像，在每次创作时复用。应用到画面的是独立副本。',
    reading: '正在读取人物库…', reload: '重新读取', autoSave: '生成成功后保存人物与头像',
    applyTo: '应用到画面中的谁', selfSuffix: '（我）', defaultPerson: '我的默认人物', savedPerson: '已保存人物',
    use: '使用', edit: '编辑', remove: '移除', empty: '还没有保存的人物。先设置自己的头像，或生成一段聊天。',
    saveCurrent: '保存当前对话中的人物', clearDefault: '取消我的默认人物',
    editPerson: '编辑人物', createPerson: '创建人物', addPerson: '新建另一个人物', newMemberHint: '新人物', name: '人物姓名', avatar: '头像',
    removeAvatar: '移除头像', upload: '上传头像', clear: '清除', describePortrait: '描述想生成的头像',
    generateAvatar: 'AI 生成头像', generatingAvatar: '正在生成…', stopGenerating: '停止生成头像',
    makeDefault: '作为我的默认人物（新对话自动使用）', portraitGenerated: '头像已生成。保存后可在之后的对话中复用。',
    portraitFailed: '未收到生成的头像，请重试。', savedOk: '人物已保存。', applied: (name) => `已应用 ${name}，姓名和头像一起更新。`,
    removed: '已从人物库移除，现有画面保持不变。', savedCurrent: '当前人物已保存。', autoSaveUpdated: '自动保存设置已更新。',
    defaultCleared: '已取消默认人物。', uploadFailed: '图片读取失败，请重新选择。', noAvatar: '头像', avatarAlt: (name) => `${name}的头像`,
    pendingAlt: '待保存的头像', unsaved: '尚未保存',
    cacheFailed: '本机缓存失败，请保持页面打开并重试同步。', caching: '正在缓存…', localPending: '已保存到本机 · 待同步', cloudSynced: '已同步到账号', syncing: '正在同步…',
    useCloudVersion: '使用云端版本', retrySave: '重试保存', nameInvalid: '人物姓名需为 1-100 个字符；本机草稿已保留。',
    loadFailed: '人物库连接失败', keepLocal: '保留本机修改', conflict: '版本冲突', conflictNotice: '联系人库已在其他位置更新，本机修改仍保留。',
  },
  account: {
    workspaceKicker: 'WORKSPACE', workspaceStory: 'YOUR STORIES, IN ONE PLACE', workspaceTitle: (name) => `${name}的创作空间`,
    workspaceLede: '一个念头，一段对话。一切从这里开始。', newConversation: '新建对话',
    startKicker: 'START WITH A CONVERSATION', startTitleA: '下一段故事，', startTitleB: '由你来开场。',
    startBody: '写台词、选平台、调整画面，再导出聊天截图。', openEditor: '打开对话编辑器',
    miniTitle: '周末出逃计划', miniLineA: '周末，要不要去看海？', miniLineB: '好呀！这次把日落也装进口袋。', miniInspiration: '灵感正在发生 ···',
    libraryTitle: '我的作品', searchLabel: '搜索作品', searchPlaceholder: '搜索作品或平台', reload: '重新加载', fetching: '正在取回你的作品…',
    emptyTitle: '还没有保存的作品', emptyBody: '新建一段对话，或把本机草稿保存到这里。', emptyErrorTitle: '作品暂时无法加载', emptyErrorBody: '恢复连接后重新加载，已保存的内容仍在。', openLocalDraft: '打开本机草稿',
    noMatch: (query) => `没有找到“${query}”相关的作品。`, clearSearch: '清除搜索', untitled: '未命名对话', newSceneTitle: '新的对话', selfName: '我', otherName: '对方',
    cardMessages: (count) => `${count} 条消息`, cardSaved: '保存', cardEdit: (title) => `编辑 ${title}`, cardDelete: (title) => `删除 ${title}`,
    deleteTitle: '删除这份作品？', deleteBody: (title) => `“${title}”将从账号中永久删除。已导出的文件不受影响。`,
    keepWork: '保留作品', confirmDelete: '确认删除', deleting: '正在删除…',
    navWorks: '我的作品', navProjects: '项目与批量生成', navInspiration: '场景灵感', navLocalDraft: '本机草稿', navAccount: '账号设置',
    sidebarNote: '每一次保存，都让灵感有迹可循。',
    loginKicker: 'WELCOME BACK', registerKicker: 'CREATE YOUR ACCOUNT', loginTitle: '欢迎回来', registerTitle: '开始你的创作空间',
    loginLede: '登录 IMStage，继续上一次的灵感。', registerLede: '创建账号，保存和管理你的对话作品。',
    nameLabel: '怎么称呼你', namePlaceholder: '你的名字', emailLabel: '邮箱', passwordLabel: '密码',
    passwordHint: '至少 12 个字符，可以使用便于记忆的长密码。', loginBusy: '正在登录…', registerBusy: '正在创建账号…',
    createAccount: '创建账号', login: '登录', haveAccount: '已经有账号？', firstTime: '第一次来？', goLogin: '去登录', goRegister: '创建账号',
    cannotLogin: '无法登录？', tryEditor: '先试用编辑器',
    loginHelp: '确认正在访问创建账号时的同一个 IMStage 实例。当前版本尚未配置邮件找回；忘记密码请联系实例管理员。已有作品不会因为登录失败而删除。',
    instanceNote: '账号和作品保存在当前 IMStage 实例', showPassword: '显示密码', hidePassword: '隐藏密码',
    gateTitle: '登录后打开你的创作空间', gateUnavailable: '账号服务暂时不可用', gateBody: '正在为你打开登录页面…',
    gateUnavailableBody: '作品仍保存在服务端，恢复连接后可以继续。', reconnect: '重新连接', toLogin: '前往登录', authLoading: '正在确认登录状态…',
    openingWork: '正在打开作品…', openWorkFailed: '暂时打不开这份作品', openWorkFailedBody: '', backToWorks: '返回我的作品',
    notSaved: '有未保存的修改', savedToAccount: '已保存到账号', savingToAccount: '正在保存到账号…', offlineSavedLocal: '离线，已保存到本机',
    conflictNotice: '服务端的版本已经改变，当前修改仍保留。', deletedNotice: '这份作品已在服务端删除。可以另存为新作品，本机修改仍保留。', saveCopy: '另存为新作品', openServerVersion: '打开服务端版本 →',
    autosaveNote: '未保存的内容可在此标签页恢复', recoveredNote: '已恢复此标签页未保存的内容，正在自动保存。',
    draftRecoverable: '未保存的内容可在此标签页恢复', draftStorageFailed: '无法保存恢复副本，请先保存作品或导出 JSON',
    workDirty: '有未保存的修改', workSaved: '已保存到账号', beforeUnload: '当前修改尚未保存，浏览器也无法保存恢复副本。离开会丢失这些修改，确定离开？',
    accountKicker: 'ACCOUNT',
    accountLede: '管理你的账号与登录凭据。', backWorksLong: '← 返回我的作品', changePassword: '修改密码', changePasswordBody: '修改后所有设备的登录都会失效，需要使用新密码重新登录。', passwordMinHint: '至少 12 个字符。', updating: '正在更新…', signOutBody: '当前作品保存在此 IMStage 实例。',
 accountTitle: '账号设置', accountBody: '管理登录方式与当前实例中的作品。',
    currentPassword: '当前密码', newPassword: '新密码', updatePassword: '更新密码', logout: '退出登录', updated: '已更新',
    sessionExpired: '登录状态已过期，请重新登录。', backWorks: '← 我的作品', workTitleLabel: '会话标题', saveWorks: '保存作品',
    savedCloud: '已同步到账号', cloudSaving: '正在同步…', cloudSaved: '已同步', cloudOffline: '离线 · 已存本机',
    cloudConflict: '版本冲突', cloudError: '同步失败', cloudIdle: '', cloudPending: '已存本机 · 待同步', syncNow: '立即同步',
  },
  projects: {
    listKicker: 'PROJECTS', listTitle: '项目与批量生成', listLede: '把规则、默认平台和一批提示词组织成一次批量创作。',
    newProject: '新建项目', nameLabel: '项目名称', namePlaceholder: '例如：新专辑发布', rulesLabel: '项目规则', rulesPlaceholder: '写清语气、人物设定与必须遵守的事实。',
    platformLabel: '默认平台', create: '创建项目', creating: '正在创建…', loading: '正在读取项目…',
    emptyTitle: '还没有项目', emptyBody: '创建一个项目，保存规则并批量生成作品。', deleteTitle: '删除这个项目？', sceneCount: (count) => `${count} 份作品`,
    updated: '更新于', open: '打开项目', delete: '删除项目', deleteConfirm: '删除这个项目？项目中的作品会保留。',
    keep: '保留项目', confirmDelete: '确认删除', deleting: '正在删除…', back: '← 全部项目',
    detailRules: '项目规则', prompts: '提示词', promptsHint: '每行一条，最多 10 条。', addPrompt: '添加提示词', promptPlaceholder: '描述这一次要生成的内容',
    generate: '开始批量生成', generating: '正在生成…', cancel: '取消任务',
    jobStatus: { queued: '排队中', running: '生成中', done: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' },
    taskStatus: { queued: '等待中', running: '生成中', done: '已保存', failed: '失败', cancelled: '已取消', interrupted: '已中断' },
    progress: (done, total) => `${done} / ${total}`, noTasks: '还没有生成记录。', openScene: '打开作品', history: '生成记录',
    jobFailed: '生成失败', partial: '部分完成', reason: '原因', noProjects: '还没有项目。', limit: '已达上限', dupe: '已存在',
    reload: '重新加载', noRules: '未设置项目规则', cancelWarning: '进行中的批量生成会同时取消。',
    leaveConfirm: '项目规则尚未保存，离开会丢失修改，确定离开？', settingsSaved: '已保存项目设置',
    needPrompt: '请至少输入 1 条提示词，每行一条。', maxPrompts: (count) => `最多 ${count} 条提示词。`,
    needPlatform: '请至少选择一个平台。', maxItems: (count) => `一次最多 ${count} 个作品（提示词 × 平台）。`,
    openFailed: '暂时打不开这个项目', missing: '项目不存在或已删除。', scenesVersion: (count, version) => `${count} 个作品 · 版本 ${version}`,
    conflictNotice: '项目已在其他标签页更新。当前修改仍保留，请重新加载后再保存。',
    reloadConfirm: '重新加载会放弃当前未保存的项目规则，继续？', rulesNote: '规则会作为独立说明提供给生成任务，不会写入你的作品。',
    saving: '正在保存…', saveProject: '保存项目', works: '项目作品',
    noWorks: '还没有作品。可以在下方批量生成，或从「我的作品」中关联已有作品。',
    detach: '解除关联', attachWork: '关联已有作品', chooseWork: '选择我的作品…', attach: '关联',
    batch: '批量生成', batchHint: (prompts, items) => `每行一条提示词，最多 ${prompts} 条；提示词 × 平台最多 ${items} 个作品。规则和平台会在提交时快照。`,
    platformShort: '平台', taskRunning: '已有任务进行中', promptCount: (count) => `提示词 ${count}`,
    success: '成功', failed: '失败', total: (count) => `共 ${count}`, retryFailed: '重试失败项', view: '查看',
    aboutBatch: '关于批量生成', batchNote: '只有模型完整生成并通过校验的作品才会作为新作品保存；失败、取消或服务重启中断的任务会如实记录，不会伪装成成功。',
    batchNote2: '项目删除只解除关联，不会删除作品。', manageAll: '在我的作品中管理全部作品',

  },
  elements: {
    pickerLabel: '选中元素', sceneOption: '背景、标题与界面', personOption: (name) => `人物 · ${name}`,
    messageOption: (index, label) => `${index} · ${label}`,
    personSection: '人物资料', avatarAlt: (name) => `${name} 的头像预览`, changeAvatar: '更换头像', removeAvatar: '移除头像',
    name: '姓名', subtitle: '资料说明', messagePosition: '消息位置', selfSide: '我 · 右侧', otherSide: '对方 · 左侧',
    messageSection: '消息内容', messageText: '消息文字', sendDate: '发送日期', sender: '发送者', system: '系统', messageTime: '消息时间', messageType: '消息类型',
    mediaSection: '消息素材', currentMedia: '当前消息素材', replaceMedia: '替换消息配图', uploadMedia: '上传消息配图', removeMedia: '移除配图',
    albumCaption: (index) => `图片 ${index} 说明`, replaceImage: '替换图片', removeImage: '移除图片', addAlbumImage: '添加相册图片',
    quoteSection: '引用与补充', subtitleField: '说明 / 地址 / 时长', quoteField: '引用内容',
    frameSection: '对话界面', headerText: '会话标题', deviceTime: '设备时间', battery: '电量 %', storyToday: '故事中的今天',
    dateHelp: '日期分隔按每条消息的发送日期自动生成。', dateText: '日期文字', composerText: '输入栏提示', watermark: '水印',
    backgroundSection: '聊天背景', background: '背景颜色', backgroundImage: '背景图片', clearImage: '清除图片',
    deviceSection: '设备与尺寸', device: '截图设备', genericDevice: '通用尺寸（当前系统）',
    addSection: '添加元素', addMessage: '添加消息', addMember: '添加成员', newMember: '新成员', newMessage: '新消息', newPhoto: '新照片',
    appearanceSection: '外观与排版', textColor: '文字颜色', bubbleColor: '气泡颜色', fontSize: '字号', radius: '圆角', spacing: '消息间距',
    width: '宽度', height: '高度', auto: '自动', restoreAppearance: '恢复默认外观',
    arrangeSection: '排列与操作', moveUp: '上移消息', moveDown: '下移消息', duplicate: '复制', deleteMessage: '删除消息',
    readFailed: '图片读取失败，请重新选择。',
    navHelp: '选择一个元素，直接编辑或交给 AI。', navFrame: '画面与界面', navPersonSection: '人物', navSelf: '我 · 右侧消息', navOther: '对方 · 左侧消息',
    navMessageSection: '消息', navAddMessage: '添加消息', navEmpty: '还没有消息。点击 + 手动添加，或切换到 AI 创作。',
    navReferenceHelp: '保留原截图布局，选择编辑层继续修改。', navReferenceFull: '完整截图', navReferenceText: '文字层', navReferenceImage: '图片层',
    navReferenceEmpty: '尚无编辑层。在 AI 创作中描述想修改的位置与内容。',
  },
};

const en: AppCopy = {
  messageTypes: { text:'Text', image:'Image', location:'Location', system:'System notice', contact:'Contact', transfer:'Transfer', voice:'Voice', video:'Video', link:'Link', album:'Album' },
  platforms: {wechat:'WeChat',whatsapp:'WhatsApp',imessage:'iMessage',xiaohongshu:'RedNote',instagram:'Instagram',slack:'Slack'},
  reference: {title:'Edit layers & position',selected:'Selected layer',all:'All layers',text:'Text',image:'Image asset',axes:['Left','Top','Width','Height'],font:'Font size (source pixels)',color:'Text color',background:'Background',remove:'Remove this layer'},
  common: {
    retry: 'Retry', cancel: 'Cancel', close: 'Close', save: 'Save', saved: 'Saved', loading: 'Getting ready…',
    offline: 'Offline · saved locally', conflict: 'Version conflict', signIn: 'Sign in', signInToSave: 'Sign in to save', dismiss: 'Dismiss',
  },
  sessions: {
    reading: 'Loading sessions…', savedLocal: 'Saved locally', saving: 'Saving…', waiting: 'Waiting to save…', notSaved: 'Not saved yet',
    saveFailed: 'This session could not be saved. Check the browser storage space.',
    manage: 'Manage sessions', busySwitch: 'AI is creating · stop before switching', newSession: 'New session', newSessionHint: 'Start a new session and keep this one',
    retrySave: 'Retry save', saveAsNew: 'Save as a new session',
    listLabel: 'Creation sessions', listTitle: 'Sessions', closeList: 'Close session list',
    searchLabel: 'Search sessions', searchPlaceholder: 'Search by name or content', noResults: 'No matching session. Try another keyword.',
    nameLabel: 'Session name', saveName: 'Save name',
    openSession: (title) => `Open session: ${title}`, current: 'Current · ',
    messages: (count) => `${count} messages`,
    rename: (title) => `Rename: ${title}`, renameTitle: 'Rename', duplicate: 'Duplicate current session',
    deleteLabel: (title) => `Delete: ${title}`, deleteTitle: 'Delete session',
    deleteConfirm: (title) => `Delete the local session “${title}”? Anything saved to My scenes is unaffected.`,
    confirmDelete: 'Delete session', keep: 'Keep session',
    footer: 'Sessions live only in this browser · save the scene to My scenes',
    restoring: 'Restoring your session…', retryRead: 'Retry loading session', openScene: 'The scene can be saved to My scenes',
    duplicateSuffix: 'copy', openFailed: 'The session library could not be opened', actionFailed: 'The action failed; your content is kept.',
  },
  agent: {
    panelLabel: 'Creation assistant', panelBusy: 'Creating', leftPanelLabel: 'Left panel', tabAi: 'AI create', tabElements: 'Elements',
    expandWide: 'Restore panel width', expandNarrow: 'Widen panel', expandHint: 'You can also drag the divider',
    contextSummary: 'People & project', standalone: 'Standalone',
    readingPeople: 'Loading people…', peopleFailed: 'People library unavailable · retry',
    defaultPerson: (name) => `Default person: ${name}`, defaultPersonUnset: 'not set', configure: 'Set up →',
    projectRules: 'Project rules', currentProject: 'Current project', manageProjects: 'Manage projects →',
    sampleLink: 'Open the synthetic case · Repaid today ↗',
    dropTitle: 'Drop an image here', dropOr: 'or click to choose a reference',
    ideas: ['Weekend art trip with a friend — keep it light', 'Write an English WhatsApp travel chat that ends with a location', 'Rebuild the chat from a screenshot and rename the other person'],
    capabilitiesError: 'Could not read connection status · retry',
    capabilityConnected: (model) => `${model} · image assets connected`, capabilityImageReady: 'image assets connected', capabilityImageMissing: 'image service not configured',
    capabilityModelMissing: 'Model service not configured', capabilityConnecting: 'Connecting to the Agent…',
    keepScreenshot: 'Edit while keeping the screenshot layout', keepScreenshotNotice: 'The screenshot layout is kept. Describe what to change.', imageReadFailed: 'The image could not be read. Try again.',
    composerLabel: 'Describe the chat to generate', composerPlaceholder: 'Write a line, or paste a chat screenshot…',
    composerEditPlaceholder: 'Make this line feel more natural…', composerEditSelected: 'Edit the selected element only', composerEditAll: 'Edit the whole conversation',
    composerScopeAll: 'Scope · whole conversation', composerScopeOnly: (label) => `Only · ${label}`, composerScopeSwitch: 'Switch',
    composerShortcut: '⌘ / Ctrl + Enter', send: 'Start generating', sendEdit: 'Send change', stop: 'Stop generating', loginCreate: 'Sign in to create →',
    uploadHint: 'Drop, paste or upload images · up to 3, 4 MB each',
    dragWaiting: 'Finish the current action first', dragReady: 'Release to add a reference', dragFormats: 'PNG, JPEG, WebP · up to 3',
    dropEntry: 'Drop an image here', dropEntryAction: 'or click to choose a reference', welcomeLabel: 'Start creating',
    mobileChat: 'Create chat', mobileCanvas: 'Preview', mobileBusy: 'generating',
    undo: 'Undo last change', redo: 'Redo last change', more: 'More', downloadJson: 'Download scene JSON', downloadSceneJson: 'Download scene JSON backup',
    errorStorage: 'This browser cannot cache the draft right now. Save the work or download the scene JSON.', closeNotice: 'Dismiss notice',
    platform: 'Target chat platform', device: 'Screenshot device', genericDevice: 'Generic size (current system)',
    updating: 'Updating the frame…', editLayers: (count) => `${count} edit layers`, messageCount: (count) => `${count} messages`,
    exportRange: 'Export range', longShot: 'Long capture', standardShot: 'Short capture',
    copyPng: 'Copy image', copying: 'Copying', exportPng: 'Export PNG', exporting: 'Exporting',
    copyReady: 'Image is ready', copyInstruction: 'Long-press or right-click the image and copy it.', copyDownload: 'Download PNG', copyAlt: 'Chat image ready to copy',
    canvasEmptyTitle: 'Live render', canvasEmptyBody: 'Your first line starts here.',
    canvasCaption: (label, width, height, full) => `${label} · ${width} × ${full ? 'auto height' : height} px · ${full ? 'click a message or avatar to edit' : 'drag to set the crop · copies the visible frame'}`,
    canvasCaptionFullHeight: 'auto height', canvasPointHint: 'click a message or avatar to edit', pointHint: 'Click an element in the frame to edit it',
    zoomOut: 'Zoom out', zoomFit: 'Fit canvas', zoomIn: 'Zoom in', elements: 'Edit elements',
    inspectorLabel: 'Vibe Edit', inspectorSelectionAll: 'Whole conversation', inspectorMessage: (index) => `Message ${index}`,
    inspectorPerson: 'Person', inspectorPatch: 'Screenshot edit layer', inspectorFrame: 'Frame & interface', inspectorClose: 'Close AI edit',
    inspectorProperties: 'Properties', inspectorAi: 'AI change',
    inspectorAiTitleSelected: (label) => `Edit ${label} only`, inspectorAiTitleAll: 'Improve the whole conversation',
    inspectorAiIntro: 'Describe the effect; every change can be undone.',
    inspectorAiEntry: (selected) => `Let AI improve ${selected ? 'this element' : 'the whole conversation'}`,
    inspectorAiNote: 'Direct edits apply instantly · everything can be undone',
    inspectorSuggestionsMessage: ['More natural', 'Shorter', 'Add a little detail'],
    inspectorSuggestionsPerson: ['Natural-light portrait', 'Illustrated portrait'],
    inspectorSuggestionsAll: ['Make the dialogue natural', 'Unify bubbles and type'],
    peopleTitle: 'People & avatars', peopleClose: 'Close people library',
    transcriptAi: 'AI creation log', transcriptEdit: 'Element change log', transcriptYou: 'You', transcriptModel: 'IMStage',
    transcriptScoped: ' · scoped edit', transcriptAttachments: 'Submitted reference images',
    transcriptAttachmentAlt: (index) => `Submitted reference ${index}`, transcriptSubmitted: 'Sent with this request',
    transcriptTools: (count) => `${count} tool steps`, transcriptToolRunning: 'Updating the frame…', transcriptToolError: 'Not finished',
    intentInterrupted: 'The last request was interrupted while running. It will not repeat on its own, to avoid a duplicate charge.',
    intentFailed: 'The submitted request did not finish.',
    intentRetry: 'Send again', intentDismiss: 'Got it', intentQueued: 'Submitted · preparing to send…',
    intentPersistFailed: 'The send intent could not be stored locally, so nothing was sent. Check storage and retry.',
    thinking: 'Understanding your idea…',
    sceneUpdated: 'The frame is updated; keep describing what to change.',
    sceneUpdatedShort: 'Frame updated.',
    peopleSaved: 'The frame is updated and the people were saved to your library.',
    peopleSaveFailed: (message) => `The frame is kept, but the people were not saved: ${message}`,
    stopped: 'Stopped; the content received so far is kept.',
    generateFailed: 'Generation failed. Please try again.',
    noChanges: 'The Agent returned no usable scene change. Add more detail and retry.',
    signInToCreate: 'Sign in to let the Agent start creating.',
    maxAttachments: 'Up to 3 reference images. Remove one first.',
    extraAttachments: 'Up to 3 images; the extra files were not added.',
    exportPreparing: 'Exporting…',
    exportDone: 'PNG exported.',
    exportFailed: 'Export failed; the frame is kept. Retry or download the scene file.',
    copyPreparing: 'Preparing the image…',
    copyDone: 'Image copied; paste it into any chat or document.',
    copyBlocked: 'The browser blocked direct copy. Long-press or right-click the image, or download the PNG.',
    copyFailed: 'The image could not be created, so nothing was copied. Retry or export a PNG.',
    renderFailed: 'Image render failed',
    frameNotReady: 'The frame is not ready yet',
    imageFailed: 'The image could not be generated',
    attachmentAlt: (index) => `Reference ${index}`,
    removeAttachment: (index) => `Remove reference ${index}`,
    addAttachment: 'Add reference image',
    editLabel: 'Describe the change',
    editAllPlaceholder: 'Give the whole conversation more life…',
    workspaceLabel: 'Agent conversation studio',
    creationArea: 'Creation panel',
    leaveConfirm: 'This browser cannot keep the current content. Leaving loses unsaved changes. Leave anyway?', undoNotice: 'Frame change undone.', redoNotice: 'Frame change redone.', closePreview: 'Close image preview',
    collapsePanel: 'Collapse left panel', expandPanel: 'Expand left panel', liveCanvas: 'Live chat frame', referenceCaption: 'Editing on the screenshot layout',
    canvasZoom: 'Canvas zoom', zoomFitShort: 'Fit', zoomFitHint: 'Click to fit the canvas', platformSwitched: 'Platform switched. Describe what to generate.',
    selectionPersonHint: 'Name, avatar and profile', selectionFrameHint: 'Adjust the conversation content and visual detail', switchWhole: 'Switch to the whole conversation',
    inspectorTabs: 'Edit mode', copyDialogLabel: 'Image copy fallback',
    loginHandoffFailed: 'Your input could not be kept before sign-in. Download the scene file and copy your request first.',
    toolLabels: { extract_image: 'Keep screenshot', update_element: 'Update element', read_text: 'Read text positions', inspect_region: 'Inspect region', set_edits: 'Update edit layers', render_preview: 'Check render', create_scene: 'Compose dialogue', upsert_message: 'Update message', delete_message: 'Remove message', generate_image: 'Create image' },
  },
  people: {
    help: 'Save people and avatars to reuse them. Applying one copies it into the frame.',
    reading: 'Loading the people library…', reload: 'Reload', autoSave: 'Save people and avatars after a successful generation',
    applyTo: 'Apply to which person', selfSuffix: ' (you)', defaultPerson: 'Default person', savedPerson: 'Saved person',
    use: 'Use', edit: 'Edit', remove: 'Remove', empty: 'No saved people yet. Set your own avatar, or generate a conversation.',
    saveCurrent: 'Save the people in this conversation', clearDefault: 'Clear my default person',
    editPerson: 'Edit person', createPerson: 'Create a person', addPerson: 'Add another person', newMemberHint: 'New person', name: 'Name', avatar: 'Avatar',
    removeAvatar: 'Remove avatar', upload: 'Upload avatar', clear: 'Clear', describePortrait: 'Describe the avatar to create',
    generateAvatar: 'Create avatar with AI', generatingAvatar: 'Creating…', stopGenerating: 'Stop creating avatar',
    makeDefault: 'Use as my default person (applies to new conversations)', portraitGenerated: 'Avatar created. Save it to reuse in later conversations.',
    portraitFailed: 'No avatar came back. Please try again.', savedOk: 'Person saved.', applied: (name) => `Applied ${name}: name and avatar updated together.`,
    removed: 'Removed from the library; the current frame is unchanged.', savedCurrent: 'The current people were saved.', autoSaveUpdated: 'Auto-save setting updated.',
    defaultCleared: 'Default person cleared.', uploadFailed: 'The image could not be read. Choose another file.', noAvatar: 'Avatar', avatarAlt: (name) => `${name}'s avatar`,
    pendingAlt: 'Avatar to save', unsaved: 'Not saved yet',
    cacheFailed: 'Local cache failed. Keep this page open and retry sync.', caching: 'Caching…', localPending: 'Saved locally · pending sync', cloudSynced: 'Synced to account', syncing: 'Syncing…',
    useCloudVersion: 'Use cloud version', retrySave: 'Retry save', nameInvalid: 'A name must be 1-100 characters; the local draft is kept.',
    loadFailed: 'People library unavailable', keepLocal: 'Keep local edits', conflict: 'Version conflict', conflictNotice: 'The people library changed elsewhere; your local edits are kept.',
  },
  account: {
    workspaceKicker: 'WORKSPACE', workspaceStory: 'YOUR STORIES, IN ONE PLACE', workspaceTitle: (name) => `${name}'s workspace`,
    workspaceLede: 'One thought, one conversation. It all starts here.', newConversation: 'New conversation',
    startKicker: 'START WITH A CONVERSATION', startTitleA: 'Your next story', startTitleB: 'starts with you.',
    startBody: 'Write the lines, pick a platform, adjust the frame and export a screenshot.', openEditor: 'Open the editor',
    miniTitle: 'Weekend escape', miniLineA: 'Should we go see the sea this weekend?', miniLineB: 'Yes! This time we will pocket the sunset.', miniInspiration: 'Inspiration in progress ···',
    libraryTitle: 'My scenes', searchLabel: 'Search scenes', searchPlaceholder: 'Search scenes or platform', reload: 'Reload', fetching: 'Fetching your scenes…',
    emptyTitle: 'No saved scenes yet', emptyBody: 'Start a conversation, or save a local draft here.', emptyErrorTitle: 'Scenes cannot load right now', emptyErrorBody: 'Reload when the connection is back; saved scenes are kept.', openLocalDraft: 'Open local draft',
    noMatch: (query) => `No scene matches “${query}”.`, clearSearch: 'Clear search', untitled: 'Untitled conversation', newSceneTitle: 'New conversation', selfName: 'You', otherName: 'Ava',
    cardMessages: (count) => `${count} messages`, cardSaved: 'Saved', cardEdit: (title) => `Edit ${title}`, cardDelete: (title) => `Delete ${title}`,
    deleteTitle: 'Delete this scene?', deleteBody: (title) => `“${title}” will be permanently removed from the account. Exported files are unaffected.`,
    keepWork: 'Keep scene', confirmDelete: 'Delete', deleting: 'Deleting…',
    navWorks: 'My scenes', navProjects: 'Projects & batch', navInspiration: 'Scenes', navLocalDraft: 'Local draft', navAccount: 'Account settings',
    sidebarNote: 'Every save leaves a trail back to the idea.',
    loginKicker: 'WELCOME BACK', registerKicker: 'CREATE YOUR ACCOUNT', loginTitle: 'Welcome back', registerTitle: 'Create your workspace',
    loginLede: 'Sign in to IMStage and continue where you left off.', registerLede: 'Create an account to save and manage your conversation scenes.',
    nameLabel: 'What should we call you', namePlaceholder: 'Your name', emailLabel: 'Email', passwordLabel: 'Password',
    passwordHint: 'At least 12 characters. A long passphrase is fine.', loginBusy: 'Signing in…', registerBusy: 'Creating account…',
    createAccount: 'Create account', login: 'Sign in', haveAccount: 'Already have an account?', firstTime: 'First time here?', goLogin: 'Sign in', goRegister: 'Create account',
    cannotLogin: 'Cannot sign in?', tryEditor: 'Try the editor first',
    loginHelp: 'Make sure you are on the same IMStage instance where you registered. Email recovery is not configured yet; ask the instance admin to reset a password. Existing scenes are never deleted by a failed sign-in.',
    instanceNote: 'Your account and scenes live on this IMStage instance', showPassword: 'Show password', hidePassword: 'Hide password',
    gateTitle: 'Sign in to open your workspace', gateUnavailable: 'Account service is unavailable', gateBody: 'Opening the sign-in page…',
    gateUnavailableBody: 'Your scenes are still on the server. Continue when the connection is back.', reconnect: 'Reconnect', toLogin: 'Go to sign-in', authLoading: 'Checking sign-in status…',
    openingWork: 'Opening the scene…', openWorkFailed: 'This scene cannot be opened right now', openWorkFailedBody: '', backToWorks: 'Back to My scenes',
    notSaved: 'Unsaved changes', savedToAccount: 'Saved to account', savingToAccount: 'Saving to account…', offlineSavedLocal: 'Offline · saved locally',
    conflictNotice: 'The server version changed. Your local changes are kept.', deletedNotice: 'This scene was deleted on the server. Save a new copy; your local changes are kept.', saveCopy: 'Save as a new scene', openServerVersion: 'Open the server version →',
    autosaveNote: 'Unsaved changes recover in this tab', recoveredNote: 'Restored unsaved changes from this tab. Saving automatically.',
    draftRecoverable: 'Unsaved changes recover in this tab', draftStorageFailed: 'Cannot store the recovery copy. Save the scene or export JSON first',
    workDirty: 'Unsaved changes', workSaved: 'Saved to account', beforeUnload: 'Changes are unsaved and the browser cannot keep a recovery copy. Leaving will lose them. Leave anyway?',
    accountKicker: 'ACCOUNT', accountTitle: 'Account settings', accountBody: 'Manage your sign-in and the scenes on this instance.',
    accountLede: 'Manage your account and sign-in credentials.', backWorksLong: '← Back to My scenes', changePassword: 'Change password', changePasswordBody: 'All devices will be signed out and must sign in again with the new password.', passwordMinHint: 'At least 12 characters.', updating: 'Updating…', signOutBody: 'Your scenes live on this IMStage instance.',

    currentPassword: 'Current password', newPassword: 'New password', updatePassword: 'Update password', logout: 'Sign out', updated: 'Updated',
    sessionExpired: 'Your session expired. Please sign in again.', backWorks: '← My scenes', workTitleLabel: 'Session title', saveWorks: 'Save scene',
    savedCloud: 'Synced to account', cloudSaving: 'Syncing…', cloudSaved: 'Synced', cloudOffline: 'Offline · saved locally',
    cloudConflict: 'Version conflict', cloudError: 'Sync failed', cloudIdle: '', cloudPending: 'Saved locally · pending sync', syncNow: 'Sync now',
  },
  projects: {
    listKicker: 'PROJECTS', listTitle: 'Projects & batch generation', listLede: 'Organise rules, a default platform and a set of prompts into one batch run.',
    newProject: 'New project', nameLabel: 'Project name', namePlaceholder: 'For example: album launch', rulesLabel: 'Project rules', rulesPlaceholder: 'State the tone, characters and facts that must hold.',
    platformLabel: 'Default platform', create: 'Create project', creating: 'Creating…', loading: 'Loading projects…',
    emptyTitle: 'No projects yet', emptyBody: 'Create a project to store rules and generate scenes in batches.', deleteTitle: 'Delete this project?', sceneCount: (count) => `${count} scenes`,
    updated: 'Updated', open: 'Open project', delete: 'Delete project', deleteConfirm: 'Delete this project? Its scenes are kept.',
    keep: 'Keep project', confirmDelete: 'Delete', deleting: 'Deleting…', back: '← All projects',
    detailRules: 'Project rules', prompts: 'Prompts', promptsHint: 'One per line, up to 10.', addPrompt: 'Add prompt', promptPlaceholder: 'Describe what to generate this time',
    generate: 'Start batch', generating: 'Generating…', cancel: 'Cancel job',
    jobStatus: { queued: 'Queued', running: 'Generating', done: 'Done', partial: 'Partially done', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted' },
    taskStatus: { queued: 'Waiting', running: 'Generating', done: 'Saved', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted' },
    progress: (done, total) => `${done} / ${total}`, noTasks: 'No generation history yet.', openScene: 'Open scene', history: 'History',
    jobFailed: 'Generation failed', partial: 'Partially done', reason: 'Reason', noProjects: 'No projects yet.', limit: 'Limit reached', dupe: 'Already exists',
    reload: 'Reload', noRules: 'No project rules set', cancelWarning: 'Running batch jobs are cancelled too.',
    leaveConfirm: 'The project rules are unsaved. Leaving loses them. Leave anyway?', settingsSaved: 'Project settings saved',
    needPrompt: 'Add at least one prompt, one per line.', maxPrompts: (count) => `Up to ${count} prompts.`,
    needPlatform: 'Select at least one platform.', maxItems: (count) => `Up to ${count} scenes per run (prompts × platforms).`,
    openFailed: 'This project cannot be opened right now', missing: 'The project does not exist or was deleted.', scenesVersion: (count, version) => `${count} scenes · version ${version}`,
    conflictNotice: 'The project changed in another tab. Your edits are kept; reload before saving.',
    reloadConfirm: 'Reloading discards the unsaved project rules. Continue?', rulesNote: 'Rules are given to the run as a separate brief and are never written into your scenes.',
    saving: 'Saving…', saveProject: 'Save project', works: 'Project scenes',
    noWorks: 'No scenes yet. Generate below, or attach an existing scene from My scenes.',
    detach: 'Detach', attachWork: 'Attach existing scene', chooseWork: 'Choose from My scenes…', attach: 'Attach',
    batch: 'Batch generation', batchHint: (prompts, items) => `One prompt per line, up to ${prompts}; prompts × platforms up to ${items} scenes. Rules and platforms are snapshotted on submit.`,
    platformShort: 'Platform', taskRunning: 'A job is already running', promptCount: (count) => `Prompts ${count}`,
    success: 'Succeeded', failed: 'Failed', total: (count) => `${count} total`, retryFailed: 'Retry failed', view: 'View',
    aboutBatch: 'About batch generation', batchNote: 'Only scenes a model fully generated and that passed validation are saved as new work; failed, cancelled or interrupted tasks are recorded honestly and never shown as success.',
    batchNote2: 'Deleting a project only detaches scenes; it never deletes them.', manageAll: 'Manage all scenes in My scenes',

  },
  elements: {
    pickerLabel: 'Selected element', sceneOption: 'Background, title & interface', personOption: (name) => `Person · ${name}`,
    messageOption: (index, label) => `${index} · ${label}`,
    personSection: 'Person profile', avatarAlt: (name) => `${name}'s avatar preview`, changeAvatar: 'Change avatar', removeAvatar: 'Remove avatar',
    name: 'Name', subtitle: 'Note', messagePosition: 'Message side', selfSide: 'Me · right', otherSide: 'Other · left',
    messageSection: 'Message content', messageText: 'Message text', sendDate: 'Send date', sender: 'Sender', system: 'System', messageTime: 'Message time', messageType: 'Message type',
    mediaSection: 'Message media', currentMedia: 'Current message media', replaceMedia: 'Replace image', uploadMedia: 'Upload image', removeMedia: 'Remove image',
    albumCaption: (index) => `Image ${index} caption`, replaceImage: 'Replace image', removeImage: 'Remove image', addAlbumImage: 'Add album image',
    quoteSection: 'Quote & extras', subtitleField: 'Note / address / duration', quoteField: 'Quoted content',
    frameSection: 'Chat interface', headerText: 'Session title', deviceTime: 'Device time', battery: 'Battery %', storyToday: 'Story date',
    dateHelp: 'Date dividers follow each message send date.', dateText: 'Date text', composerText: 'Composer hint', watermark: 'Watermark',
    backgroundSection: 'Chat background', background: 'Background colour', backgroundImage: 'Background image', clearImage: 'Clear image',
    deviceSection: 'Device & size', device: 'Screenshot device', genericDevice: 'Generic size (current system)',
    addSection: 'Add element', addMessage: 'Add message', addMember: 'Add member', newMember: 'New member', newMessage: 'New message', newPhoto: 'New photo',
    appearanceSection: 'Appearance & layout', textColor: 'Text colour', bubbleColor: 'Bubble colour', fontSize: 'Font size', radius: 'Radius', spacing: 'Message spacing',
    width: 'Width', height: 'Height', auto: 'Auto', restoreAppearance: 'Restore default appearance',
    arrangeSection: 'Arrange & actions', moveUp: 'Move message up', moveDown: 'Move message down', duplicate: 'Duplicate', deleteMessage: 'Delete message',
    readFailed: 'The image could not be read. Choose another file.',
    navHelp: 'Pick an element to edit directly or hand to AI.', navFrame: 'Frame & interface', navPersonSection: 'People', navSelf: 'Me · right messages', navOther: 'Other · left messages',
    navMessageSection: 'Messages', navAddMessage: 'Add message', navEmpty: 'No messages yet. Click + to add one, or switch to AI create.',
    navReferenceHelp: 'Keep the screenshot layout and pick an edit layer to change.', navReferenceFull: 'Full screenshot', navReferenceText: 'Text layer', navReferenceImage: 'Image layer',
    navReferenceEmpty: 'No edit layers yet. Describe what to change in AI create.',
  },
};

export const APP_COPY: Record<Locale, AppCopy> = { zh, en };

/** One locale-aware copy object for the creator workspace. */
export function useCopy(): AppCopy {
  const { locale } = useLocale();
  return useMemo(() => APP_COPY[locale], [locale]);
}

/** Locale for date/number formatting (explicitly not for user content). */
export function useFormatLocale(): string {
  const { locale } = useLocale();
  return locale === 'zh' ? 'zh-CN' : 'en';
}
