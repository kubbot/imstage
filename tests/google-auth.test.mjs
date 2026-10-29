import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const module = await import('../services/auth/google.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return null;
  throw error;
});
const CLIENT = '1234567890-synthetic.apps.googleusercontent.com';
const contextKey = () => crypto.randomBytes(32).toString('base64url');
const binding = { userId: null, sessionId: null };
const rejected = (code) => error => error?.code === code;

function fixture(t, overrides = {}) {
  assert.ok(module, 'Google authentication service has not been implemented');
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT UNIQUE,name TEXT,password_hash TEXT NOT NULL,created_at TEXT);
    CREATE TABLE sessions(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),token_hash TEXT UNIQUE,created_at TEXT,expires_at_ms INTEGER);
    INSERT INTO users VALUES ('u1','existing@example.test','Existing','existing-password-hash','2026-01-01');
    INSERT INTO users VALUES ('u2','other@example.test','Other','existing-password-hash','2026-01-01');`);
  let now = Date.now();
  let claims;
  const auth = module.createGoogleAuth(db, {
    clientId: CLIENT,
    nowMs: () => now,
    verifyToken: async credential => {
      if (credential !== 'synthetic-google-id-token') throw new Error('invalid fixture credential');
      return claims;
    },
    ...overrides,
  });
  function issue(key = contextKey(), currentBinding = binding, intent = 'signin') {
    const flow = auth.issue(auth.captureBrowser(key), currentBinding, intent);
    return { key, flow, snapshot: auth.captureBrowser(key) };
  }
  function identity(nonce, patch = {}) {
    return { iss: 'https://accounts.google.com', aud: CLIENT, sub: 'google-sub-1', email: 'google@example.test', email_verified: true, name: 'Google User', nonce, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 3600, ...patch };
  }
  return { db, auth, issue, identity, setClaims: value => { claims = value; }, advanceTime: ms => { now += ms; } };
}

test('an unconfigured provider cannot issue a login flow', t => {
  const { auth } = fixture(t, { clientId: '' });
  assert.equal(auth.enabled, false);
  assert.throws(() => auth.issue(auth.captureBrowser(contextKey()), binding), rejected('google_not_configured'));
});

test('schema initialization preserves legacy users and sessions', t => {
  const { db } = fixture(t);
  assert.deepEqual({ ...db.prepare('SELECT id,email,name,password_hash,created_at FROM users WHERE id=?').get('u1') }, {
    id: 'u1', email: 'existing@example.test', name: 'Existing', password_hash: 'existing-password-hash', created_at: '2026-01-01',
  });
  db.prepare('INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at_ms) VALUES (?,?,?,?,?)').run('legacy', 'u1', 'old-token-hash', '2026-01-01', Date.now() + 10000);
  assert.equal(db.prepare('SELECT user_id FROM sessions WHERE id=?').get('legacy').user_id, 'u1');
});

test('a nonce flow is cookie bound and can be claimed only once', t => {
  const { auth } = fixture(t);
  const { snapshot, flow } = fixtureIssue(auth);
  assert.throws(() => auth.claim(snapshot, flow.id, contextKey(), binding), rejected('google_flow_expired'));
  assert.equal(auth.claim(snapshot, flow.id, flow.cookieToken, binding).intent, 'signin');
  assert.throws(() => auth.claim(snapshot, flow.id, flow.cookieToken, binding), rejected('google_flow_expired'));
});

function fixtureIssue(auth, key = contextKey()) {
  const flow = auth.issue(auth.captureBrowser(key), binding, 'signin');
  return { flow, key, snapshot: auth.captureBrowser(key) };
}

test('concurrent first challenges cannot leave two valid browser flows', t => {
  const { auth } = fixture(t);
  const key = contextKey();
  const first = auth.captureBrowser(key), second = auth.captureBrowser(key);
  const winner = auth.issue(first, binding, 'signin');
  assert.throws(() => auth.issue(second, binding, 'signin'), rejected('auth_operation_superseded'));
  assert.equal(auth.claim(auth.captureBrowser(key), winner.id, winner.cookieToken, binding).id, winner.id);
});

test('a challenge captured before logout cannot resurrect a flow after logout', t => {
  const { auth } = fixture(t);
  const key = contextKey();
  const delayed = auth.captureBrowser(key);
  auth.advanceBrowser(auth.captureBrowser(key), { force: true });
  assert.throws(() => auth.issue(delayed, binding, 'signin'), rejected('auth_operation_superseded'));
});

test('verification finishing after an authentication change cannot commit', async t => {
  const { auth, setClaims, identity } = fixture(t);
  const { flow, key, snapshot } = fixtureIssue(auth);
  const claimed = auth.claim(snapshot, flow.id, flow.cookieToken, binding);
  setClaims(identity(flow.nonce));
  assert.equal((await auth.verifyCredential('synthetic-google-id-token', claimed)).sub, 'google-sub-1');
  auth.advanceBrowser(auth.captureBrowser(key));
  assert.throws(() => auth.recheck(snapshot, flow.id, binding), rejected('auth_operation_superseded'));
});

test('browser epoch advancement revokes both password and Google sessions but leaves other browsers', t => {
  const { auth, db } = fixture(t);
  const snapshot = auth.captureBrowser(contextKey());
  const insert = db.prepare('INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at_ms,auth_context_hash,auth_flow_id) VALUES (?,?,?,?,?,?,?)');
  insert.run('password-session', 'u1', 'pw-token', '2026-01-01', Date.now() + 100000, snapshot.hash, null);
  insert.run('google-session', 'u1', 'g-token', '2026-01-01', Date.now() + 100000, snapshot.hash, 'old-flow');
  insert.run('other-browser', 'u1', 'other-token', '2026-01-01', Date.now() + 100000, 'other-context', null);
  auth.advanceBrowser(snapshot);
  assert.deepEqual(db.prepare('SELECT id FROM sessions').all().map(row => row.id), ['other-browser']);
});

test('link challenge preserves the proved current session', t => {
  const { auth, db } = fixture(t);
  db.prepare('INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at_ms) VALUES (?,?,?,?,?)').run('proved-session', 'u1', 'proved-token', '2026-01-01', Date.now() + 10000);
  const key = contextKey();
  auth.issue(auth.captureBrowser(key), { userId: 'u1', sessionId: 'proved-session' }, 'link');
  assert.equal(db.prepare('SELECT user_id FROM sessions WHERE id=?').get('proved-session').user_id, 'u1');
});

test('flow expiry and session binding are checked independently of the token', t => {
  const { auth, advanceTime } = fixture(t);
  const { flow, snapshot } = fixtureIssue(auth);
  assert.throws(() => auth.claim(snapshot, flow.id, flow.cookieToken, { userId: 'u1', sessionId: 'other' }), rejected('google_flow_expired'));
  advanceTime(600001);
  assert.throws(() => auth.claim(snapshot, flow.id, flow.cookieToken, binding), rejected('google_flow_expired'));
});

test('Google claims reject wrong audience, issuer, nonce, expiry and unverified email', async t => {
  const { auth, setClaims, identity } = fixture(t);
  for (const patch of [{ aud: 'another-client' }, { iss: 'https://evil.example' }, { nonce: 'not-the-issued-nonce' }, { exp: 1 }, { email_verified: false }, { sub: '' }]) {
    const { flow, snapshot } = fixtureIssue(auth);
    const claimed = auth.claim(snapshot, flow.id, flow.cookieToken, binding);
    setClaims(identity(flow.nonce, patch));
    await assert.rejects(auth.verifyCredential('synthetic-google-id-token', claimed), rejected('google_invalid_identity'));
  }
});

test('verified registration can wait for consent without persisting a raw credential', async t => {
  const { auth, db, identity, setClaims } = fixture(t);
  const { flow, snapshot } = fixtureIssue(auth);
  const claimed = auth.claim(snapshot, flow.id, flow.cookieToken, binding);
  setClaims(identity(flow.nonce));
  const profile = await auth.verifyCredential('synthetic-google-id-token', claimed);
  auth.markRegistration(snapshot, flow.id, binding, profile);
  assert.deepEqual(auth.pending(snapshot, flow.id, flow.cookieToken, binding), { sub: 'google-sub-1', email: 'google@example.test', name: 'Google User' });
  const stored = JSON.stringify(db.prepare('SELECT * FROM google_auth_flows').all());
  assert.equal(stored.includes('synthetic-google-id-token'), false);
  assert.equal(stored.includes(flow.cookieToken), false);
  assert.equal(stored.includes(flow.nonce), false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 2);
});

test('Google subject uniqueness never replaces another account or rewrites its email', t => {
  const { auth, db } = fixture(t);
  const profile = { sub: 'stable-sub', email: 'first-google@example.test', name: 'Google' };
  auth.link('u1', profile);
  assert.throws(() => auth.link('u2', profile), rejected('google_already_linked'));
  auth.link('u1', { ...profile, email: 'renamed-google@example.test' });
  assert.equal(auth.identity('stable-sub').userId, 'u1');
  assert.equal(db.prepare('SELECT email FROM users WHERE id=?').get('u1').email, 'existing@example.test');
});

test('Google-only users cannot remove their only sign-in method', t => {
  const { auth, db } = fixture(t);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(module.GOOGLE_ONLY_PASSWORD_HASH, 'u1');
  auth.link('u1', { sub: 'only-sub', email: 'only@example.test', name: 'Only' });
  assert.equal(auth.methods('u1').password, false);
  assert.throws(() => auth.unlink('u1'), rejected('google_last_signin_method'));
  assert.equal(auth.identity('only-sub').userId, 'u1');
});

test('cancel of an old flow cannot clear the current flow or its session', t => {
  const { auth, db } = fixture(t);
  const key = contextKey();
  const old = fixtureIssue(auth, key);
  const current = fixtureIssue(auth, key);
  const snapshot = auth.captureBrowser(key);
  db.prepare('INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at_ms,auth_context_hash,auth_flow_id) VALUES (?,?,?,?,?,?,?)').run('new-session', 'u1', 'new-token', '2026-01-01', Date.now() + 10000, snapshot.hash, current.flow.id);
  auth.cancel(snapshot, old.flow.id);
  assert.equal(auth.claim(snapshot, current.flow.id, current.flow.cookieToken, binding).id, current.flow.id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions WHERE id=?').get('new-session').n, 1);
});

test('Google verification validates a real RSA signature rather than decoding an untrusted JWT', async () => {
  assert.ok(module, 'Google authentication service has not been implemented');
  const { OAuth2Client } = await import('google-auth-library');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const client = new OAuth2Client(CLIENT);
  client.getFederatedSignonCertsAsync = async () => ({ certs: { synthetic: publicKey.export({ type: 'spki', format: 'pem' }) }, format: 'PEM' });
  const payload = { iss: 'https://accounts.google.com', aud: CLIENT, sub: 'rsa-subject', email: 'signed@example.test', email_verified: true, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, nonce: 'issued-nonce' };
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const data = encode({ alg: 'RS256', kid: 'synthetic' }) + '.' + encode(payload);
  const signature = crypto.sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url');
  const jwt = data + '.' + signature;
  assert.equal((await module.verifyGoogleIdToken(jwt, CLIENT, { client })).sub, 'rsa-subject');
  const forged = encode({ alg: 'RS256', kid: 'synthetic' }) + '.' + encode({ ...payload, sub: 'forged' }) + '.' + signature;
  await assert.rejects(module.verifyGoogleIdToken(forged, CLIENT, { client }), rejected('google_invalid_identity'));
});
