/** Template persistence shared by two explicitly separate storage domains.
 * Web passes the authenticated user ID; MCP passes its instance scope in its
 * own database. There is intentionally no implicit/default owner argument.
 */
import { randomUUID } from 'node:crypto';
import { validateTemplateDefinition } from '../../packages/schema/templates.ts';
export const MAX_TEMPLATES_PER_OWNER = 50;
export class TemplateError extends Error {
  constructor(status, code, message) { super(message); this.name = 'TemplateError'; this.status = status; this.code = code; }
}
export const TEMPLATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS template_records (
 owner_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
 description TEXT NOT NULL, mode TEXT NOT NULL, variable_count INTEGER NOT NULL,
 revision INTEGER NOT NULL, definition_json TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,id)
);
CREATE INDEX IF NOT EXISTS idx_templates_owner_updated ON template_records(owner_id,updated_at DESC,id);
`;
export function installTemplateSchema(db) { db.exec(TEMPLATE_SCHEMA_SQL); }
function owner(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new TemplateError(400, 'invalid_owner', 'An explicit storage owner is required.'); return value; }
export function validateTemplateId(value) { if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new TemplateError(404, 'not_found', 'Template not found.'); return value.toLowerCase(); }
function revision(value) { if (!Number.isSafeInteger(value) || value < 1) throw new TemplateError(400, 'invalid_revision', 'A positive template revision is required.'); return value; }
export function checkedDefinition(raw) { const result = validateTemplateDefinition(raw); if (!result.ok) throw new TemplateError(400, 'invalid_template', result.errors.slice(0, 3).join(' ')); return result.value; }
function summary(row) { return { id: row.id, name: row.name, description: row.description, mode: row.mode, variableCount: Number(row.variable_count), revision: Number(row.revision), createdAt: row.created_at, updatedAt: row.updated_at }; }
function detail(row) { return { ...summary(row), definition: JSON.parse(row.definition_json) }; }
function mode(definition) { return definition.scene.reference ? 'reference' : definition.scene.layout?.kind === 'custom' ? 'custom' : 'structured'; }
function transaction(db, work) { db.exec('BEGIN IMMEDIATE'); try { const result = work(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }
export function listTemplates(db, ownerId) { return db.prepare('SELECT id,name,description,mode,variable_count,revision,created_at,updated_at FROM template_records WHERE owner_id=? ORDER BY updated_at DESC,id').all(owner(ownerId)).map(summary); }
export function getTemplate(db, ownerId, templateId) { const row = db.prepare('SELECT * FROM template_records WHERE owner_id=? AND id=?').get(owner(ownerId), validateTemplateId(templateId)); if (!row) throw new TemplateError(404, 'not_found', 'Template not found.'); return detail(row); }
export function createTemplate(db, ownerId, raw, { id = randomUUID(), nowMs = Date.now() } = {}) {
  const scope = owner(ownerId), templateId = validateTemplateId(id), definition = checkedDefinition(raw), now = new Date(nowMs).toISOString();
  return transaction(db, () => {
    if (db.prepare('SELECT 1 FROM template_records WHERE owner_id=? AND id=?').get(scope, templateId)) throw new TemplateError(409, 'template_exists', 'This template already exists.');
    if (Number(db.prepare('SELECT COUNT(*) AS n FROM template_records WHERE owner_id=?').get(scope).n) >= MAX_TEMPLATES_PER_OWNER) throw new TemplateError(409, 'template_limit_reached', 'A workspace can contain at most 50 templates.');
    db.prepare('INSERT INTO template_records(owner_id,id,name,description,mode,variable_count,revision,definition_json,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?,?)').run(scope,templateId,definition.name,definition.description,mode(definition),definition.variables.length,JSON.stringify(definition),now,now);
    return getTemplate(db,scope,templateId);
  });
}
export function updateTemplate(db, ownerId, templateId, expectedRevision, raw, nowMs = Date.now()) {
  const scope = owner(ownerId), id = validateTemplateId(templateId), base = revision(expectedRevision), definition = checkedDefinition(raw), now = new Date(nowMs).toISOString();
  return transaction(db, () => {
    const current = getTemplate(db,scope,id);
    if (current.revision !== base) throw new TemplateError(409,'revision_conflict','This template changed elsewhere. Reload it before updating.');
    db.prepare('UPDATE template_records SET name=?,description=?,mode=?,variable_count=?,revision=revision+1,definition_json=?,updated_at=? WHERE owner_id=? AND id=? AND revision=?').run(definition.name,definition.description,mode(definition),definition.variables.length,JSON.stringify(definition),now,scope,id,base);
    return getTemplate(db,scope,id);
  });
}
export function deleteTemplate(db, ownerId, templateId, expectedRevision) {
  const scope = owner(ownerId), id = validateTemplateId(templateId), base = revision(expectedRevision);
  return transaction(db, () => {
    const current = getTemplate(db,scope,id);
    if (current.revision !== base) throw new TemplateError(409,'revision_conflict','This template changed elsewhere. Reload it before deleting.');
    db.prepare('DELETE FROM template_records WHERE owner_id=? AND id=? AND revision=?').run(scope,id,base);
    return { id, deleted: true };
  });
}
