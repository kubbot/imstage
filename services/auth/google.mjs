import crypto from 'node:crypto';

export const GOOGLE_ONLY_PASSWORD_HASH = '!google-only';
const TTL = 600_000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const random = () => crypto.randomBytes(32).toString('base64url');
const messages = {
  google_not_configured: [503, 'Google 登录尚未配置'],
  google_storage_unavailable: [400, '浏览器安全存储不可用，请使用邮箱密码登录'],
  google_flow_expired: [400, 'Google 登录已过期，请重试'],
  google_invalid_identity: [401, '无法确认 Google 身份，请重试'],
  google_unavailable: [503, 'Google 身份验证暂不可用，请稍后重试'],
  google_already_linked: [409, 'Google 账号已关联，请勿覆盖现有登录方式'],
  google_last_signin_method: [409, '请保留至少一种登录方式'],
  google_busy: [429, '暂时无法开始登录，请稍后重试'],
  auth_operation_superseded: [409, '另一项登录操作已完成，请重试'],
  invalid_request: [400, '登录请求无效'],
};

export class GoogleAuthError extends Error {
  constructor(code) {
    super((messages[code] ?? messages.invalid_request)[1]);
    this.name = 'GoogleAuthError';
    this.code = code;
    this.status = (messages[code] ?? messages.invalid_request)[0];
  }
}
const fail = code => { throw new GoogleAuthError(code); };

// Savepoints remain atomic when an HTTP handler already owns the outer account
// transaction. No async work is allowed inside these storage operations.
function transaction(db, work) {
  const name = 'google_' + crypto.randomUUID().replaceAll('-', '');
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = work();
    db.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    db.exec(`RELEASE SAVEPOINT ${name}`);
    throw error;
  }
}

let library;
const clients = new Map();
export async function googleVerificationClient(clientId) {
  if (!clients.has(clientId)) {
    library ??= import('google-auth-library');
    const { OAuth2Client } = await library;
    clients.set(clientId, new OAuth2Client({ clientId, transporterOptions: { timeout: 8000, retryConfig: { retry: 0 } } }));
  }
  return clients.get(clientId);
}

export async function verifyGoogleIdToken(credential, clientId, { client } = {}) {
  try {
    const verifier = client ?? await googleVerificationClient(clientId);
    const ticket = await verifier.verifyIdToken({ idToken: credential, audience: clientId });
    return ticket.getPayload();
  } catch (error) {
    // Google library errors can contain the input JWT. Never expose or retain
    // their message/cause in an HTTP error or application log.
    const unavailable = ['ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED'].includes(error?.code)
      || Number(error?.response?.status) >= 500;
    throw new GoogleAuthError(unavailable ? 'google_unavailable' : 'google_invalid_identity');
  }
}

function initialize(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map(row => row.name));
  for (const column of ['auth_context_hash', 'auth_flow_id']) {
    if (!columns.has(column)) db.exec(`ALTER TABLE sessions ADD COLUMN ${column} TEXT`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_auth_context ON sessions(auth_context_hash);
    CREATE TABLE IF NOT EXISTS google_identities (
      subject TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_browser_contexts (
      hash TEXT PRIMARY KEY,
      generation TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      current_flow_id TEXT,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS google_auth_flows (
      id TEXT PRIMARY KEY,
      browser_hash TEXT NOT NULL REFERENCES auth_browser_contexts(hash) ON DELETE CASCADE,
      epoch INTEGER NOT NULL,
      cookie_hash TEXT NOT NULL,
      nonce_hash TEXT NOT NULL,
      intent TEXT NOT NULL CHECK(intent IN ('signin','link')),
      user_id TEXT,
      session_id TEXT,
      stage TEXT NOT NULL CHECK(stage IN ('pending','verifying','registration')),
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      subject TEXT,
      email TEXT,
      name TEXT,
      email_authoritative INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_google_flows_expiry ON google_auth_flows(expires_at_ms);
    CREATE INDEX IF NOT EXISTS idx_google_flows_browser ON google_auth_flows(browser_hash);
  `);
  // Existing ten-minute flows have no proof of hosted-domain authority.
  const flowColumns = db.prepare('PRAGMA table_info(google_auth_flows)').all();
  if (!flowColumns.some(column => column.name === 'email_authoritative')) {
    db.exec('ALTER TABLE google_auth_flows ADD COLUMN email_authoritative INTEGER NOT NULL DEFAULT 0');
  }
}

export function createGoogleAuth(db, { clientId = '', nowMs = Date.now, verifyToken = verifyGoogleIdToken } = {}) {
  initialize(db);
  const configuredId = typeof clientId === 'string' ? clientId.trim() : '';
  const enabled = /^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(configuredId);
  const contextHash = key => {
    if (!TOKEN.test(key ?? '')) fail('invalid_request');
    return hash(key);
  };
  const snapshotOf = row => ({ hash: row.hash, generation: row.generation, epoch: Number(row.epoch) });

  function prune() {
    const now = nowMs();
    db.prepare('DELETE FROM google_auth_flows WHERE expires_at_ms <= ?').run(now);
    db.prepare(`DELETE FROM auth_browser_contexts WHERE updated_at_ms < ?
      AND NOT EXISTS (SELECT 1 FROM google_auth_flows f WHERE f.browser_hash=auth_browser_contexts.hash)
      AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.auth_context_hash=auth_browser_contexts.hash AND s.expires_at_ms>?)`).run(now - TTL, now);
  }

  function captureBrowser(key) {
    if (key === null || key === undefined || key === '') return null;
    const h = contextHash(key);
    return transaction(db, () => {
      let row = db.prepare('SELECT * FROM auth_browser_contexts WHERE hash=?').get(h);
      if (!row) {
        prune();
        if (db.prepare('SELECT count(*) AS n FROM auth_browser_contexts').get().n >= 10000) fail('google_busy');
        db.prepare('INSERT INTO auth_browser_contexts(hash,generation,epoch,updated_at_ms) VALUES (?,?,0,?)').run(h, crypto.randomUUID(), nowMs());
        row = db.prepare('SELECT * FROM auth_browser_contexts WHERE hash=?').get(h);
      }
      db.prepare('UPDATE auth_browser_contexts SET updated_at_ms=? WHERE hash=?').run(nowMs(), h);
      return snapshotOf(row);
    });
  }

  function assertSnapshot(snapshot, force = false) {
    if (!snapshot) fail('google_storage_unavailable');
    const row = db.prepare('SELECT * FROM auth_browser_contexts WHERE hash=?').get(snapshot.hash);
    if (!row || (!force && (Number(row.epoch) !== snapshot.epoch || row.generation !== snapshot.generation))) fail('auth_operation_superseded');
    return row;
  }

  function advanceBrowser(snapshot, { keepSessionId = null, force = false } = {}) {
    if (!snapshot) return null;
    return transaction(db, () => {
      const row = assertSnapshot(snapshot, force);
      if (keepSessionId) {
        db.prepare('DELETE FROM sessions WHERE auth_context_hash=? AND id<>?').run(snapshot.hash, keepSessionId);
        db.prepare('UPDATE sessions SET auth_context_hash=? WHERE id=?').run(snapshot.hash, keepSessionId);
      } else db.prepare('DELETE FROM sessions WHERE auth_context_hash=?').run(snapshot.hash);
      db.prepare('DELETE FROM google_auth_flows WHERE browser_hash=?').run(snapshot.hash);
      const epoch = Number(row.epoch) + 1;
      db.prepare('UPDATE auth_browser_contexts SET epoch=?,current_flow_id=NULL,updated_at_ms=? WHERE hash=?').run(epoch, nowMs(), snapshot.hash);
      return { hash: snapshot.hash, generation: row.generation, epoch };
    });
  }

  function issue(snapshot, binding, intent = 'signin') {
    if (!enabled) fail('google_not_configured');
    if (!snapshot) fail('google_storage_unavailable');
    if (!['signin', 'link'].includes(intent)) fail('invalid_request');
    if (intent === 'signin' && (binding?.userId || binding?.sessionId)) fail('invalid_request');
    if (intent === 'link' && (!binding?.userId || !binding?.sessionId)) fail('invalid_request');
    return transaction(db, () => {
      prune();
      const next = advanceBrowser(snapshot, { keepSessionId: intent === 'link' ? binding.sessionId : null });
      if (db.prepare('SELECT count(*) AS n FROM google_auth_flows').get().n >= 4096) fail('google_busy');
      const id = crypto.randomUUID(), cookieToken = random(), nonce = random();
      const expiresAtMs = nowMs() + TTL;
      db.prepare(`INSERT INTO google_auth_flows
        (id,browser_hash,epoch,cookie_hash,nonce_hash,intent,user_id,session_id,stage,created_at_ms,expires_at_ms)
        VALUES (?,?,?,?,?,?,?,?,'pending',?,?)`).run(id, next.hash, next.epoch, hash(cookieToken), hash(nonce), intent, binding?.userId ?? null, binding?.sessionId ?? null, nowMs(), expiresAtMs);
      db.prepare('UPDATE auth_browser_contexts SET current_flow_id=? WHERE hash=?').run(id, next.hash);
      return { id, cookieToken, nonce, expiresAtMs };
    });
  }

  function flow(snapshot, id, binding, stage) {
    const current = assertSnapshot(snapshot);
    const row = ID.test(id ?? '') ? db.prepare('SELECT * FROM google_auth_flows WHERE id=?').get(id) : null;
    if (!row || current.current_flow_id !== id || row.browser_hash !== snapshot.hash || Number(row.epoch) !== snapshot.epoch
      || Number(row.expires_at_ms) <= nowMs() || row.stage !== stage
      || row.user_id !== (binding?.userId ?? null) || row.session_id !== (binding?.sessionId ?? null)) fail('google_flow_expired');
    return { ...row, nonceHash: row.nonce_hash };
  }

  function cookieMatches(row, token) {
    return TOKEN.test(token ?? '') && crypto.timingSafeEqual(Buffer.from(row.cookie_hash, 'hex'), Buffer.from(hash(token), 'hex'));
  }

  function claim(snapshot, id, cookieToken, binding) {
    return transaction(db, () => {
      const row = flow(snapshot, id, binding, 'pending');
      if (!cookieMatches(row, cookieToken)) fail('google_flow_expired');
      db.prepare("UPDATE google_auth_flows SET stage='verifying' WHERE id=?").run(id);
      return { ...row, stage: 'verifying' };
    });
  }

  async function verifyCredential(credential, claimed) {
    if (typeof credential !== 'string' || !credential || credential.length > 16384) fail('google_invalid_identity');
    let payload;
    try { payload = await verifyToken(credential, configuredId); }
    catch (error) {
      if (error instanceof GoogleAuthError) throw error;
      fail('google_invalid_identity');
    }
    const now = nowMs() / 1000;
    if (!payload || !['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)
      || payload.aud !== configuredId || !Number.isFinite(payload.exp) || payload.exp <= now || payload.exp > now + 7200
      || !Number.isFinite(payload.iat) || payload.iat > now + 300
      || ![true, 'true'].includes(payload.email_verified)
      || typeof payload.sub !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(payload.sub)
      || typeof payload.email !== 'string' || payload.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)
      || typeof payload.nonce !== 'string' || hash(payload.nonce) !== claimed.nonceHash) fail('google_invalid_identity');
    const email = payload.email.trim().toLowerCase();
    const name = (typeof payload.name === 'string' ? payload.name : email.split('@')[0]).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) || 'Google user';
    // A verified third-party address can outlive its original owner. Google is
    // authoritative for Gmail and for a matching, signed Workspace hd claim.
    // https://developers.google.com/identity/gsi/web/guides/verify-google-id-token
    const emailAuthoritative = email.endsWith('@gmail.com')
      || (typeof payload.hd === 'string' && payload.hd.toLowerCase() === email.split('@')[1]);
    return { sub: payload.sub, email, name, emailAuthoritative };
  }

  const recheck = (snapshot, id, binding, stage = 'verifying') => flow(snapshot, id, binding, stage);

  function markRegistration(snapshot, id, binding, profile) {
    return transaction(db, () => {
      flow(snapshot, id, binding, 'verifying');
      db.prepare("UPDATE google_auth_flows SET stage='registration',subject=?,email=?,name=?,email_authoritative=? WHERE id=?")
        .run(profile.sub, profile.email, profile.name, profile.emailAuthoritative === true ? 1 : 0, id);
    });
  }

  function pending(snapshot, id, token, binding) {
    try {
      const row = flow(snapshot, id, binding, 'registration');
      return cookieMatches(row, token) ? { sub: row.subject, email: row.email, name: row.name, emailAuthoritative: row.email_authoritative === 1 } : null;
    } catch (error) {
      if (error instanceof GoogleAuthError) return null;
      throw error;
    }
  }

  function identity(subject) {
    const row = db.prepare('SELECT user_id,email FROM google_identities WHERE subject=?').get(subject);
    return row ? { userId: row.user_id, email: row.email } : null;
  }

  function link(userId, profile) {
    return transaction(db, () => {
      const subjectOwner = identity(profile.sub);
      const userIdentity = db.prepare('SELECT subject FROM google_identities WHERE user_id=?').get(userId);
      if ((subjectOwner && subjectOwner.userId !== userId) || (userIdentity && userIdentity.subject !== profile.sub)) fail('google_already_linked');
      if (subjectOwner) db.prepare('UPDATE google_identities SET email=? WHERE subject=?').run(profile.email, profile.sub);
      else db.prepare('INSERT INTO google_identities(subject,user_id,email,created_at_ms) VALUES (?,?,?,?)').run(profile.sub, userId, profile.email, nowMs());
    });
  }

  function methods(userId) {
    const user = db.prepare('SELECT password_hash FROM users WHERE id=?').get(userId);
    const linked = db.prepare('SELECT email FROM google_identities WHERE user_id=?').get(userId);
    return { password: !!user && user.password_hash !== GOOGLE_ONLY_PASSWORD_HASH, google: { configured: enabled, linked: !!linked, email: linked?.email ?? null } };
  }

  function unlink(userId) {
    if (!methods(userId).password) fail('google_last_signin_method');
    db.prepare('DELETE FROM google_identities WHERE user_id=?').run(userId);
  }

  function cancel(snapshot, id) {
    if (!snapshot || !ID.test(id ?? '')) return;
    transaction(db, () => {
      // Session ownership survives flow cleanup, including a response that has
      // committed but whose authentication cookie has not reached the browser.
      db.prepare('DELETE FROM sessions WHERE auth_context_hash=? AND auth_flow_id=?').run(snapshot.hash, id);
      db.prepare('DELETE FROM google_auth_flows WHERE browser_hash=? AND id=?').run(snapshot.hash, id);
      db.prepare('UPDATE auth_browser_contexts SET epoch=epoch+1,current_flow_id=NULL,updated_at_ms=? WHERE hash=? AND current_flow_id=?').run(nowMs(), snapshot.hash, id);
    });
  }

  function peekHash(h) {
    const row = db.prepare('SELECT * FROM auth_browser_contexts WHERE hash=?').get(h ?? '');
    return row ? snapshotOf(row) : null;
  }
  const peekBrowser = key => TOKEN.test(key ?? '') ? peekHash(hash(key)) : null;
  function peekFlow(id, token) {
    const row = ID.test(id ?? '') ? db.prepare('SELECT * FROM google_auth_flows WHERE id=?').get(id) : null;
    return row && cookieMatches(row, token) ? peekHash(row.browser_hash) : null;
  }
  function pendingForBrowser(snapshot, cookies, binding) {
    if (!snapshot) return null;
    const row = db.prepare('SELECT current_flow_id FROM auth_browser_contexts WHERE hash=?').get(snapshot.hash);
    const id = row?.current_flow_id;
    const profile = pending(snapshot, id, cookies(id), binding);
    return profile ? { flowId: id, profile: { email: profile.email, name: profile.name } } : null;
  }
  return { enabled, clientId: enabled ? configuredId : null, prune, captureBrowser, peekBrowser, peekHash, peekFlow, pendingForBrowser, advanceBrowser, issue, claim, recheck, verifyCredential, markRegistration, pending, identity, link, methods, unlink, cancel };
}
