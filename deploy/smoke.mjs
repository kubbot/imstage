import { pathToFileURL } from 'node:url';
class SmokeFailure extends Error {}

// Credentials enter through stdin, never command arguments or release files.
export async function smoke({ baseURL, origin, email, password, expectedRevision }) {
  const target = new URL(baseURL);
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(target.hostname);
  if (target.protocol !== 'https:' && !(local && target.protocol === 'http:')) throw new SmokeFailure('Smoke requires HTTPS');
  if (target.username || target.password || target.search || target.hash || target.pathname !== '/') throw new SmokeFailure('Smoke requires an origin URL');
  if (!email || !password) throw new SmokeFailure('Smoke credentials are required');
  const headers = { origin: origin || target.origin, 'content-type': 'application/json', 'x-imstage-request': '1' };
  const request = async (route, options = {}) => {
    const response = await fetch(`${target.origin}${route}`, { redirect: 'error', signal: AbortSignal.timeout(20000), ...options, headers: { 'user-agent': 'IMStage/0.2 deployment-smoke', ...options.headers } });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new SmokeFailure(`${route}: HTTP ${response.status}, expected JSON`);
    return { response, body: await response.json() };
  };
  const health = await request('/api/health');
  if (health.body.status !== 'ready') throw new SmokeFailure('API is not ready');
  if (expectedRevision && health.response.headers.get('x-imstage-revision') !== expectedRevision) throw new SmokeFailure('Public API revision does not match this release');
  const login = await request('/api/auth/login', { method: 'POST', headers, body: JSON.stringify({ email, password }) });
  const setCookie = login.response.headers.getSetCookie().find(value => value.startsWith('imstage_session='));
  const cookie = setCookie?.split(';')[0];
  if (!cookie) throw new SmokeFailure('Login did not establish a session cookie');
  try {
    if (!login.body.user?.id || login.body.user.email !== email.trim().toLowerCase()) throw new SmokeFailure('Login identity mismatch');
    if (!/;\s*HttpOnly\b/i.test(setCookie) || !/;\s*SameSite=Lax\b/i.test(setCookie) || (target.protocol === 'https:' && !/;\s*Secure\b/i.test(setCookie))) throw new SmokeFailure('Session cookie protections missing');
    for (let read = 0; read < 2; read++) {
      const session = await request('/api/auth/session', { headers: { cookie } });
      if (session.body.user?.id !== login.body.user.id) throw new SmokeFailure('Session did not persist');
    }
    await request('/api/scenes', { headers: { cookie, 'x-imstage-user': login.body.user.id } });
  } finally {
    await request('/api/auth/logout', { method: 'POST', headers: { ...headers, cookie }, body: '{}' });
  }
  const signedOut = await request('/api/auth/session', { headers: { cookie } });
  if (signedOut.body.user !== null) throw new SmokeFailure('Logout did not revoke the session');
  return { health: 'ready', login: true, session: true, logout: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 16384) throw new SmokeFailure('Smoke configuration too large');
    }
    console.log(JSON.stringify(await smoke(JSON.parse(input))));
  } catch (error) {
    // Never print request/response bodies, account identity or credentials.
    console.error(`Deployment smoke failed: ${error instanceof SmokeFailure ? error.message : 'Invalid configuration, transport failure, or malformed API JSON'}`);
    process.exitCode = 1;
  }
}
