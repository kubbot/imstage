// MCP model input policy only. Canonical scenes and trusted Web/application
// services still support a user's persisted watermarkEnabled=false setting.
import { invalidRequest } from './errors.mjs';
import { isPlainObject } from './util.mjs';

/** Model requests may read the flag, but cannot supply either boolean value. */
export function assertModelWatermarkOmitted(value, label = 'scene') {
  if (isPlainObject(value) && Object.hasOwn(value, 'watermarkEnabled')) {
    invalidRequest(
      `${label}.watermarkEnabled 是用户设置，模型工具不能修改`,
      { field: `${label}.watermarkEnabled` },
      '从模型输入中省略 watermarkEnabled；已有作品使用 sceneId、模板使用 templateId 复用。请在网页中修改水印开关。',
    );
  }
}

export function assertModelPatchWatermarkOmitted(patch, label = 'patch') {
  if (isPlainObject(patch)) assertModelWatermarkOmitted(patch.set, `${label}.set`);
}

/** Check raw envelopes before any trusted defaults/template expansion. */
export function assertModelBatchWatermarkOmitted(items) {
  if (!Array.isArray(items)) return; // The owning handler validates its shape.
  items.forEach((item, index) => {
    if (!isPlainObject(item)) return;
    assertModelWatermarkOmitted(item.scene, `items[${index}].scene`);
    assertModelPatchWatermarkOmitted(item.patch, `items[${index}].patch`);
  });
}

/** Preserve exactly the server-read flag, including legacy absence (= on). */
export function preserveStoredWatermark(candidate, stored) {
  if (!isPlainObject(candidate)) return candidate;
  const next = { ...candidate };
  if (isPlainObject(stored) && Object.hasOwn(stored, 'watermarkEnabled')) {
    next.watermarkEnabled = stored.watermarkEnabled;
  } else {
    delete next.watermarkEnabled;
  }
  return next;
}
