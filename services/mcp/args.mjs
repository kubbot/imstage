// Strict tool-argument validation for the MCP server.
//
// MCP tool arguments arrive as untrusted JSON. The SDK forwards them verbatim,
// so every field is checked here before it reaches the scene contract, the
// store or the renderer. Unknown fields are rejected instead of ignored.

import { invalidRequest } from './errors.mjs';
import { SCENE_LIMITS } from './limits.mjs';

export function asObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalidRequest(`${label} 必须是 JSON 对象`, { field: label });
  }
  return value;
}

export function rejectUnknownKeys(object, allowed, label) {
  for (const key of Object.keys(object)) {
    if (allowed.has(key)) continue;
    invalidRequest(`${label} 含未知字段：${key}`, { field: `${label}.${key}`, allowed: [...allowed] }, `删除未知字段 ${key}；允许的字段：${[...allowed].join(', ')}。`);
  }
}

export function stringField(object, key, { required = false, min = 1, max = SCENE_LIMITS.idMax, allowed } = {}) {
  const value = object[key];
  if (value === undefined || value === null) {
    if (required) invalidRequest(`${key} 不能为空`, { field: key }, `补全 ${key} 后重试。`);
    return undefined;
  }
  if (typeof value !== 'string') invalidRequest(`${key} 必须是字符串`, { field: key });
  if (value.length < min) invalidRequest(`${key} 至少 ${min} 个字符`, { field: key });
  if (value.length > max) invalidRequest(`${key} 最多 ${max} 个字符`, { field: key, max });
  if (allowed && !allowed.includes(value)) {
    invalidRequest(`${key} 只能是：${allowed.join(', ')}`, { field: key, value, allowed: [...allowed] });
  }
  return value;
}

export function integerField(object, key, { required = false, min, max } = {}) {
  const value = object[key];
  if (value === undefined || value === null) {
    if (required) invalidRequest(`${key} 不能为空`, { field: key }, `补全 ${key} 后重试。`);
    return undefined;
  }
  if (!Number.isInteger(value)) invalidRequest(`${key} 必须是整数`, { field: key, value });
  if (Number.isInteger(min) && value < min) invalidRequest(`${key} 不能小于 ${min}`, { field: key, value, min });
  if (Number.isInteger(max) && value > max) invalidRequest(`${key} 不能大于 ${max}`, { field: key, value, max });
  return value;
}

export function objectField(object, key, { required = false } = {}) {
  const value = object[key];
  if (value === undefined || value === null) {
    if (required) invalidRequest(`${key} 不能为空`, { field: key }, `补全 ${key} 后重试。`);
    return undefined;
  }
  return asObject(value, key);
}

export function optionalIdempotencyKey(object) {
  const value = object.idempotencyKey;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') invalidRequest('idempotencyKey 必须是字符串', { field: 'idempotencyKey' });
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > SCENE_LIMITS.idempotencyKeyMax) {
    invalidRequest(`idempotencyKey 必须是 1-${SCENE_LIMITS.idempotencyKeyMax} 个字符`, { field: 'idempotencyKey' });
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    invalidRequest('idempotencyKey 不能包含控制字符', { field: 'idempotencyKey' });
  }
  return trimmed;
}
