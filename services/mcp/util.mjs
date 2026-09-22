import crypto from 'node:crypto';

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function sha256Hex(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Deterministic JSON used for idempotency/request hashing and render ids.
 * Object keys are sorted recursively; `undefined` values are dropped.
 */
export function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    // A null-prototype map preserves every own key, including '__proto__'.
    // Assigning '__proto__' onto a normal {} would be dropped/interpreted as a
    // prototype setter, letting two different payloads hash identically.
    const out = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child === undefined) continue;
      out[key] = sortValue(child);
    }
    return out;
  }
  return value;
}

export function newSceneId() {
  return `scn_${crypto.randomBytes(16).toString('hex')}`;
}

export function newEphemeralSceneId() {
  return `eph_${crypto.randomBytes(16).toString('hex')}`;
}

export function newSessionId() {
  return crypto.randomUUID();
}

export function nowIso() {
  return new Date().toISOString();
}

/** Constant-time-ish compare for bearer tokens of any length. */
export function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
