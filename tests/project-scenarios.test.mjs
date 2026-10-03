/**
 * Project automation contracts: versioned recipes, scenario presets,
 * deterministic case plans and the scenario/case lifecycle.
 *
 * Part one is pure (no database): the shared `packages/schema/project-recipes.mjs`
 * contract every transport consumes. Part two runs the account automation
 * application service against an in-memory SQLite database to prove the
 * additive migration, frozen scenario defaults, stable `case-001…` keys,
 * bounds and ownership.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  DEFAULT_CASE_COUNT,
  MAX_CASE_COUNT,
  MAX_SCENARIOS_PER_PROJECT,
  PROJECT_RECIPE_VERSION,
  PROJECT_TYPES,
  SCENARIO_LIMITS,
  SCENARIO_PRESETS,
  buildCasePlan,
  caseItemKey,
  parseCaseItemKey,
  projectRecipe,
  projectTypeSummaries,
  scenarioPreset,
  scenarioPresetSummaries,
  suggestedBatchRanges,
} from '../packages/schema/project-recipes.mjs';
import { installProjectSchema, createProjectRow } from '../services/projects/store.mjs';
import { installAutomationSchema } from '../services/projects/automation-store.mjs';
import { installGenerationAuditSchema } from '../services/audit/generation-audit.mjs';
import { installTemplateSchema } from '../services/templates/store.mjs';
import { createProjectAutomation } from '../services/projects/automation.mjs';

/* ------------------------------------------------------------------ */
/* Pure recipe / preset / case-plan contract                           */
/* ------------------------------------------------------------------ */

test('project recipes are versioned and complete for every type', () => {
  assert.deepEqual([...PROJECT_TYPES], ['training', 'demo', 'story', 'evaluation_dataset', 'custom']);
  const summaries = projectTypeSummaries();
  assert.equal(summaries.length, PROJECT_TYPES.length);
  for (const summary of summaries) {
    assert.equal(summary.version, PROJECT_RECIPE_VERSION, summary.type);
    assert.ok(summary.name.zh.length > 0 && summary.name.en.length > 0, summary.type);
    assert.ok(summary.description.zh.length > 0, summary.type);
    assert.ok(summary.requiredDeliverables.includes('project.json'), summary.type);
    assert.ok(summary.requiredDeliverables.includes('cases.jsonl'), summary.type);
    assert.ok(summary.requiredDeliverables.includes('manifest.json'), summary.type);
    assert.ok(summary.guidance.length >= 1, summary.type);
  }
  // evaluation_dataset additionally requires the structured annotation files.
  const evalRecipe = projectRecipe('evaluation_dataset');
  assert.deepEqual([...evalRecipe.extraDeliverables], ['records.jsonl', 'annotations.jsonl']);
  assert.deepEqual([...projectRecipe('custom').extraDeliverables], []);
  assert.equal(projectRecipe('unknown'), null);
  // The custom recipe documents the legacy migration default (v1).
  assert.equal(projectRecipe('custom').version, 1);
  assert.match(JSON.stringify(projectRecipe('custom').guidance), /旧项目|Legacy/);
});

test('scenario presets carry variation dimensions and generation guidance', () => {
  assert.deepEqual([...SCENARIO_PRESETS], ['friendship', 'support', 'teaching', 'story', 'custom']);
  for (const summary of scenarioPresetSummaries()) {
    const preset = scenarioPreset(summary.preset);
    assert.equal(preset.version, PROJECT_RECIPE_VERSION, summary.preset);
    assert.ok(preset.dimensions.length >= 3, summary.preset);
    for (const dimension of preset.dimensions) {
      assert.ok(dimension.values.length >= 2, `${summary.preset}.${dimension.key}`);
    }
    assert.ok(preset.guidance.length >= 1, summary.preset);
    assert.equal(summary.defaultCaseCount, 50);
    assert.deepEqual(summary.caseCount, { min: 1, max: 100 });
  }
  // The friendship preset plans the five documented variation dimensions.
  const friendship = scenarioPreset('friendship');
  assert.deepEqual(
    friendship.dimensions.map((dimension) => dimension.key),
    ['meeting_channel', 'shared_interest', 'relationship_stage', 'difficulty', 'outcome'],
  );
  assert.equal(scenarioPreset('nope'), null);
});

test('case plans are deterministic, stable and bounded', () => {
  const input = { preset: 'friendship', caseCount: 50, name: 'WhatsApp 结交新朋友', brief: '线上认识新朋友', platform: 'whatsapp', locale: 'zh-CN' };
  const first = buildCasePlan(input);
  const second = buildCasePlan(input);
  assert.deepEqual(first, second, 'the same input must plan the same cases');
  assert.equal(first.cases.length, 50);
  assert.equal(first.cases[0].itemKey, 'case-001');
  assert.equal(first.cases[49].itemKey, 'case-050');

  // 50 cases submit as 20 / 20 / 10 with stable keys.
  assert.deepEqual(
    first.suggestedRanges.map((range) => [range.fromKey, range.toKey, range.count]),
    [
      ['case-001', 'case-020', 20],
      ['case-021', 'case-040', 20],
      ['case-041', 'case-050', 10],
    ],
  );

  for (const entry of first.cases) {
    assert.equal(parseCaseItemKey(entry.itemKey), entry.ordinal);
    assert.ok(entry.name.length > 0 && entry.name.length <= SCENARIO_LIMITS.caseName);
    assert.ok(entry.objective.length > 0 && entry.objective.length <= SCENARIO_LIMITS.objective);
    assert.ok(entry.context.length > 0 && entry.context.length <= SCENARIO_LIMITS.context);
    assert.equal(entry.guide.variation.length, 5);
    for (const variation of entry.guide.variation) {
      assert.ok(variation.value.zh.length > 0 && variation.value.en.length > 0);
    }
  }
  // Consecutive cases vary: planning is not 50 copies of one prompt.
  assert.notEqual(first.cases[0].name, first.cases[1].name);
  assert.notEqual(JSON.stringify(first.cases[0].guide.variation), JSON.stringify(first.cases[1].guide.variation));

  // Default count is 50; keys stay stable for any allowed count.
  assert.equal(buildCasePlan({ preset: 'custom' }).cases.length, DEFAULT_CASE_COUNT);
  assert.equal(buildCasePlan({ preset: 'support', caseCount: 1 }).cases[0].itemKey, 'case-001');
  assert.equal(buildCasePlan({ preset: 'story', caseCount: 100 }).cases[99].itemKey, 'case-100');
  assert.deepEqual(
    suggestedBatchRanges(7).map((range) => [range.fromKey, range.toKey, range.count]),
    [['case-001', 'case-007', 7]],
  );
  assert.equal(suggestedBatchRanges(21).length, 2);
  assert.equal(caseItemKey(3), 'case-003');
  assert.equal(parseCaseItemKey('case-x'), null);
  assert.equal(parseCaseItemKey('other-001'), null);

  // Bounds are enforced by the pure contract itself.
  assert.throws(() => buildCasePlan({ preset: 'friendship', caseCount: 0 }), /caseCount/);
  assert.throws(() => buildCasePlan({ preset: 'friendship', caseCount: MAX_CASE_COUNT + 1 }), /caseCount/);
  assert.throws(() => buildCasePlan({ preset: 'friendship', caseCount: 1.5 }), /caseCount/);
  assert.throws(() => buildCasePlan({ preset: 'unknown' }), /preset/);
});

/* ------------------------------------------------------------------ */
/* Scenario / case lifecycle on the account automation service         */
/* ------------------------------------------------------------------ */

const dbs = new Set();
after(() => {
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
});

function automationDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE scenes (
      user_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, platform TEXT NOT NULL,
      message_count INTEGER NOT NULL, revision INTEGER NOT NULL, scene_json TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, id)
    );
    CREATE TABLE scene_projects (
      user_id TEXT NOT NULL, scene_id TEXT NOT NULL, project_id TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, scene_id)
    );
  `);
  installProjectSchema(db);
  installAutomationSchema(db);
  installGenerationAuditSchema(db);
  installTemplateSchema(db);
  db.prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'user-a', 'a@example.com', 'A', 'hash', new Date(0).toISOString(),
  );
  db.prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'user-b', 'b@example.com', 'B', 'hash', new Date(0).toISOString(),
  );
  dbs.add(db);
  return db;
}

function serviceFor(db) {
  return createProjectAutomation({ db, nowMs: () => Date.parse('2026-10-02T00:00:00.000Z') });
}

test('legacy databases migrate additively to the custom recipe v1', () => {
  const db = new DatabaseSync(':memory:');
  dbs.add(db);
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE scenes (user_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, platform TEXT NOT NULL, message_count INTEGER NOT NULL, revision INTEGER NOT NULL, scene_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, id));
    CREATE TABLE scene_projects (user_id TEXT NOT NULL, scene_id TEXT NOT NULL, project_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id, scene_id));
    -- Legacy project table: no type/recipe_version/brief columns.
    CREATE TABLE projects (
      user_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, rules TEXT NOT NULL DEFAULT '',
      platform TEXT NOT NULL DEFAULT 'wechat', watermark_enabled INTEGER NOT NULL DEFAULT 1,
      revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, id)
    );
  `);
  db.prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run('user-a', 'a@x.io', 'A', 'h', new Date(0).toISOString());
  db.prepare(
    'INSERT INTO projects (user_id, id, name, rules, platform, watermark_enabled, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('user-a', 'legacy-1', '旧项目', '旧规则', 'wechat', 0, 7, new Date(0).toISOString(), new Date(0).toISOString());

  installProjectSchema(db);
  installAutomationSchema(db);

  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get('legacy-1');
  assert.equal(row.type, 'custom');
  assert.equal(Number(row.recipe_version), 1);
  assert.equal(row.brief_json, '{}');
  assert.equal(row.name, '旧项目');
  assert.equal(row.rules, '旧规则');
  assert.equal(Number(row.watermark_enabled), 0, 'an explicit watermark opt-out survives migration');
  assert.equal(Number(row.revision), 7, 'revisions are preserved');

  const svc = serviceFor(db);
  const item = svc.listProjects({ userId: 'user-a' }).items[0];
  assert.equal(item.type, 'custom');
  assert.equal(item.recipeVersion, 1);
  assert.deepEqual(item.brief, {});
  assert.equal(item.revision, 7);
});

test('projects carry type/brief and scenarios freeze parent defaults', () => {
  const db = automationDb();
  const svc = serviceFor(db);

  // Type and brief validation.
  const created = svc.createProject({
    userId: 'user-a',
    input: {
      name: '客服培训',
      rules: '保持口语化',
      type: 'training',
      brief: { language: 'zh-CN', cast: [{ name: '小林', role: '客服', avatar: 'data:image/png;base64,AAAA' }] },
      defaults: { platform: 'whatsapp', watermarkEnabled: true },
    },
  });
  assert.equal(created.item.type, 'training');
  assert.equal(created.item.revision, 1);
  assert.equal(created.item.brief.cast.length, 1);
  assert.equal(created.item.brief.cast[0].avatar, 'data:image/png;base64,AAAA');
  assert.equal(created.item.platform, 'whatsapp');

  assert.throws(() => svc.createProject({ userId: 'user-a', input: { name: 'X', type: 'nope' } }), (e) => e.code === 'invalid_type');
  assert.throws(() => svc.createProject({ userId: 'user-a', input: { name: 'X', brief: { cast: [{ name: 'a'.repeat(81), role: 'r' }] } } }), (e) => e.code === 'invalid_brief');
  assert.throws(() => svc.createProject({ userId: 'user-a', input: { name: 'X', brief: { cast: new Array(21).fill({ name: 'a', role: 'r' }) } } }), (e) => e.code === 'invalid_brief');
  assert.throws(() => svc.createProject({ userId: 'user-a', input: { name: 'X', brief: { avatar: 1 } } }), (e) => e.code === 'invalid_brief');

  // Scenario freezes rules/defaults/cast and plans the cases.
  const scenario = svc.createScenario({
    userId: 'user-a',
    projectId: created.item.id,
    input: { name: 'WhatsApp 结交新朋友', brief: '结识新朋友', preset: 'friendship', caseCount: 50, platform: 'whatsapp', locale: 'zh-CN' },
  });
  assert.equal(scenario.counts.planned, 50);
  assert.equal(scenario.scenario.frozen.rules, '保持口语化');
  assert.equal(scenario.scenario.frozen.watermarkEnabled, true);
  assert.equal(scenario.scenario.frozen.cast.length, 1);
  assert.equal(scenario.scenario.frozen.cast[0].name, '小林');
  assert.equal(scenario.scenario.autoExport, true);
  assert.equal(scenario.scenario.caseCount, 50);
  assert.equal(scenario.contentStatus, 'collecting');
  assert.equal(scenario.casePlan.cases.length, 50);
  assert.equal(scenario.suggestedNextRange.fromKey, 'case-001');
  assert.deepEqual(
    scenario.casePlan.suggestedRanges.map((range) => range.count),
    [20, 20, 10],
  );

  // Later project edits never rewrite the frozen scenario.
  const updated = svc.updateProject({
    userId: 'user-a',
    projectId: created.item.id,
    expectedRevision: 1,
    input: { rules: '新规则', defaults: { platform: 'wechat', watermarkEnabled: false } },
  });
  assert.equal(updated.item.revision, 2);
  const reread = svc.getScenario({ userId: 'user-a', projectId: created.item.id, scenarioId: scenario.scenario.scenarioId });
  assert.equal(reread.scenario.frozen.rules, '保持口语化');
  assert.equal(reread.scenario.frozen.watermarkEnabled, true);
  assert.equal(reread.counts.missing, 50);
  assert.deepEqual(reread.missingItemKeys.slice(0, 2), ['case-001', 'case-002']);
  assert.ok(reread.resume.nextAction.includes('case-001'));

  // Omitted update fields keep their stored values (incl. type/brief).
  const renamed = svc.updateProject({
    userId: 'user-a',
    projectId: created.item.id,
    expectedRevision: 2,
    input: { name: '客服培训 v2' },
  });
  assert.equal(renamed.item.name, '客服培训 v2');
  assert.equal(renamed.item.type, 'training');
  assert.equal(renamed.item.brief.cast[0].name, '小林');
  assert.throws(
    () => svc.updateProject({ userId: 'user-a', projectId: created.item.id, expectedRevision: 2, input: { name: 'x' } }),
    (e) => e.code === 'revision_conflict',
  );
});

test('scenario bounds, idempotency and ownership are enforced', () => {
  const db = automationDb();
  const svc = serviceFor(db);
  const project = svc.createProject({ userId: 'user-a', input: { name: '项目' } }).item;

  // Case count bounds and default of 50.
  assert.equal(svc.createScenario({ userId: 'user-a', projectId: project.id, input: { name: '默认' } }).counts.planned, 50);
  assert.throws(() => svc.createScenario({ userId: 'user-a', projectId: project.id, input: { name: 'A', caseCount: 0 } }), (e) => e.code === 'invalid_case_count');
  assert.throws(() => svc.createScenario({ userId: 'user-a', projectId: project.id, input: { name: 'A', caseCount: 101 } }), (e) => e.code === 'invalid_case_count');
  assert.throws(() => svc.createScenario({ userId: 'user-a', projectId: project.id, input: { name: 'A', preset: 'nope' } }), (e) => e.code === 'invalid_preset');
  assert.throws(() => svc.createScenario({ userId: 'user-a', projectId: project.id, input: { name: 'A', locale: 'fr' } }), (e) => e.code === 'invalid_locale');
  assert.throws(() => svc.createScenario({ userId: 'user-a', projectId: project.id, input: { name: 'A', autoExport: 'yes' } }), (e) => e.code === 'invalid_auto_export');
  assert.throws(() => svc.createScenario({ userId: 'user-a', projectId: project.id, input: { name: '' } }), (e) => e.code === 'invalid_name');

  // autoExport can be disabled explicitly.
  assert.equal(
    svc.createScenario({ userId: 'user-a', projectId: project.id, input: { name: '不自动交付', autoExport: false } }).scenario.autoExport,
    false,
  );

  // Idempotent creation: same key + same request returns the same scenario.
  const first = svc.createScenario({
    userId: 'user-a',
    projectId: project.id,
    input: { name: '幂等场景', preset: 'support', caseCount: 3 },
    idempotencyKey: 'scenario-1',
  });
  const replay = svc.createScenario({
    userId: 'user-a',
    projectId: project.id,
    input: { name: '幂等场景', preset: 'support', caseCount: 3 },
    idempotencyKey: 'scenario-1',
  });
  assert.equal(replay.deduplicated, true);
  assert.equal(replay.scenario.scenarioId, first.scenario.scenarioId);
  assert.throws(
    () =>
      svc.createScenario({
        userId: 'user-a',
        projectId: project.id,
        input: { name: '不同内容', preset: 'support', caseCount: 3 },
        idempotencyKey: 'scenario-1',
      }),
    (e) => e.code === 'idempotency_conflict',
  );

  // Up to 20 scenarios per project.
  for (let i = svc.listScenarios({ userId: 'user-a', projectId: project.id }).items.length; i < MAX_SCENARIOS_PER_PROJECT; i += 1) {
    svc.createScenario({ userId: 'user-a', projectId: project.id, input: { name: `场景 ${i}`, caseCount: 1 } });
  }
  assert.equal(svc.listScenarios({ userId: 'user-a', projectId: project.id }).items.length, MAX_SCENARIOS_PER_PROJECT);
  assert.throws(
    () => svc.createScenario({ userId: 'user-a', projectId: project.id, input: { name: '超额', caseCount: 1 } }),
    (e) => e.code === 'scenario_limit_reached',
  );

  // Foreign accounts see nothing: no project, no scenario, no status.
  assert.throws(() => svc.getScenario({ userId: 'user-b', projectId: project.id, scenarioId: first.scenario.scenarioId }), (e) => e.status === 404);
  assert.throws(() => svc.listScenarios({ userId: 'user-b', projectId: project.id }), (e) => e.status === 404);
  assert.throws(() => svc.getProjectStatus({ userId: 'user-b', projectId: project.id }), (e) => e.status === 404);
  assert.equal(svc.listProjects({ userId: 'user-b' }).items.length, 0);
});

test('case plans cover the full variation space (coprime stride, no dimension collapse)', () => {
  for (const preset of SCENARIO_PRESETS) {
    const recipe = scenarioPreset(preset);
    for (const caseCount of [50, 100]) {
      const plan = buildCasePlan({ preset, caseCount });
      const tuples = new Set();
      const coverage = recipe.dimensions.map(() => new Set());
      for (const entry of plan.cases) {
        tuples.add(JSON.stringify(entry.guide.variation.map((item) => [item.key, item.value.zh])));
        entry.guide.variation.forEach((item, position) => coverage[position].add(item.value.zh));
      }
      // Every planned case is a unique tuple — not just a unique key/name.
      assert.equal(tuples.size, caseCount, `${preset}/${caseCount} must plan ${caseCount} unique variation tuples`);
      // Every dimension meaningfully varies across the plan.
      recipe.dimensions.forEach((dimension, position) => {
        assert.equal(
          coverage[position].size,
          dimension.values.length,
          `${preset}/${caseCount}: dimension ${dimension.key} must cover all ${dimension.values.length} values at ${caseCount} cases`,
        );
      });
    }
  }

  // 50 unique friendship tuples: the acceptance scenario really varies.
  const friendship = buildCasePlan({ preset: 'friendship', caseCount: 50 });
  const tuples = new Set(friendship.cases.map((entry) => JSON.stringify(entry.guide.variation.map((item) => item.value.zh))));
  assert.equal(tuples.size, 50);
});

test('objectives pick the semantic goal dimension and guidance is concrete', () => {
  // Teaching ends with an interaction style, so the objective must use the
  // teaching *goal* dimension (not the last declared one).
  const teaching = buildCasePlan({ preset: 'teaching', caseCount: 5, locale: 'zh-CN' });
  for (const entry of teaching.cases) {
    const goal = entry.guide.variation.find((item) => item.key === 'goal');
    const interaction = entry.guide.variation.find((item) => item.key === 'interaction');
    assert.ok(entry.objective.includes(goal.value.zh), 'objective phrases the teaching goal');
    assert.ok(!entry.objective.includes(interaction.value.zh) || interaction.value.zh === goal.value.zh);
  }
  const friendship = buildCasePlan({ preset: 'friendship', caseCount: 5, locale: 'zh-CN' });
  for (const entry of friendship.cases) {
    const outcome = entry.guide.variation.find((item) => item.key === 'outcome');
    assert.ok(entry.objective.includes(outcome.value.zh), 'objective phrases the expected outcome');
  }
  // Friendship guidance suggests 6–10 alternating messages and a concrete outcome.
  const guidanceText = JSON.stringify(scenarioPreset('friendship').guidance);
  assert.match(guidanceText, /6–10/);
  assert.match(guidanceText, /outcome|结果/);
  // English variants are fully translated (no CJK left in en text).
  const cjk = /[\u4e00-\u9fff]/;
  for (const preset of SCENARIO_PRESETS) {
    const recipe = scenarioPreset(preset);
    assert.ok(!cjk.test(recipe.name.en), `${preset} name.en must be translated`);
    for (const dimension of recipe.dimensions) {
      assert.ok(!cjk.test(dimension.name.en), `${preset}.${dimension.key} label.en must be translated`);
      for (const value of dimension.values) {
        assert.ok(!cjk.test(value.en), `${preset}.${dimension.key} value.en must be translated: ${value.en}`);
      }
    }
    for (const line of recipe.guidance) {
      assert.ok(!cjk.test(line.en), `${preset} guidance.en must be translated: ${line.en}`);
    }
  }
});

test('scenario plans carry meaningful generation guidance per case', () => {
  const db = automationDb();
  const svc = serviceFor(db);
  const project = svc.createProject({ userId: 'user-a', input: { name: '项目', defaults: { platform: 'whatsapp' } } }).item;
  const scenario = svc.createScenario({
    userId: 'user-a',
    projectId: project.id,
    input: { name: '结交新朋友', preset: 'friendship', caseCount: 8, platform: 'whatsapp' },
  });
  assert.ok(scenario.casePlan.guidance.length >= 1, 'preset-level guidance');
  const seen = new Set();
  for (const entry of scenario.casePlan.cases) {
    assert.ok(entry.variation.length >= 3, 'every planned case carries variation dimensions');
    assert.ok(entry.objective.length > 0 && entry.context.length > 0);
    seen.add(JSON.stringify(entry.variation.map((item) => item.value.zh)));
  }
  assert.equal(seen.size, 8, 'planned cases differ from each other');

  // The stored case rows are readable as planned metadata before submission.
  const detail = svc.getScenario({ userId: 'user-a', projectId: project.id, scenarioId: scenario.scenario.scenarioId });
  assert.equal(detail.cases.length, 8);
  assert.equal(detail.cases[0].itemKey, 'case-001');
  assert.equal(detail.cases[0].submitted, false);
  assert.equal(detail.cases[0].sceneId, null);
  assert.equal(detail.contentStatus, 'collecting');
  assert.equal(detail.counts.missing, 8);
});
