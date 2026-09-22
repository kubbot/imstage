import { test, expect, request, type Page, type APIRequestContext, type APIResponse } from '@playwright/test';
import { createScene } from '../../apps/web/src/studio/model';

test.use({ locale: 'zh-CN' });

const PASSWORD = 'synthetic-project-save-password-2026';

type Session = { headers: { Origin: string; 'X-IMStage-Request': string } };

// A textarea's value is included in Playwright's label text, so exact
// getByLabel matching breaks once rules are non-empty. Scope the fields.
const rulesField = (page: Page) => page.locator('.project-form textarea');
const nameField = (page: Page) => page.getByLabel('项目名称', { exact: true });
const autosave = (page: Page, status?: string) => page.locator(status ? `[data-autosave="${status}"]` : '[data-autosave]');

async function registerViaApi(page: Page, name: string): Promise<Session> {
  const origin = new URL(page.url()).origin;
  const headers = { Origin: origin, 'X-IMStage-Request': '1' };
  const response = await page.request.post('/api/auth/register', {
    headers,
    data: { name, email: `project-autosave-${crypto.randomUUID()}@example.test`, password: PASSWORD },
  });
  expect(response.ok()).toBe(true);
  return { headers };
}

/**
 * Register through the real API, then pull the session into AuthProvider with a
 * reload before any hash-only navigation to the project route.
 */
async function createProject(page: Page, label: string) {
  await page.goto('/?lang=zh#/register');
  const session = await registerViaApi(page, `自动保存${label}`);
  const name = `${label} 项目`;
  const created = await page.request.post('/api/projects', {
    headers: session.headers,
    data: { name, rules: '初始规则', platform: 'wechat' },
  });
  expect(created.ok()).toBe(true);
  const item = (await created.json()).item as { id: string; name: string; rules: string; platform: string; revision: number };
  await page.reload();
  await page.goto(`/?lang=zh#/projects?project=${item.id}`);
  await expect(nameField(page)).toHaveValue(name);
  return { ...session, projectId: item.id, item, name };
}

async function projectOnServer(page: Page, session: Session, projectId: string) {
  const response = await page.request.get(`/api/projects/${projectId}`, { headers: session.headers });
  expect(response.ok()).toBe(true);
  return (await response.json()).item as { name: string; rules: string; platform: string; revision: number };
}

/** First PUT reaches the server but the page never sees the response. */
async function loseFirstPut(page: Page, projectId: string) {
  let lost = false;
  await page.route(`**/api/projects/${projectId}`, async (route) => {
    if (route.request().method() !== 'PUT' || lost) return route.continue();
    lost = true;
    await route.fetch(); // the server accepts the write
    await route.abort(); // the page never sees the response
  });
}

test('project settings save automatically with an honest status and no manual button', async ({ page }) => {
  const { headers, projectId } = await createProject(page, '自动');

  await expect(page.getByRole('button', { name: '保存项目', exact: true })).toHaveCount(0);
  await expect(autosave(page)).toHaveAttribute('data-autosave', 'saved');

  await rulesField(page).fill('自动保存的规则');
  await expect(autosave(page, 'local')).toBeVisible();
  await nameField(page).fill('自动项目');

  await expect(autosave(page, 'saved')).toBeVisible();
  const saved = await projectOnServer(page, { headers }, projectId);
  expect(saved.name).toBe('自动项目');
  expect(saved.rules).toBe('自动保存的规则');

  await page.reload();
  await expect(rulesField(page)).toHaveValue('自动保存的规则');
  await expect(autosave(page, 'saved')).toBeVisible();
  const leftoverDrafts = await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('imstage.project.draft')).length);
  expect(leftoverDrafts).toBe(0);
});

test('an unsaved draft survives a reload and syncs on retry', async ({ page }) => {
  const { headers, projectId } = await createProject(page, '恢复');

  await page.route('**/api/projects/**', async (route) => {
    if (route.request().method() === 'PUT') return route.abort();
    return route.continue();
  });

  await rulesField(page).fill('断网期间的规则');
  await expect(autosave(page, 'error')).toBeVisible();
  expect(await projectOnServer(page, { headers }, projectId)).toMatchObject({ rules: '初始规则' });

  // The tab cache restores the edit after a reload even before the cloud GET lands.
  await page.reload();
  await expect(rulesField(page)).toHaveValue('断网期间的规则');
  await expect(autosave(page, 'error')).toBeVisible();

  await page.unroute('**/api/projects/**');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(autosave(page, 'saved')).toBeVisible();
  expect(await projectOnServer(page, { headers }, projectId)).toMatchObject({ rules: '断网期间的规则' });
});

test('edits made while a save is in flight drain onto the acknowledged revision', async ({ page }) => {
  const { headers, projectId } = await createProject(page, '并发');

  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const putBodies: Array<Record<string, unknown>> = [];
  await page.route(`**/api/projects/${projectId}`, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    putBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    if (putBodies.length === 1) await firstHeld;
    return route.continue();
  });

  await rulesField(page).fill('A 版本');
  await expect.poll(() => putBodies.length).toBe(1);

  // Keep editing while the first PUT is still unanswered.
  await rulesField(page).fill('B 版本');
  releaseFirst();

  await expect.poll(() => putBodies.length, { timeout: 10000 }).toBe(2);
  expect(putBodies[1].revision).toBe((putBodies[0].revision as number) + 1);
  expect(putBodies[1].rules).toBe('B 版本');
  await expect(autosave(page, 'saved')).toBeVisible();
  expect(await projectOnServer(page, { headers }, projectId)).toMatchObject({ rules: 'B 版本' });
});

test('an offline draft pauses and then syncs when the browser comes back online', async ({ page, context }) => {
  const { headers, projectId } = await createProject(page, '离线');

  await context.setOffline(true);
  await rulesField(page).fill('离线规则');
  await expect(autosave(page, 'error')).toBeVisible();

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(autosave(page, 'saved')).toBeVisible();
  expect(await projectOnServer(page, { headers }, projectId)).toMatchObject({ rules: '离线规则' });
});

test('a timed-out accepted save is reconciled through fetched content equality', async ({ page }) => {
  const { headers, projectId } = await createProject(page, '丢失');
  await loseFirstPut(page, projectId);

  await rulesField(page).fill('已接受但响应丢失');
  await expect(autosave(page, 'saved')).toBeVisible();
  expect(await projectOnServer(page, { headers }, projectId)).toMatchObject({ rules: '已接受但响应丢失' });
});

test('a lost acknowledgement with a trimmed name is not a false conflict', async ({ page }) => {
  const { headers, projectId } = await createProject(page, '空格');
  await loseFirstPut(page, projectId);

  await nameField(page).fill('  空格名称  ');
  await expect(autosave(page, 'saved')).toBeVisible();
  expect(await projectOnServer(page, { headers }, projectId)).toMatchObject({ name: '空格名称' });
  await expect(nameField(page)).toHaveValue('空格名称');
});

test('an unacknowledged accepted save is resolved before a later edit syncs', async ({ page }) => {
  const { headers, projectId } = await createProject(page, '不确定');

  let probeBlocked = true;
  let putCount = 0;
  await page.route(`**/api/projects/${projectId}`, async (route) => {
    const method = route.request().method();
    if (method === 'PUT') {
      putCount += 1;
      if (putCount === 1) {
        await route.fetch(); // the server accepts A
        await route.abort(); // but the acknowledgement is lost
        return;
      }
      return route.continue();
    }
    if (method === 'GET' && probeBlocked) return route.abort();
    return route.continue();
  });

  await rulesField(page).fill('A 版本');
  await expect(autosave(page, 'error')).toBeVisible();

  // B is drafted on top of the still-unconfirmed revision.
  await rulesField(page).fill('B 版本');
  probeBlocked = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));

  await expect(autosave(page, 'saved')).toBeVisible();
  expect(await projectOnServer(page, { headers }, projectId)).toMatchObject({ rules: 'B 版本' });
});

test('an unacknowledged accepted save is reconciled after a reload before draining later edits', async ({ page }) => {
  const { headers, projectId } = await createProject(page, '重载');

  let probeBlocked = true;
  let putCount = 0;
  await page.route(`**/api/projects/${projectId}`, async (route) => {
    const method = route.request().method();
    if (method === 'PUT') {
      putCount += 1;
      if (putCount === 1) {
        await route.fetch();
        await route.abort();
        return;
      }
      return route.continue();
    }
    if (method === 'GET' && probeBlocked) return route.abort();
    return route.continue();
  });

  await rulesField(page).fill('A 版本');
  await expect(autosave(page, 'error')).toBeVisible();
  await rulesField(page).fill('B 版本');

  // Unblock the network, then reload: the cached uncertain snapshot must still
  // reconcile instead of blindly resending revision 1 and hitting a 409.
  probeBlocked = false;
  await page.reload();
  await expect(rulesField(page)).toHaveValue('B 版本');
  await expect(autosave(page, 'saved')).toBeVisible();
  expect(await projectOnServer(page, { headers }, projectId)).toMatchObject({ rules: 'B 版本' });
});

test('a revision conflict never overwrites the other update and can be discarded explicitly', async ({ page }) => {
  const { headers, projectId, item } = await createProject(page, '冲突');

  const external = await page.request.put(`/api/projects/${projectId}`, {
    headers,
    data: { name: item.name, rules: '外部更新', platform: item.platform, revision: item.revision },
  });
  expect(external.ok()).toBe(true);

  await rulesField(page).fill('本地更新');
  await expect(autosave(page, 'conflict')).toBeVisible();
  await expect(rulesField(page)).toHaveValue('本地更新');
  expect(await projectOnServer(page, { headers }, projectId)).toMatchObject({ rules: '外部更新' });

  // Batches must not read the stale rules while conflicted.
  await expect(page.getByRole('button', { name: /开始批量生成/ })).toBeDisabled();

  // The explicit discard action replaces local content only after confirmation.
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: '重新加载并放弃本机修改', exact: true }).click();
  await expect(rulesField(page)).toHaveValue('外部更新');
  await expect(autosave(page, 'saved')).toBeVisible();
});

test('a slow background GET cannot roll back an acknowledged revision', async ({ page }) => {
  await page.goto('/?lang=zh#/register');
  const session = await registerViaApi(page, '过期GET');
  const created = await page.request.post('/api/projects', {
    headers: session.headers,
    data: { name: '过期 GET 项目', rules: '初始规则', platform: 'wechat' },
  });
  expect(created.ok()).toBe(true);
  const project = (await created.json()).item as { id: string };
  const scene = { ...createScene(), id: crypto.randomUUID() };
  const savedScene = await page.request.put(`/api/scenes/${scene.id}`, { headers: session.headers, data: { scene, revision: 0 } });
  expect(savedScene.ok()).toBe(true);
  await page.reload();
  await page.goto(`/?lang=zh#/projects?project=${project.id}`);
  await expect(nameField(page)).toHaveValue('过期 GET 项目');

  let releaseHeld!: () => void;
  const held = new Promise<void>((resolve) => { releaseHeld = resolve; });
  let captured: APIResponse | undefined;
  let getCount = 0;
  await page.route(`**/api/projects/${project.id}`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    getCount += 1;
    if (getCount === 1) {
      captured = await route.fetch(); // snapshot captured at revision 1
      await held;
      return route.fulfill({ response: captured });
    }
    return route.continue();
  });

  // Attaching a scene triggers a background reload of the project.
  await page.locator('.project-attach select').selectOption(scene.id);
  await page.getByRole('button', { name: '关联', exact: true }).click();
  await expect.poll(() => getCount).toBe(1);

  // Our own save reaches revision 2 while the old snapshot is still held.
  await rulesField(page).fill('自己的第二版规则');
  await expect(autosave(page, 'saved')).toBeVisible();
  const own = await projectOnServer(page, session, project.id);
  expect(own).toMatchObject({ rules: '自己的第二版规则', revision: 2 });

  releaseHeld();
  await page.waitForTimeout(600);
  await expect(rulesField(page)).toHaveValue('自己的第二版规则');
  await expect(autosave(page, 'saved')).toBeVisible();
  await expect(page.locator('.projects-heading p')).toContainText('版本 2');
});

test('a batch cannot start while project rules are still syncing', async ({ page }) => {
  const { headers, projectId } = await createProject(page, '批量');

  await page.route('**/api/projects/**', async (route) => {
    if (route.request().method() === 'PUT') return route.abort();
    return route.continue();
  });

  await rulesField(page).fill('待同步规则');
  await expect(autosave(page, 'error')).toBeVisible();
  const start = page.getByRole('button', { name: /开始批量生成/ });
  await expect(start).toBeDisabled();
  await expect(page.locator('.project-sync-note')).toContainText('未同步');

  await page.unroute('**/api/projects/**');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(autosave(page, 'saved')).toBeVisible();
  await expect(start).toBeEnabled();
  expect(await projectOnServer(page, { headers }, projectId)).toMatchObject({ rules: '待同步规则' });
});

test('a response from a previous account never writes into the new owner', async ({ page }) => {
  const { projectId: projectA } = await createProject(page, '旧账号');

  let releaseOld!: () => void;
  const oldHeld = new Promise<void>((resolve) => { releaseOld = resolve; });
  let heldOnce = false;
  await page.route(`**/api/projects/${projectA}`, async (route) => {
    if (route.request().method() === 'PUT' && !heldOnce) {
      heldOnce = true;
      await oldHeld;
    }
    return route.continue();
  });

  await rulesField(page).fill('旧账号本机规则');
  await expect.poll(() => heldOnce).toBe(true);

  // Prepare account B in an isolated request context so A's cookies stay intact.
  const origin = new URL(page.url()).origin;
  const bApi: APIRequestContext = await request.newContext({ baseURL: origin });
  const bHeaders = { Origin: origin, 'X-IMStage-Request': '1' };
  const bEmail = `project-autosave-b-${crypto.randomUUID()}@example.test`;
  const bRegister = await bApi.post('/api/auth/register', {
    headers: bHeaders,
    data: { name: '账号乙', email: bEmail, password: PASSWORD },
  });
  expect(bRegister.ok()).toBe(true);
  const bCreated = await bApi.post('/api/projects', {
    headers: bHeaders,
    data: { name: 'B 项目', rules: 'B 服务端规则', platform: 'wechat' },
  });
  expect(bCreated.ok()).toBe(true);
  const bProject = (await bCreated.json()).item as { id: string };
  await bApi.dispose();

  // Switch accounts through the UI (no page unload) while A's PUT is still held.
  await page.goto('/?lang=zh#/account');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page).toHaveURL(/#\/login/);
  await page.getByLabel('邮箱', { exact: true }).fill(bEmail);
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/#\/workspace/);

  await page.goto(`/?lang=zh#/projects?project=${bProject.id}`);
  await expect(nameField(page)).toHaveValue('B 项目');

  releaseOld();
  // Give the stale response time to arrive and be ignored.
  await page.waitForTimeout(1200);
  await expect(rulesField(page)).toHaveValue('B 服务端规则');
  await expect(autosave(page)).toHaveAttribute('data-autosave', 'saved');
  const bOnServer = await page.request.get(`/api/projects/${bProject.id}`, { headers: bHeaders });
  expect(((await bOnServer.json()) as { item: { rules: string } }).item.rules).toBe('B 服务端规则');
});

test('edits during a lost acknowledgement and its reconciliation GET remain the latest draft', async ({ page }) => {
  const { headers, projectId } = await createProject(page, '并发认领');
  let releasePut!: () => void;
  const putGate = new Promise<void>((resolve) => { releasePut = resolve; });
  let releaseGet!: () => void;
  const getGate = new Promise<void>((resolve) => { releaseGet = resolve; });
  let accepted = false;
  let probing = false;
  let puts = 0;
  await page.route(`**/api/projects/${projectId}`, async (route) => {
    if (route.request().method() === 'PUT' && ++puts === 1) {
      await route.fetch();
      accepted = true;
      await putGate;
      return route.abort();
    }
    if (route.request().method() === 'GET' && accepted && !probing) {
      const response = await route.fetch();
      probing = true;
      await getGate;
      return route.fulfill({ response });
    }
    return route.continue();
  });
  await rulesField(page).fill('A 已发送');
  await expect.poll(() => accepted).toBe(true);
  await rulesField(page).fill('B 在 PUT 期间输入');
  releasePut();
  await expect.poll(() => probing).toBe(true);
  await rulesField(page).fill('C 在 GET 期间输入');
  releaseGet();
  await expect(autosave(page, 'saved')).toBeVisible();
  await expect(rulesField(page)).toHaveValue('C 在 GET 期间输入');
  expect(await projectOnServer(page, { headers }, projectId)).toMatchObject({ rules: 'C 在 GET 期间输入' });
  expect(puts).toBe(2);
});
