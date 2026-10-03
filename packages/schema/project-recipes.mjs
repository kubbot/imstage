/**
 * IMStage — versioned project recipes and scenario presets.
 *
 * Pure shared data contract (no I/O) used by the account automation
 * application service, the HTTP API, the account MCP tools and the Web UI:
 *
 *   - `ProjectRecipe`: versioned definition of a project type — names,
 *     required deliverables, caller generation guidance and deterministically
 *     checkable constraints. Recipes never claim to validate natural-language
 *     quality ("consistent tone", "plausible plot" …); they only describe it.
 *   - `ScenarioPreset`: variation dimensions plus meaningful generation
 *     guidance so a caller AI plans *different* complete dialogues per case.
 *   - `buildCasePlan`: deterministic case planning. The same
 *     (preset, caseCount, locale) always produces the same stable
 *     `case-001 …` keys and the same dimension assignments, so two clients
 *     resume one plan without re-negotiating.
 *
 * A plan is *not* generated content: it is structured guidance the caller
 * turns into real scenes and submits through the content batch API.
 */

export const PROJECT_RECIPE_VERSION = 1;

/** Project type identifiers (stable machine strings). */
export const PROJECT_TYPES = Object.freeze(['training', 'demo', 'story', 'evaluation_dataset', 'custom']);

/** Scenario preset identifiers (stable machine strings). */
export const SCENARIO_PRESETS = Object.freeze(['friendship', 'support', 'teaching', 'story', 'custom']);

export const PROJECT_RECIPE_LIMITS = Object.freeze({
  name: 80,
  description: 500,
  brief: 4000,
  castMembers: 20,
  castName: 80,
  castRole: 80,
});

export const SCENARIO_LIMITS = Object.freeze({
  name: 80,
  brief: 4000,
  caseName: 120,
  objective: 600,
  context: 2000,
  scenariosPerProject: 20,
  caseCountMin: 1,
  caseCountMax: 100,
  defaultCaseCount: 50,
  batchItemsMax: 20,
});

/** Named bounds shared by code and tests. */
export const DEFAULT_CASE_COUNT = SCENARIO_LIMITS.defaultCaseCount;
export const MAX_CASE_COUNT = SCENARIO_LIMITS.caseCountMax;
export const MAX_SCENARIOS_PER_PROJECT = SCENARIO_LIMITS.scenariosPerProject;

/** Locales a scenario plan can be generated for. */
export const SCENARIO_LOCALES = Object.freeze(['zh-CN', 'en']);

const b = (zh, en) => Object.freeze({ zh, en });
/** Resolve a recipe's bilingual text at a display/prompt boundary. */
export function localizeRecipeText(value, locale) {
  return typeof value === 'string' ? value : (locale === 'en' ? value?.en : value?.zh) ?? '';
}
const localized = localizeRecipeText;
const frozenList = (items) => Object.freeze(items.map((item) => Object.freeze(item)));

/* ------------------------------------------------------------------ */
/* Project recipes                                                     */
/* ------------------------------------------------------------------ */

/**
 * Every recipe lists the same deterministic core deliverables plus
 * type-specific extras. `constraints` are checkable by code; `guidance`
 * documents what the caller AI must generate (the server never generates it).
 */
export const PROJECT_RECIPES = Object.freeze([
  Object.freeze({
    type: 'training',
    version: PROJECT_RECIPE_VERSION,
    name: b('培训', 'Training'),
    description: b(
      '客服、销售、内部培训等训练素材：每个案例是一段可复盘的完整对话。',
      'Training material (support, sales, onboarding): each case is one reviewable full dialogue.',
    ),
    requiredDeliverables: frozenList(['project.json', 'README.md', 'cases.jsonl', 'scenes', 'renders', 'manifest.json', 'validation.json']),
    extraDeliverables: frozenList([]),
    guidance: frozenList([
      b('每个案例包含明确的训练目标与背景，对话要能支撑复盘讨论。', 'Give every case a clear training objective and context; the dialogue must support a debrief.'),
      b('人物、语气与业务背景保持稳定，困难点按计划逐案变化。', 'Keep cast, tone and business background stable; vary the difficulty as planned per case.'),
    ]),
    constraints: frozenList([
      b('案例数量 1-100，项目场景数上限 20。', '1–100 cases per scenario; at most 20 scenarios per project.'),
      b('每条消息属于共享 Scene 契约，禁止真实截图参考与支付类消息。', 'Every message must satisfy the shared Scene contract; real-screenshot references and payment messages are rejected.'),
    ]),
  }),
  Object.freeze({
    type: 'demo',
    version: PROJECT_RECIPE_VERSION,
    name: b('产品/教学演示', 'Product / teaching demo'),
    description: b(
      '展示产品或教学流程的示例对话，强调清晰的步骤与可演示的结果。',
      'Showcase dialogues for a product or lesson flow, with clear steps and a demoable outcome.',
    ),
    requiredDeliverables: frozenList(['project.json', 'README.md', 'cases.jsonl', 'scenes', 'renders', 'manifest.json', 'validation.json']),
    extraDeliverables: frozenList([]),
    guidance: frozenList([
      b('对话围绕一个可演示的结果组织，避免与案例目标无关的支线。', 'Organize each dialogue around one demoable result; avoid side threads unrelated to the case objective.'),
    ]),
    constraints: frozenList([
      b('案例数量 1-100，项目场景数上限 20。', '1–100 cases per scenario; at most 20 scenarios per project.'),
    ]),
  }),
  Object.freeze({
    type: 'story',
    version: PROJECT_RECIPE_VERSION,
    name: b('叙事', 'Story'),
    description: b(
      '叙事性对话集：按计划的关系、氛围与转折生成有区别的完整片段。',
      'Narrative dialogue set: planned relationship, mood and turning points produce distinct full scenes.',
    ),
    requiredDeliverables: frozenList(['project.json', 'README.md', 'cases.jsonl', 'scenes', 'renders', 'manifest.json', 'validation.json']),
    extraDeliverables: frozenList([]),
    guidance: frozenList([
      b('每案聚焦一个叙事片段，保持人物连续性并落实计划中的转折。', 'Focus each case on one narrative beat; keep characters continuous and realize the planned turning point.'),
    ]),
    constraints: frozenList([
      b('案例数量 1-100，项目场景数上限 20。', '1–100 cases per scenario; at most 20 scenarios per project.'),
    ]),
  }),
  Object.freeze({
    type: 'evaluation_dataset',
    version: PROJECT_RECIPE_VERSION,
    name: b('评测数据集', 'Evaluation dataset'),
    description: b(
      '结构化评测素材：除对话外必须提供 records.jsonl 与 annotations.jsonl。',
      'Structured evaluation material: besides the dialogues it requires records.jsonl and annotations.jsonl.',
    ),
    requiredDeliverables: frozenList(['project.json', 'README.md', 'cases.jsonl', 'scenes', 'renders', 'manifest.json', 'validation.json']),
    extraDeliverables: frozenList(['records.jsonl', 'annotations.jsonl']),
    guidance: frozenList([
      b('每案都要提供调用方标注（labels），缺失标注的案例不能计入完成。', 'Every case needs caller-provided annotations (labels); a case without them never counts as complete.'),
    ]),
    constraints: frozenList([
      b('标注为 {labels:{<key>:<string>}}，每案最多 20 个标签，key ≤ 80 字，value ≤ 1000 字。', 'Annotations are {labels:{<key>:<string>}} — at most 20 labels per case, key ≤ 80 chars, value ≤ 1000 chars.'),
    ]),
  }),
  Object.freeze({
    type: 'custom',
    version: PROJECT_RECIPE_VERSION,
    name: b('通用', 'Custom'),
    description: b(
      '通用项目：沿用全部核心交付物，按项目 brief 自由组织。',
      'Generic project: all core deliverables, organized freely by the project brief.',
    ),
    requiredDeliverables: frozenList(['project.json', 'README.md', 'cases.jsonl', 'scenes', 'renders', 'manifest.json', 'validation.json']),
    extraDeliverables: frozenList([]),
    guidance: frozenList([
      b('旧项目默认迁移到本配方（v1），原有数据与 revision 保持不变。', 'Legacy projects migrate to this recipe (v1) with all data and revisions preserved.'),
    ]),
    constraints: frozenList([]),
  }),
]);

const RECIPE_BY_TYPE = new Map(PROJECT_RECIPES.map((recipe) => [recipe.type, recipe]));

/** Look up a recipe; returns `null` for unknown types (callers map that to 400). */
export function projectRecipe(type) {
  return RECIPE_BY_TYPE.get(type) ?? null;
}

export function isProjectType(type) {
  return RECIPE_BY_TYPE.has(type);
}

/* ------------------------------------------------------------------ */
/* Scenario presets                                                    */
/* ------------------------------------------------------------------ */

function dimension(key, name, values, valuesEn) {
  return Object.freeze({
    key,
    name,
    values: frozenList(values.map((zh, index) => b(zh, valuesEn[index]))),
  });
}

/**
 * `goalKey` / `frictionKey` name the semantically meaningful dimensions used
 * to phrase each case objective (the last declared dimension is not always the
 * goal — e.g. teaching ends with an interaction style).
 */

/**
 * Preset variation dimensions. `buildCasePlan` walks the cartesian product of
 * these lists in a fixed order, which is what makes planned cases meaningfully
 * different instead of 50 copies of one prompt.
 */
export const SCENARIO_PRESET_RECIPES = Object.freeze([
  Object.freeze({
    preset: 'friendship',
    version: PROJECT_RECIPE_VERSION,
    name: b('结交新朋友', 'Making new friends'),
    description: b(
      'WhatsApp 等平台上结交新朋友：按认识渠道、共同兴趣、关系阶段、沟通困难与预期结果规划差异。',
      'Making a new friend on WhatsApp-style platforms, varied by how they met, shared interests, relationship stage, communication friction and outcome.',
    ),
    goalKey: 'outcome',
    frictionKey: 'difficulty',
    dimensions: frozenList([
      dimension('meeting_channel', b('认识渠道', 'How they met'),
        ['校园社团', '同事介绍', '线上社群', '朋友聚会', '邻里日常', '兴趣课程', '志愿活动', '旅途偶遇'],
        ['campus club', 'introduced by a colleague', 'online community', 'friends gathering', 'neighbourhood', 'hobby class', 'volunteering', 'travel encounter']),
      dimension('shared_interest', b('共同兴趣', 'Shared interest'),
        ['阅读', '健身', '美食', '游戏', '音乐', '旅行', '摄影', '电影'],
        ['reading', 'fitness', 'food', 'gaming', 'music', 'travel', 'photography', 'movies']),
      dimension('relationship_stage', b('关系阶段', 'Relationship stage'),
        ['初次见面', '互相试探', '逐渐熟络', '约定下次'],
        ['first meeting', 'getting a feel for each other', 'warming up', 'planning to meet again']),
      dimension('difficulty', b('沟通困难', 'Communication friction'),
        ['冷场', '话题分歧', '回复延迟', '语言习惯不同', '礼貌距离', '时间难协调'],
        ['awkward silence', 'disagreement', 'slow replies', 'different language habits', 'polite distance', 'scheduling']),
      dimension('outcome', b('预期结果', 'Expected outcome'),
        ['交换联系方式', '约定一起活动', '自然收尾', '保持长期联系'],
        ['exchanging contacts', 'agreeing on an activity', 'a natural close', 'staying in touch']),
    ]),
    guidance: frozenList([
      b('对话 6–10 条自然交替的消息，包含一次轻微沟通困难与恢复，结尾落实到具体的预期结果。', 'Write 6–10 naturally alternating messages including one light friction and recovery; the ending lands on the concrete expected outcome.'),
      b('语气符合关系阶段：初次见面更礼貌，逐渐熟络更随意。', 'Match the tone to the relationship stage: polite at first meeting, casual as they warm up.'),
    ]),
  }),
  Object.freeze({
    preset: 'support',
    version: PROJECT_RECIPE_VERSION,
    name: b('客服与支持', 'Support'),
    description: b(
      '客服/支持对话：按问题类型、情绪状态、支持方式、沟通障碍与期望结果规划差异。',
      'Support dialogues varied by issue type, customer mood, support approach, communication barrier and resolution.',
    ),
    goalKey: 'outcome',
    frictionKey: 'barrier',
    dimensions: frozenList([
      dimension('issue_type', b('问题类型', 'Issue type'),
        ['订单查询', '退款进度', '使用故障', '账号问题', '预约改期', '投诉升级'],
        ['order lookup', 'refund status', 'product failure', 'account issue', 'rescheduling', 'escalated complaint']),
      dimension('mood', b('情绪状态', 'Customer mood'),
        ['平静', '着急', '不满', '困惑', '失望', '感激'],
        ['calm', 'anxious', 'unhappy', 'confused', 'disappointed', 'grateful']),
      dimension('approach', b('支持方式', 'Support approach'),
        ['逐步引导', '直接解决', '安抚后处理', '转接专家', '提供替代方案'],
        ['step-by-step guidance', 'direct fix', 'calm then solve', 'escalate to specialist', 'offer an alternative']),
      dimension('barrier', b('沟通障碍', 'Barrier'),
        ['信息不全', '术语不理解', '渠道不畅', '情绪激动', '多次转接'],
        ['missing information', 'jargon', 'channel issues', 'heightened emotion', 'too many transfers']),
      dimension('outcome', b('期望结果', 'Expected outcome'),
        ['问题解决', '约定后续跟进', '给出补偿', '确认理解一致', '升级处理'],
        ['resolved', 'follow-up scheduled', 'compensation offered', 'shared understanding', 'escalated']),
    ]),
    guidance: frozenList([
      b('先确认问题与情绪，再按支持方式推进，结尾确认期望结果。', 'Confirm the issue and mood first, follow the planned approach, and close on the expected outcome.'),
    ]),
  }),
  Object.freeze({
    preset: 'teaching',
    version: PROJECT_RECIPE_VERSION,
    name: b('教学', 'Teaching'),
    description: b(
      '师生教学对话：按教学主题、学生水平、教学目标、常见误区与课堂互动规划差异。',
      'Teacher–student dialogues varied by topic, level, goal, common mistake and interaction style.',
    ),
    goalKey: 'goal',
    frictionKey: 'pitfall',
    dimensions: frozenList([
      dimension('topic', b('教学主题', 'Topic'),
        ['数学应用题', '英语写作', '物理实验', '编程入门', '阅读理解', '口语练习'],
        ['math word problems', 'English writing', 'physics lab', 'intro to programming', 'reading comprehension', 'speaking practice']),
      dimension('level', b('学生水平', 'Student level'),
        ['入门', '基础', '进阶', '复习巩固'],
        ['beginner', 'elementary', 'intermediate', 'review']),
      dimension('goal', b('教学目标', 'Goal'),
        ['理解概念', '掌握步骤', '纠正习惯', '建立信心', '迁移应用'],
        ['understand the concept', 'master the steps', 'fix a habit', 'build confidence', 'transfer to new problems']),
      dimension('pitfall', b('常见误区', 'Common mistake'),
        ['概念混淆', '步骤跳步', '审题不细', '公式套错', '表达不清'],
        ['confused concepts', 'skipped steps', 'misread the question', 'wrong formula', 'unclear expression']),
      dimension('interaction', b('课堂互动', 'Interaction'),
        ['提问引导', '示范后练习', '错题复盘', '小步反馈', '鼓励总结'],
        ['guided questions', 'demo then practise', 'review mistakes', 'small-step feedback', 'encourage a summary']),
    ]),
    guidance: frozenList([
      b('对话体现一次误区出现与纠正，结尾由学生复述要点。', 'Show one mistake and its correction; end with the student restating the key point.'),
    ]),
  }),
  Object.freeze({
    preset: 'story',
    version: PROJECT_RECIPE_VERSION,
    name: b('故事', 'Story'),
    description: b(
      '叙事片段：按叙事视角、场景氛围、情节转折、人物关系与结局走向规划差异。',
      'Narrative beats varied by point of view, mood, turning point, relationship and ending.',
    ),
    goalKey: 'ending',
    frictionKey: 'turn',
    dimensions: frozenList([
      dimension('pov', b('叙事视角', 'Point of view'), ['第一人称', '双线对话', '群聊', '回忆穿插'], ['first person', 'two-perspective', 'group chat', 'interleaved memory']),
      dimension('mood', b('场景氛围', 'Mood'), ['温馨', '紧张', '幽默', '忧伤', '惊喜'], ['warm', 'tense', 'humorous', 'wistful', 'surprising']),
      dimension('turn', b('情节转折', 'Turning point'), ['误会澄清', '意外来信', '立场反转', '秘密揭开', '承诺兑现'], ['misunderstanding cleared', 'unexpected message', 'stance reversal', 'secret revealed', 'promise kept']),
      dimension('relation', b('人物关系', 'Relationship'), ['老友', '新邻居', '同事', '家人', '师徒'], ['old friends', 'new neighbours', 'colleagues', 'family', 'mentor and mentee']),
      dimension('ending', b('结局走向', 'Ending'), ['和解', '开放式', '启程', '告别', '重逢'], ['reconciliation', 'open ending', 'departure', 'farewell', 'reunion']),
    ]),
    guidance: frozenList([
      b('每案是一段完整片段，落实计划中的转折与结局。', 'Each case is one complete beat realizing the planned turn and ending.'),
    ]),
  }),
  Object.freeze({
    preset: 'custom',
    version: PROJECT_RECIPE_VERSION,
    name: b('自定义', 'Custom'),
    description: b(
      '自定义情境：用通用维度帮助调用方规划有区别的案例，具体主题由 brief 给出。',
      'Custom scenario: generic dimensions help the caller plan distinct cases; the brief carries the real topic.',
    ),
    goalKey: 'goal',
    frictionKey: 'difficulty',
    dimensions: frozenList([
      dimension('topic_shift', b('主题变化', 'Topic shift'), ['场景 A', '场景 B', '场景 C', '场景 D'], ['scene A', 'scene B', 'scene C', 'scene D']),
      dimension('cast_mix', b('角色搭配', 'Cast mix'), ['两人对话', '三人对话', '新角色加入', '老角色回归'], ['two speakers', 'three speakers', 'newcomer', 'returning character']),
      dimension('setting', b('情境背景', 'Setting'), ['工作日', '周末', '出行途中', '线上沟通'], ['workday', 'weekend', 'on the move', 'online']),
      dimension('difficulty', b('沟通难点', 'Friction'), ['信息差', '情绪波动', '时间压力', '表达差异'], ['information gap', 'emotions', 'time pressure', 'different expression']),
      dimension('goal', b('目标结果', 'Goal'), ['达成一致', '留下悬念', '完成交接', '互相确认'], ['agreement', 'a hook left open', 'handover done', 'mutual confirmation']),
    ]),
    guidance: frozenList([
      b('按 brief 的主题生成完整对话，逐案落实计划中的维度组合。', 'Follow the brief topic and realize the planned dimension combination in each full dialogue.'),
    ]),
  }),
]);

const PRESET_BY_ID = new Map(SCENARIO_PRESET_RECIPES.map((preset) => [preset.preset, preset]));

export function scenarioPreset(preset) {
  return PRESET_BY_ID.get(preset) ?? null;
}

export function isScenarioPreset(preset) {
  return PRESET_BY_ID.has(preset);
}

/* ------------------------------------------------------------------ */
/* Deterministic case planning                                         */
/* ------------------------------------------------------------------ */

/** Stable item keys: `case-001` … `case-100`. */
export function caseItemKey(ordinal) {
  return `case-${String(ordinal).padStart(3, '0')}`;
}

/** Parse a stable case key back to its 1-based ordinal; `null` when invalid. */
export function parseCaseItemKey(key) {
  if (typeof key !== 'string') return null;
  const match = /^case-(\d{3})$/.exec(key);
  if (!match) return null;
  const ordinal = Number(match[1]);
  return ordinal >= 1 && ordinal <= 100 ? ordinal : null;
}

function clampText(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * Deterministic coprime stride over the complete mixed-radix variation space.
 *
 * The stride starts near `total / caseCount` (so consecutive cases differ
 * visibly) and increments until it is coprime with the space size, which makes
 * every planned case a *unique* tuple and spreads the plan across the whole
 * cartesian product instead of cycling one or two dimensions.
 */
export function coprimeStride(total, caseCount) {
  let stride = Math.max(1, Math.ceil(total / Math.max(1, caseCount)));
  while (gcd(stride, total) !== 1) stride += 1;
  return stride;
}

function coversAllValues(sizes, caseCount, stride) {
  const total = sizes.reduce((product, size) => product * size, 1);
  const coverage = sizes.map(() => new Set());
  for (let i = 0; i < caseCount; i += 1) {
    const index = (i * stride) % total;
    let multiplier = 1;
    for (let position = 0; position < sizes.length; position += 1) {
      coverage[position].add(Math.floor(index / multiplier) % sizes[position]);
      multiplier *= sizes[position];
    }
  }
  return coverage.every((seen, position) => seen.size === sizes[position]);
}

/**
 * Deterministic stride selection: the first coprime stride near
 * `total / caseCount` that additionally covers every dimension value within
 * the plan (bounded scan; the plain coprime stride is the fallback).
 */
function planStride(sizes, caseCount) {
  const total = sizes.reduce((product, size) => product * size, 1);
  const base = Math.max(1, Math.ceil(total / Math.max(1, caseCount)));
  let fallback = null;
  for (let stride = base; stride < base + 1_000; stride += 1) {
    if (gcd(stride, total) !== 1) continue;
    if (fallback === null) fallback = stride;
    if (coversAllValues(sizes, caseCount, stride)) return stride;
  }
  return fallback ?? coprimeStride(total, caseCount);
}

function dimensionValues(presetRecipe, caseCount, ordinal) {
  const sizes = presetRecipe.dimensions.map((dim) => dim.values.length);
  const total = sizes.reduce((product, size) => product * size, 1);
  const index = ((ordinal - 1) * planStride(sizes, caseCount)) % total;
  const picked = [];
  let multiplier = 1;
  for (let position = 0; position < presetRecipe.dimensions.length; position += 1) {
    const dim = presetRecipe.dimensions[position];
    picked.push({ key: dim.key, label: dim.name, value: dim.values[Math.floor(index / multiplier) % sizes[position]] });
    multiplier *= sizes[position];
  }
  return picked;
}

function planObjective(presetRecipe, picked, locale) {
  const goal = picked.find((entry) => entry.key === presetRecipe.goalKey) ?? picked[picked.length - 1];
  const friction = picked.find((entry) => entry.key === presetRecipe.frictionKey) ?? picked[0];
  const text =
    locale === 'en'
      ? `Reach the outcome “${localized(goal.value, locale)}” while handling “${localized(friction.value, locale)}” naturally.`
      : `围绕「${localized(goal.value, locale)}」的结果展开，并自然处理「${localized(friction.value, locale)}」。`;
  return clampText(text, SCENARIO_LIMITS.objective);
}

function planName(presetRecipe, picked, ordinal, locale) {
  const parts = picked.slice(0, 3).map((entry) => localized(entry.value, locale));
  const prefix = localized(presetRecipe.name, locale);
  return clampText(`${prefix} ${String(ordinal).padStart(3, '0')} · ${parts.join(' · ')}`, SCENARIO_LIMITS.caseName);
}

function planContext(presetRecipe, picked, scenario, locale) {
  const facts = picked
    .map((entry) => `${localized(entry.label, locale)}：${localized(entry.value, locale)}`)
    .join(locale === 'en' ? '; ' : '；');
  const brief = scenario.brief ? ` ${clampText(scenario.brief, 400)}` : '';
  const text =
    locale === 'en'
      ? `Scenario “${scenario.name}” on ${scenario.platform}. Planned variation: ${facts}.${brief}`
      : `场景「${scenario.name}」，平台 ${scenario.platform}。计划变化：${facts}。${brief}`;
  return clampText(text, SCENARIO_LIMITS.context);
}

/**
 * Build the full deterministic case plan for a scenario.
 *
 * @param {{preset?: string, caseCount?: number, locale?: string, name?: string, brief?: string, platform?: string}} input
 * @returns {{preset: string, caseCount: number, locale: string, cases: Array<object>, suggestedRanges: Array<object>}}
 */
export function buildCasePlan(input = {}) {
  const presetId = input.preset ?? 'custom';
  const presetRecipe = scenarioPreset(presetId);
  if (!presetRecipe) throw new Error(`unknown scenario preset: ${presetId}`);
  const caseCount = input.caseCount ?? SCENARIO_LIMITS.defaultCaseCount;
  if (!Number.isInteger(caseCount) || caseCount < SCENARIO_LIMITS.caseCountMin || caseCount > SCENARIO_LIMITS.caseCountMax) {
    throw new Error(`caseCount must be an integer in ${SCENARIO_LIMITS.caseCountMin}-${SCENARIO_LIMITS.caseCountMax}`);
  }
  const locale = SCENARIO_LOCALES.includes(input.locale) ? input.locale : 'zh-CN';
  const scenario = {
    name: clampText(input.name ?? '', SCENARIO_LIMITS.name),
    brief: String(input.brief ?? ''),
    platform: String(input.platform ?? ''),
  };
  const cases = [];
  for (let ordinal = 1; ordinal <= caseCount; ordinal += 1) {
    const picked = dimensionValues(presetRecipe, caseCount, ordinal);
    cases.push(
      Object.freeze({
        itemKey: caseItemKey(ordinal),
        ordinal,
        name: planName(presetRecipe, picked, ordinal, locale),
        objective: planObjective(presetRecipe, picked, locale),
        context: planContext(presetRecipe, picked, scenario, locale),
        guide: Object.freeze({
          preset: presetId,
          variation: Object.freeze(picked.map((entry) => Object.freeze({ key: entry.key, label: entry.label, value: entry.value }))),
        }),
      }),
    );
  }
  return Object.freeze({
    preset: presetId,
    caseCount,
    locale,
    guidance: presetRecipe.guidance,
    cases: Object.freeze(cases),
    suggestedRanges: suggestedBatchRanges(caseCount),
  });
}

/**
 * Suggested submission ranges (max 20 items per content batch): 50 cases →
 * 20 / 20 / 10. Pure arithmetic over the stable keys.
 */
export function suggestedBatchRanges(caseCount) {
  const ranges = [];
  let start = 1;
  while (start <= caseCount) {
    const end = Math.min(start + SCENARIO_LIMITS.batchItemsMax - 1, caseCount);
    ranges.push({
      fromKey: caseItemKey(start),
      toKey: caseItemKey(end),
      count: end - start + 1,
    });
    start = end + 1;
  }
  return Object.freeze(ranges.map((range) => Object.freeze(range)));
}

/** Recipe summary used by `imstage_list_project_types` / `GET /api/project-types`. */
export function projectTypeSummaries() {
  return PROJECT_RECIPES.map((recipe) => ({
    type: recipe.type,
    version: recipe.version,
    name: recipe.name,
    description: recipe.description,
    requiredDeliverables: recipe.requiredDeliverables,
    extraDeliverables: recipe.extraDeliverables,
    guidance: recipe.guidance,
    constraints: recipe.constraints,
  }));
}

/** Preset summary used alongside scenario planning reads. */
export function scenarioPresetSummaries() {
  return SCENARIO_PRESET_RECIPES.map((preset) => ({
    preset: preset.preset,
    version: preset.version,
    name: preset.name,
    description: preset.description,
    dimensions: preset.dimensions.map((dim) => ({ key: dim.key, name: dim.name, values: dim.values })),
    guidance: preset.guidance,
    defaultCaseCount: SCENARIO_LIMITS.defaultCaseCount,
    caseCount: { min: SCENARIO_LIMITS.caseCountMin, max: SCENARIO_LIMITS.caseCountMax },
  }));
}

export { localized as localizeLabel };
