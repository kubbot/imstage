/** Reusable scene snapshots and typed replacements shared by Web, API and MCP. */
import { validateScene, cloneScene, type Scene } from '../../apps/web/src/studio/model.ts';

export const TEMPLATE_LIMITS = Object.freeze({ name: 80, description: 500, variables: 50, key: 48, label: 80, imageChars: 2 * 1024 * 1024, snapshotChars: 16 * 1024 * 1024 });
export type TemplateTarget =
  | { entity: 'participant'; id: string; field: 'name' | 'avatar' }
  | { entity: 'message'; id: string; field: 'text' | 'asset' }
  | { entity: 'scene'; field: 'title' | 'deviceTime' }
  | { entity: 'reference'; id: string; field: 'text' | 'image' };
export interface TemplateVariable { key: string; label: string; type: 'text' | 'image'; target: TemplateTarget; }
export interface TemplateDefinition { schemaVersion: 1; name: string; description: string; scene: Scene; variables: TemplateVariable[]; }
export type TemplateResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
const text = (value: unknown, max: number, empty = false): value is string => typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
const image = (value: unknown): value is string => typeof value === 'string' && value.length <= TEMPLATE_LIMITS.imageChars && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(value);
function exact(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).every(key => keys.includes(key) && !FORBIDDEN.has(key)); }

function validateTarget(raw: unknown, scene: Scene): TemplateTarget | null {
  if (!record(raw) || !exact(raw, ['entity', 'id', 'field'])) return null;
  if (raw.entity === 'scene') return raw.id === undefined && (raw.field === 'title' || raw.field === 'deviceTime') ? { entity: 'scene', field: raw.field } : null;
  if (!text(raw.id, 128)) return null;
  if (raw.entity === 'participant' && (raw.field === 'name' || raw.field === 'avatar') && scene.participants.some(person => person.id === raw.id)) return { entity: 'participant', id: raw.id, field: raw.field };
  if (raw.entity === 'message' && (raw.field === 'text' || raw.field === 'asset')) {
    const message = scene.messages.find(item => item.id === raw.id);
    if (message && (raw.field === 'text' || message.type === 'image' || message.type === 'video')) return { entity: 'message', id: raw.id, field: raw.field };
  }
  if (raw.entity === 'reference' && (raw.field === 'text' || raw.field === 'image')) {
    const edit = scene.reference?.plan.edits.find(item => item.id === raw.id);
    if (edit && edit.kind === raw.field) return { entity: 'reference', id: raw.id, field: raw.field };
  }
  return null;
}
function targetType(target: TemplateTarget): 'text' | 'image' { return ['avatar', 'asset', 'image'].includes(target.field) ? 'image' : 'text'; }
function targetKey(target: TemplateTarget): string { return JSON.stringify([target.entity, 'id' in target ? target.id : '', target.field]); }

/** Metadata and scene are reconstructed, never trusted by reference. */
export function validateTemplateDefinition(raw: unknown): TemplateResult<TemplateDefinition> {
  if (!record(raw) || !exact(raw, ['schemaVersion', 'name', 'description', 'scene', 'variables'])) return { ok: false, errors: ['Invalid template fields.'] };
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) return { ok: false, errors: ['Unsupported template schema.'] };
  if (!text(raw.name, TEMPLATE_LIMITS.name)) return { ok: false, errors: ['Template name must contain 1–80 characters.'] };
  if (raw.description !== undefined && !text(raw.description, TEMPLATE_LIMITS.description, true)) return { ok: false, errors: ['Invalid template description.'] };
  try { if (JSON.stringify(raw).length > TEMPLATE_LIMITS.snapshotChars) return { ok: false, errors: ['Template snapshot is too large.'] }; }
  catch { return { ok: false, errors: ['Template must be serializable.'] }; }
  const validated = validateScene(raw.scene);
  if (!validated.ok || !validated.scene) return { ok: false, errors: validated.errors };
  const scene = validated.scene;
  if (!Array.isArray(raw.variables) || raw.variables.length > TEMPLATE_LIMITS.variables) return { ok: false, errors: ['A template may have at most 50 variables.'] };
  const keys = new Set<string>(), targets = new Set<string>();
  const variables: TemplateVariable[] = [];
  for (const item of raw.variables) {
    if (!record(item) || !exact(item, ['key', 'label', 'type', 'target']) || typeof item.key !== 'string' || !/^[a-z][a-z0-9_]{0,47}$/.test(item.key) || FORBIDDEN.has(item.key) || keys.has(item.key)) return { ok: false, errors: ['Variable keys must be unique, lowercase identifiers.'] };
    const target = validateTarget(item.target, scene);
    if (!target || item.type !== targetType(target) || !text(item.label, TEMPLATE_LIMITS.label) || targets.has(targetKey(target))) return { ok: false, errors: [`Invalid or duplicate target for ${item.key}.`] };
    keys.add(item.key); targets.add(targetKey(target));
    variables.push({ key: item.key, label: item.label.trim(), type: item.type, target });
  }
  return { ok: true, value: { schemaVersion: 1, name: raw.name.trim(), description: typeof raw.description === 'string' ? raw.description : '', scene: cloneScene(scene), variables } };
}

export function variableValue(scene: Scene, variable: TemplateVariable): string {
  const target = variable.target;
  if (target.entity === 'scene') return scene[target.field];
  if (target.entity === 'participant') return scene.participants.find(person => person.id === target.id)?.[target.field] ?? '';
  if (target.entity === 'message') return scene.messages.find(message => message.id === target.id)?.[target.field] ?? '';
  const edit = scene.reference?.plan.edits.find(item => item.id === target.id);
  return target.field === 'text' ? edit?.text ?? '' : scene.reference?.assets.find(asset => asset.id === edit?.assetId)?.dataUrl ?? '';
}

/** Inputs only address explicitly declared targets; the source never mutates. */
export function instantiateTemplate(raw: unknown, values: unknown, newSceneId: string): TemplateResult<Scene> {
  const checked = validateTemplateDefinition(raw);
  if (!checked.ok) return checked;
  if (!text(newSceneId, 64) || !/^[A-Za-z0-9_-]+$/.test(newSceneId)) return { ok: false, errors: ['A fresh scene ID is required.'] };
  if (!record(values)) return { ok: false, errors: ['Variable values must be an object.'] };
  const template = checked.value;
  if (newSceneId === template.scene.id) return { ok: false, errors: ['An instance must have its own scene ID.'] };
  const byKey = new Map(template.variables.map(variable => [variable.key, variable]));
  const scene = cloneScene(template.scene); scene.id = newSceneId;
  for (const [key, value] of Object.entries(values)) {
    const variable = byKey.get(key);
    if (!variable || FORBIDDEN.has(key)) return { ok: false, errors: [`Unknown variable: ${key}.`] };
    const target = variable.target;
    const max = target.entity === 'participant' ? 100 : target.entity === 'scene' ? (target.field === 'title' ? 120 : 40) : 4000;
    if (variable.type === 'image' ? !image(value) : !text(value, max, target.entity !== 'participant')) return { ok: false, errors: [`Invalid value for ${key}.`] };
    // The checks above narrow the runtime value; casts are limited to these
    // whitelisted field assignments and never used as arbitrary object paths.
    const replacement = value as string;
    if (target.entity === 'scene') scene[target.field] = replacement;
    else if (target.entity === 'participant') scene.participants.find(person => person.id === target.id)![target.field] = replacement;
    else if (target.entity === 'message') scene.messages.find(message => message.id === target.id)![target.field] = replacement;
    else {
      const reference = scene.reference!;
      const edit = reference.plan.edits.find(item => item.id === target.id)!;
      if (target.field === 'text') edit.text = replacement;
      else {
        const existing = reference.assets.find(asset => asset.id === edit.assetId);
        if (existing && reference.plan.edits.filter(item => item.assetId === edit.assetId).length === 1) { existing.dataUrl = replacement; continue; }
        // One edit gets its own asset slot; shared source assets remain intact.
        let assetId = `template-${key}`;
        let suffix = 0;
        while (reference.assets.some(asset => asset.id === assetId)) assetId = `template-${key}-${++suffix}`;
        reference.assets.push({ id: assetId, dataUrl: replacement, description: variable.label });
        edit.assetId = assetId;
      }
    }
  }
  const result = validateScene(scene);
  return result.ok && result.scene ? { ok: true, value: result.scene } : { ok: false, errors: result.errors };
}

/** A useful default variable list; the creator can select and relabel it. */
export function discoverTemplateVariables(scene: Scene): TemplateVariable[] {
  const variables: TemplateVariable[] = [];
  const add = (type: 'text' | 'image', label: string, target: TemplateTarget) => {
    if (variables.length < TEMPLATE_LIMITS.variables) variables.push({ key: `field_${variables.length + 1}`, label: label.slice(0, TEMPLATE_LIMITS.label) || 'Field', type, target });
  };
  if (scene.reference) {
    for (const [index, edit] of scene.reference.plan.edits.entries()) add(edit.kind === 'image' ? 'image' : 'text', `Region ${index + 1}`, { entity: 'reference', id: edit.id, field: edit.kind });
  } else {
    for (const person of scene.participants) { add('text', person.name, { entity: 'participant', id: person.id, field: 'name' }); add('image', `${person.name} · avatar`, { entity: 'participant', id: person.id, field: 'avatar' }); }
    for (const [index, message] of scene.messages.entries()) {
      if (message.type === 'text') add('text', message.text.slice(0, 60) || `Message ${index + 1}`, { entity: 'message', id: message.id, field: 'text' });
      if (message.type === 'image') add('image', `Photo ${index + 1}`, { entity: 'message', id: message.id, field: 'asset' });
    }
  }
  return variables;
}
