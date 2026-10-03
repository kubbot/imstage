/**
 * Typed zh/en copy for the Project → Scenario → Case workflow.
 *
 * A small localized module (per the batch C contract) using the existing
 * locale context — production buttons are never hard-coded in one language.
 * User content (names, briefs, case text) is never translated here.
 */
import { useLocale } from '../marketing/LocaleContext';

export interface ScenarioCopy {
  projectLabel: string;
  scenarioLabel: string;
  caseLabel: string;
  /* project type picker */
  typeLegend: string;
  typeHint: string;
  typeDeliverables: string;
  typeExtraDeliverables: string;
  typeDefaultBadge: string;
  /* structured project brief */
  briefLegend: string;
  briefLanguage: string;
  briefLanguageHint: string;
  briefCast: string;
  briefCastName: string;
  briefCastRole: string;
  briefCastAdd: string;
  briefCastRemove: string;
  briefCastHint: string;
  /* scenario form */
  scenarioLegend: string;
  scenarioNew: string;
  scenarioName: string;
  scenarioNamePlaceholder: string;
  scenarioBrief: string;
  scenarioBriefPlaceholder: string;
  scenarioPreset: string;
  scenarioCaseCount: string;
  scenarioCaseCountHint: string;
  scenarioLocale: string;
  scenarioAutoExport: string;
  scenarioAutoExportHelp: string;
  scenarioSubmit: string;
  scenarioSubmitting: string;
  scenarioNeedName: string;
  /* scenario list + hierarchy */
  hierarchy: string;
  scenarioEmpty: string;
  scenarioProgress: (submitted: number, total: number) => string;
  scenarioStatusCollecting: string;
  scenarioStatusReady: string;
  scenarioOpen: string;
  /* case plan list */
  caseLegend: string;
  casePlanHint: string;
  caseFilter: string;
  caseFilterAll: string;
  caseFilterPending: string;
  caseFilterSubmitted: string;
  casePageInfo: (page: number, pages: number) => string;
  casePrev: string;
  caseNext: string;
  caseOpenScene: string;
  casePending: string;
  caseSubmitted: string;
  caseObjective: string;
  caseContext: string;
  caseVariation: string;
  caseEmpty: string;
  caseMissingKeys: (count: number) => string;
  /* AI generation (explicit user action only) */
  aiLegend: string;
  aiGenerate: string;
  aiGenerating: string;
  aiUnavailable: string;
  aiHint: string;
  aiUsageNote: string;
  aiCancel: string;
  aiRetryMissing: string;
  aiProgress: (done: number, failed: number, total: number) => string;
  aiPending: (count: number) => string;
  aiStatus: Record<string, string>;
  aiNothing: string;
  aiEvaluationBlocked: string;
  /* deterministic file delivery */
  exportLegend: string;
  exportNow: string;
  exportExporting: string;
  exportDownload: string;
  exportExpired: string;
  exportRenew: string;
  exportRetryFailed: string;
  exportCancel: string;
  exportHistory: string;
  exportCurrentLabel: string;
  exportEmpty: string;
  exportReadyHint: string;
  exportCoverageNote: string;
  exportExpires: (date: string) => string;
  exportStatus: Record<string, string>;
  exportPartialTag: string;
  exportMissing: (count: number) => string;
  exportScopeProject: string;
  exportScopeScenario: string;
  reload: string;
}

const zh: ScenarioCopy = {
  projectLabel: '项目',
  scenarioLabel: '场景',
  caseLabel: '案例',
  typeLegend: '项目类型',
  typeHint: '类型决定最终交付的文件清单。',
  typeDeliverables: '将交付的文件',
  typeExtraDeliverables: '额外交付',
  typeDefaultBadge: '默认',
  briefLegend: '人物与语言',
  briefLanguage: '语言',
  briefLanguageHint: '留给生成与交付的默认语言设置。',
  briefCast: '人物表（可选）',
  briefCastName: '姓名',
  briefCastRole: '角色',
  briefCastAdd: '添加人物',
  briefCastRemove: '删除',
  briefCastHint: '最多 20 人；人物姓名与角色会冻结到场景生成中。',
  scenarioLegend: '场景',
  scenarioNew: '新建场景',
  scenarioName: '场景名称',
  scenarioNamePlaceholder: '例如：WhatsApp 认识新朋友',
  scenarioBrief: '场景说明',
  scenarioBriefPlaceholder: '描述这个真实使用情境，例如在哪里认识、聊什么……',
  scenarioPreset: '场景预设',
  scenarioCaseCount: '案例数量',
  scenarioCaseCountHint: ((): string => '1–100，默认 50 个互不重复的案例。')(),
  scenarioLocale: '语言',
  scenarioAutoExport: '内容齐备后自动导出文件包',
  scenarioAutoExportHelp: '最后一个案例提交完成后自动排队一次确定性导出。',
  scenarioSubmit: '创建场景',
  scenarioSubmitting: '正在创建…',
  scenarioNeedName: '请填写场景名称。',
  hierarchy: '项目 → 场景 → 案例',
  scenarioEmpty: '还没有场景。先创建一个真实使用情境。',
  scenarioProgress: (submitted, total) => `${submitted}/${total} 个案例已提交`,
  scenarioStatusCollecting: '内容收集中',
  scenarioStatusReady: '内容已齐备',
  scenarioOpen: '查看案例',
  caseLegend: '案例计划',
  casePlanHint: '每个案例有稳定编号、目标和背景；计划不是已完成内容。',
  caseFilter: '筛选',
  caseFilterAll: '全部',
  caseFilterPending: '仅缺项',
  caseFilterSubmitted: '仅已提交',
  casePageInfo: (page, pages) => `第 ${page}/${pages} 页`,
  casePrev: '上一页',
  caseNext: '下一页',
  caseOpenScene: '打开作品',
  casePending: '待提交',
  caseSubmitted: '已提交',
  caseObjective: '目标',
  caseContext: '背景',
  caseVariation: '变化',
  caseEmpty: '没有符合筛选的案例。',
  caseMissingKeys: (count) => `缺少 ${count} 个案例`,
  aiLegend: 'AI 生成案例',
  aiGenerate: 'AI 生成案例',
  aiGenerating: '正在生成…',
  aiUnavailable: 'AI 服务未配置：无法生成案例；仍可用 MCP 提交内容或导出已有内容。',
  aiHint: '为缺项案例生成完整对话；已提交的案例不会重新生成。',
  aiUsageNote: '生成会消耗账号的模型用量，仅在你点击后才会运行。',
  aiCancel: '取消生成',
  aiRetryMissing: '重试缺项/失败项',
  aiProgress: (done, failed, total) => `成功 ${done} · 失败 ${failed} · 共 ${total}`,
  aiPending: (count) => `${count} 个案例排队中`,
  aiStatus: { queued: '排队中', running: '生成中', done: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' },
  aiNothing: '没有缺少内容的案例。',
  aiEvaluationBlocked: '评测数据集案例需要调用方提供标注，不能由 AI 生成。',
  exportLegend: '文件交付',
  exportNow: '导出文件',
  exportExporting: '正在导出…',
  exportDownload: '下载 ZIP',
  exportExpired: '已过期',
  exportRenew: '重新导出',
  exportRetryFailed: '重试失败项',
  exportCancel: '取消导出',
  exportHistory: '历史文件包',
  exportCurrentLabel: '当前文件包',
  exportEmpty: '还没有文件包。',
  exportReadyHint: '只有真实完成或明确标注为部分完成的文件包可以下载。',
  exportCoverageNote: '每个文件包是单独的下载；多个文件包共同覆盖项目内容。',
  exportExpires: (date) => `下载有效期至 ${date}`,
  exportStatus: { queued: '排队中', running: '打包中', completed: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' },
  exportPartialTag: '部分完成',
  exportMissing: (count) => `缺 ${count} 项`,
  exportScopeProject: '整个项目',
  exportScopeScenario: '单个场景',
  reload: '重新加载',
};

const en: ScenarioCopy = {
  projectLabel: 'Project',
  scenarioLabel: 'Scenario',
  caseLabel: 'Cases',
  typeLegend: 'Project type',
  typeHint: 'The type decides which files are delivered.',
  typeDeliverables: 'Files delivered',
  typeExtraDeliverables: 'Extra files',
  typeDefaultBadge: 'Default',
  briefLegend: 'Cast & language',
  briefLanguage: 'Language',
  briefLanguageHint: 'Default language used for generation and delivery.',
  briefCast: 'Cast (optional)',
  briefCastName: 'Name',
  briefCastRole: 'Role',
  briefCastAdd: 'Add person',
  briefCastRemove: 'Remove',
  briefCastHint: 'Up to 20 people; names and roles are frozen into scenario generation.',
  scenarioLegend: 'Scenarios',
  scenarioNew: 'New scenario',
  scenarioName: 'Scenario name',
  scenarioNamePlaceholder: 'e.g. Meeting new friends on WhatsApp',
  scenarioBrief: 'Scenario brief',
  scenarioBriefPlaceholder: 'Describe the real situation — where people meet, what they talk about…',
  scenarioPreset: 'Preset',
  scenarioCaseCount: 'Cases',
  scenarioCaseCountHint: '1–100, 50 distinct cases by default.',
  scenarioLocale: 'Language',
  scenarioAutoExport: 'Auto-export a file package when content is complete',
  scenarioAutoExportHelp: 'Queues one deterministic export after the final case is submitted.',
  scenarioSubmit: 'Create scenario',
  scenarioSubmitting: 'Creating…',
  scenarioNeedName: 'Please enter a scenario name.',
  hierarchy: 'Project → Scenario → Cases',
  scenarioEmpty: 'No scenarios yet. Start with one real usage situation.',
  scenarioProgress: (submitted, total) => `${submitted}/${total} cases submitted`,
  scenarioStatusCollecting: 'Collecting content',
  scenarioStatusReady: 'Content complete',
  scenarioOpen: 'View cases',
  caseLegend: 'Case plan',
  casePlanHint: 'Every case has a stable key, objective and context; the plan is not finished content.',
  caseFilter: 'Filter',
  caseFilterAll: 'All',
  caseFilterPending: 'Missing only',
  caseFilterSubmitted: 'Submitted only',
  casePageInfo: (page, pages) => `Page ${page}/${pages}`,
  casePrev: 'Previous',
  caseNext: 'Next',
  caseOpenScene: 'Open scene',
  casePending: 'Pending',
  caseSubmitted: 'Submitted',
  caseObjective: 'Objective',
  caseContext: 'Context',
  caseVariation: 'Variation',
  caseEmpty: 'No cases match this filter.',
  caseMissingKeys: (count) => `${count} cases missing`,
  aiLegend: 'AI case generation',
  aiGenerate: 'Generate cases with AI',
  aiGenerating: 'Generating…',
  aiUnavailable: 'AI service is not configured: generation is unavailable; MCP content submission and exports still work.',
  aiHint: 'Generates full conversations for missing cases only; submitted cases are never re-run.',
  aiUsageNote: 'Generation uses your account’s model quota and runs only when you click.',
  aiCancel: 'Cancel generation',
  aiRetryMissing: 'Retry missing/failed cases',
  aiProgress: (done, failed, total) => `${done} done · ${failed} failed · ${total} total`,
  aiPending: (count) => `${count} cases queued`,
  aiStatus: { queued: 'Queued', running: 'Generating', done: 'Completed', partial: 'Partially done', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted' },
  aiNothing: 'No case is missing content.',
  aiEvaluationBlocked: 'Evaluation dataset cases need caller-provided labels; AI generation is disabled for them.',
  exportLegend: 'File delivery',
  exportNow: 'Export files',
  exportExporting: 'Exporting…',
  exportDownload: 'Download ZIP',
  exportExpired: 'Expired',
  exportRenew: 'Export again',
  exportRetryFailed: 'Retry failed items',
  exportCancel: 'Cancel export',
  exportHistory: 'Previous packages',
  exportCurrentLabel: 'Current package',
  exportEmpty: 'No file packages yet.',
  exportReadyHint: 'Only real completed bundles — or explicitly partial ones — can be downloaded.',
  exportCoverageNote: 'Each package is a separate download; together they cover the project content.',
  exportExpires: (date) => `Downloads available until ${date}`,
  exportStatus: { queued: 'Queued', running: 'Packaging', completed: 'Completed', partial: 'Partial', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted' },
  exportPartialTag: 'Partial',
  exportMissing: (count) => `${count} items missing`,
  exportScopeProject: 'Whole project',
  exportScopeScenario: 'Single scenario',
  reload: 'Reload',
};

/** One locale-aware copy object for the scenario workflow. */
export function useScenarioCopy(): ScenarioCopy {
  const { locale } = useLocale();
  return locale === 'zh' ? zh : en;
}
