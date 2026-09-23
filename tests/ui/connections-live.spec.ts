import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';

// Real local API + browser + renderer. Only the test OAuth client's callback is
// intercepted; this is not a claim that the ChatGPT host accepted the connection.
test.use({ locale: 'zh-CN' });
test('authorize, create through MCP, edit in the website, render and revoke', async ({ page, baseURL }) => {
  test.setTimeout(90000);
  const origin = new URL(baseURL!).origin;
  const redirect = 'https://client.example.test/callback';
  const registration = await page.request.post('/api/oauth/register', { data: {
    client_name: 'Browser integration test', redirect_uris: [redirect],
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  } });
  expect(registration.status()).toBe(201);
  const { client_id } = await registration.json();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authorize = new URL('/api/oauth/authorize', origin);
  authorize.search = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: redirect,
    code_challenge: challenge, code_challenge_method: 'S256', state: 'browser-flow', resource: `${origin}/api/mcp`, scope: 'imstage.scenes' }).toString();
  await page.route(`${redirect}*`, route => route.fulfill({ body: 'Synthetic OAuth client callback' }));
  await page.goto(authorize.href);
  await page.getByRole('link', { name: '登录并继续' }).click();
  await page.getByRole('link', { name: '创建账号', exact: true }).click();
  await page.getByLabel('怎么称呼你').fill('连接验收');
  await page.getByLabel('邮箱', { exact: true }).fill(`connection-${crypto.randomUUID()}@example.test`);
  await page.getByLabel('密码', { exact: true }).fill(crypto.randomBytes(24).toString('base64url'));
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await expect(page.getByRole('heading', { name: '允许连接你的 IMStage？' })).toBeVisible();
  await expect(page.getByText('client.example.test', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '允许连接', exact: true }).click();
  await expect(page).toHaveURL(/^https:\/\/client.example.test\/callback\?/);
  const callback = new URL(page.url());
  expect(callback.searchParams.get('state')).toBe('browser-flow');
  const exchange = await page.request.post(`${origin}/api/oauth/token`, { form: {
    grant_type: 'authorization_code', client_id, code: callback.searchParams.get('code')!,
    code_verifier: verifier, redirect_uri: redirect, resource: `${origin}/api/mcp`,
  } });
  expect(exchange.status()).toBe(200);
  const { access_token } = await exchange.json();
  let rpcId = 0;
  async function call(name: string, args: object) {
    const response = await page.request.post(`${origin}/api/mcp`, {
      headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/json, text/event-stream' },
      data: { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } },
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.error).toBeUndefined(); expect(body.result.isError, JSON.stringify(body.result.structuredContent?.error)).not.toBe(true);
    return body.result;
  }
  const created = await call('imstage_create_scene', { scene: {
    title: '新品发布演示', platform: 'wechat', selfId: 'self', deviceTime: '10:00', date: '2026-09-23', watermark: '合成演示',
    participants: [{ id: 'self', name: '我' }, { id: 'team', name: '团队' }],
    messages: [{ id: 'launch', participantId: 'team', type: 'text', text: '新品明早十点发布。', time: '10:00' }],
  }, idempotencyKey: 'browser-create' });
  const { sceneId, webUrl } = created.structuredContent;
  expect(webUrl).toBe(`${origin}/#/workspace?scene=${sceneId}`);
  await page.goto(webUrl);
  await expect(page.locator('.agent-phone .scene-view')).toContainText('新品明早十点发布。');
  await page.getByRole('button', { name: '选择消息：新品明早十点发布。', exact: true }).click();
  await page.getByRole('textbox', { name: '消息文字', exact: true }).fill('网页改为下午两点发布。');
  await expect.poll(async () => (await (await page.request.get(`${origin}/api/scenes/${sceneId}`)).json()).item.scene.messages[0].text).toBe('网页改为下午两点发布。');
  const read = await call('imstage_get_scene', { sceneId });
  expect(read.structuredContent.scene.messages[0].text).toBe('网页改为下午两点发布。');
  const render = await call('imstage_render_scene', { sceneId, surface: 'ios', width: 390, outputKind: 'long-screenshot' });
  const png = Buffer.from(render.content.find((block: { type: string }) => block.type === 'image').data, 'base64');
  expect(png.subarray(1, 4).toString()).toBe('PNG');
  expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(390);
  expect(png.length).toBeGreaterThan(5000);
  await page.reload();
  await expect(page.locator('.agent-phone .scene-view')).toContainText('网页改为下午两点发布。');
  await page.goto(`${origin}/?lang=zh#/connect`);
  await expect(page.getByText('Browser integration test', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '断开', exact: true }).click();
  await page.getByRole('button', { name: '确认断开', exact: true }).click();
  await expect(page.getByText('Browser integration test', { exact: true })).toHaveCount(0);
  const revoked = await page.request.post(`${origin}/api/mcp`, {
    headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 99, method: 'tools/list' },
  });
  expect(revoked.status()).toBe(401);
});
