import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from './fixtures.js';

const exec = promisify(execFile);

test('guides a first conversation and resets only the marked disposable demo', async ({ browser, request, chatAccount }, testInfo) => {
  test.setTimeout(240000);
  expect(['ci-chat', 'chat-e2e', 'handshake-verification']).toContain(process.env.E2E_COMPOSE_PROJECT);
  const project = `demo-check-${randomUUID().slice(0, 8)}`, origin = 'http://127.0.0.1:18084';
  const envFile = testInfo.outputPath('.env.demo'); mkdirSync(dirname(envFile), { recursive: true });
  const alicePassword = randomBytes(24).toString('hex'), bobPassword = randomBytes(24).toString('hex');
  writeFileSync(envFile, `POSTGRES_DB=chat_demo\nPOSTGRES_USER=demo_local\nPOSTGRES_PASSWORD=${randomBytes(24).toString('hex')}\nDEMO_ALICE_PASSWORD=${alicePassword}\nDEMO_BOB_PASSWORD=${bobPassword}\nWEB_PORT=18084\nAPP_ORIGIN=${origin}\nBACKEND_SUBNET=172.29.43.0/24\nPROXY_IP=172.29.43.254\n`, { mode: 0o600, flag: 'wx' });
  const prefix = ['compose', '-p', project, '--env-file', envFile, '-f', resolve('compose.yaml'), '-f', resolve('compose.demo.yaml')];
  const docker = async (...args: string[]) => {
    try { return (await exec('docker', args, { timeout: 150000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim(); }
    catch { throw new Error(`Disposable demo Docker ${args[0]} failed`); }
  };
  const compose = (...args: string[]) => docker(...prefix, ...args);
  const refused = async (confirmation: string) => {
    try { await exec('docker', [...prefix, '--profile', 'tools', 'run', '--rm', 'reset', '--confirm', confirmation], { timeout: 30000 }); }
    catch (error) {
      expect((error as { code?: number }).code).toBe(1);
      expect(String((error as { stderr?: string }).stderr).includes('Demo reset refused or failed')).toBe(true); return;
    }
    throw new Error('Unsafe reset unexpectedly succeeded');
  };
  const sql = (statement: string) => compose('exec', '-T', 'db', 'psql', '-U', 'demo_local', '-d', 'chat_demo', '-v', 'ON_ERROR_STOP=1', '-c', statement);
  const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
  const canary = { channelId: chatAccount.channel.id, clientMessageId: randomUUID(), body: 'Unrelated base stack must survive demo reset' };
  try {
    const original = await chatAccount.sender.timeout(5000).emitWithAck('message:send', canary); expect(original.ok).toBe(true);
    await compose('up', '--build', '--wait', '--wait-timeout', '120');
    const mounts = JSON.parse(await docker('inspect', '--format', '{{json .Mounts}}', `${project}-db-1`)) as { Type: string; Name: string; Destination: string }[];
    expect(mounts.find(mount => mount.Destination === '/var/lib/postgresql')).toMatchObject({ Type: 'volume', Name: `${project}_demo_postgres_data` });
    expect(await docker('volume', 'inspect', '--format', '{{ index .Labels "com.docker.compose.project" }}', `${project}_demo_postgres_data`)).toBe(project);
    await compose('--profile', 'tools', 'build', 'seed', 'reset');
    await compose('--profile', 'tools', 'run', '--rm', 'seed');
    const aliceContext = await browser.newContext({ baseURL: origin }); contexts.push(aliceContext);
    const bobContext = await browser.newContext({ baseURL: origin }); contexts.push(bobContext);
    const alice = await aliceContext.newPage(), bob = await bobContext.newPage();
    const started = performance.now();
    await alice.goto('/');
    await expect(alice.getByRole('heading', { name: 'Try the local demo', exact: true })).toBeVisible();
    await expect(alice.getByText('alice@demo.example.test', { exact: true })).toBeVisible();
    await expect(alice.getByText('bob@demo.example.test', { exact: true })).toBeVisible();
    await alice.screenshot({ path: testInfo.outputPath('demo-overview-desktop.png'), fullPage: true });
    await alice.setViewportSize({ width: 375, height: 812 });
    expect(await alice.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await alice.screenshot({ path: testInfo.outputPath('demo-overview-mobile.png'), fullPage: true });
    await alice.setViewportSize({ width: 1280, height: 900 });
    await alice.getByRole('link', { name: 'Sign in to the demo', exact: true }).click();
    const login = async (page: typeof alice, name: 'alice' | 'bob', password: string) => {
      await page.getByLabel('Email address', { exact: true }).fill(`${name}@demo.example.test`);
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByText('Live connection established.', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Open chat Demo Lounge', exact: true }).click();
      await expect(page.getByRole('log').locator('[data-message-id]')).toHaveCount(50);
    };
    await login(alice, 'alice', alicePassword);
    const firstBody = `First demo message ${randomUUID()}`;
    await alice.getByLabel('Message', { exact: true }).fill(firstBody);
    await alice.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(alice.getByRole('log').locator('[data-message-id]').filter({ hasText: firstBody })).toHaveCount(1);
    const elapsed = Math.round(performance.now() - started);
    console.info(`Demo first confirmed message: ${elapsed}ms (automated clean-browser flow; build/seed excluded)`);
    expect(elapsed).toBeLessThan(120000);
    await bob.goto('/'); await bob.getByRole('link', { name: 'Sign in to the demo', exact: true }).click();
    await login(bob, 'bob', bobPassword); await expect(bob.getByRole('log')).toContainText(firstBody);
    await bob.getByLabel('Message', { exact: true }).fill('Reply from the second demo session');
    await bob.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(alice.getByRole('log')).toContainText('Reply from the second demo session');
    const demoChannels = await (await aliceContext.request.get('/api/channels')).json();
    const loungeId = demoChannels.channels.find((channel: { slug: string }) => channel.slug === 'demo-lounge').id;
    const readPath = `/api/channels/${loungeId}/read-cursor`;
    const csrf = (await (await aliceContext.request.get('/api/auth/session/csrf', { headers: { origin } })).json()).csrfToken;
    const marked = await aliceContext.request.put(readPath, { headers: { origin, 'x-csrf-token': csrf }, data: { lastReadSequence: '105' } });
    expect(marked.status()).toBe(200);
    expect(await marked.json()).toEqual({ channelId: loungeId, lastReadSequence: '105' });
    const oldCookie = (await aliceContext.cookies()).find(cookie => cookie.name === 'chat_session')!;
    await alice.getByLabel('Channel name', { exact: true }).fill('Temporary demo conversation');
    await alice.getByLabel('Channel slug', { exact: true }).fill('temporary-demo-conversation');
    const created = alice.waitForResponse(response => response.url().endsWith('/api/channels') && response.request().method() === 'POST' && response.status() === 201);
    await alice.getByRole('button', { name: 'Create channel', exact: true }).click();
    const oldChannel = (await (await created).json()).channel.id;
    await refused('wrong_database');
    await sql('COMMENT ON DATABASE chat_demo IS NULL');
    try { await refused('chat_demo'); }
    finally { await sql("COMMENT ON DATABASE chat_demo IS 'real-time-chat:local-demo:v1'"); }
    expect((await request.get(`${origin}/api/auth/me`, { headers: { cookie: `${oldCookie.name}=${oldCookie.value}` } })).status()).toBe(200);
    expect((await aliceContext.request.get(`/api/channels/${oldChannel}/messages`)).status()).toBe(200);
    await compose('stop', 'api', 'web');
    await compose('--profile', 'tools', 'run', '--rm', 'reset', '--confirm', 'chat_demo');
    await compose('--profile', 'tools', 'run', '--rm', 'seed');
    await compose('up', '-d', '--wait', '--wait-timeout', '120');
    await expect(alice).toHaveURL(/\/login(?:\?|$)/, { timeout: 15000 });
    await expect(bob).toHaveURL(/\/login(?:\?|$)/, { timeout: 15000 });
    await expect(alice.locator('app-chat')).toHaveCount(0);
    expect((await request.get(`${origin}/api/auth/me`, { headers: { cookie: `${oldCookie.name}=${oldCookie.value}` } })).status()).toBe(401);
    await login(alice, 'alice', alicePassword);
    const resetCursor = await aliceContext.request.get(readPath);
    expect(resetCursor.status()).toBe(200);
    expect(await resetCursor.json()).toEqual({ channelId: loungeId, lastReadSequence: '0' });
    await expect(alice.getByRole('log')).not.toContainText(firstBody);
    expect((await aliceContext.request.get(`/api/channels/${oldChannel}/messages`)).status()).toBe(404);
    await alice.screenshot({ path: testInfo.outputPath('demo-after-reset.png'), fullPage: true });
    expect(await chatAccount.sender.timeout(5000).emitWithAck('message:send', canary)).toMatchObject({ ok: true, data: { id: original.data.id } });
  } finally {
    await Promise.all(contexts.map(context => context.close()));
    try { await compose('down', '--volumes', '--remove-orphans'); }
    finally { unlinkSync(envFile); }
  }
});
