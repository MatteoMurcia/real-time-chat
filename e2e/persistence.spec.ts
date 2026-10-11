import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { io } from 'socket.io-client';

test('preserves accounts, sessions and message idempotency after recreating the compiled stack', async ({ page, context }) => {
  test.setTimeout(180000);
  const project = process.env.E2E_COMPOSE_PROJECT ?? '';
  const envFile = process.env.E2E_COMPOSE_ENV_FILE ?? '';
  expect(['ci-chat', 'chat-e2e', 'handshake-verification']).toContain(project);
  expect(envFile).not.toBe('');
  const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 150000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const compose = (...args: string[]) => docker('compose', '-p', project, '--env-file', envFile, '-f', 'compose.yaml', ...args);
  const containers = ['db', 'migrate', 'api', 'web'].map(service => `${project}-${service}-1`);
  const before = containers.map(container => docker('inspect', '--format', '{{.Id}}', container));
  for (const container of containers) {
    expect(docker('inspect', '--format', '{{ index .Config.Labels "com.docker.compose.project" }}', container)).toBe(project);
    expect(docker('inspect', '--format', '{{range .Mounts}}{{.Type}} {{end}}', container)).not.toContain('bind');
  }
  const volume = `${project}_postgres_data`;
  expect(docker('inspect', '--format', '{{range .Mounts}}{{.Name}}:{{.Destination}}{{end}}', `${project}-db-1`)).toBe(`${volume}:/var/lib/postgresql`);
  expect(docker('volume', 'inspect', '--format', '{{ index .Labels "com.docker.compose.project" }}', volume)).toBe(project);
  const created = docker('volume', 'inspect', '--format', '{{.CreatedAt}}', volume);

  const email = `persistence-${randomUUID()}@example.test`;
  const password = 'a unique persistence passphrase';
  const signIn = async () => {
    await page.getByLabel('Email address', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText('Live connection established.', { exact: true })).toBeVisible();
  };
  await page.goto('/register');
  await page.getByLabel('Display name', { exact: true }).fill('Persistent Browser');
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/\/login\?registered=1$/);
  await signIn();
  const cookie = (await context.cookies()).find(item => item.name === 'chat_session')!;
  const origin = process.env.E2E_BASE_URL!;
  const csrf = (await (await context.request.get('/api/auth/session/csrf', { headers: { origin } })).json()).csrfToken;
  const channelResponse = await context.request.post('/api/channels', {
    headers: { origin, 'x-csrf-token': csrf }, data: { name: `Persistent ${randomUUID()}`, slug: `persist-${randomUUID()}` },
  });
  expect(channelResponse.status()).toBe(201);
  const { channel } = await channelResponse.json();
  const message = { channelId: channel.id, clientMessageId: randomUUID(), body: 'Survives container recreation' };
  const send = async () => {
    const socket = io(origin, { autoConnect: false, reconnection: false, timeout: 3000, transports: ['websocket'], extraHeaders: { origin, cookie: `${cookie.name}=${cookie.value}` } });
    try {
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
      return await socket.timeout(3000).emitWithAck('message:send', message);
    } finally { socket.disconnect(); }
  };
  const originalMessage = await send();
  expect(originalMessage).toMatchObject({ ok: true, data: { ...message, sequence: '1' } });

  try {
    compose('down', '--timeout', '5');
    expect(docker('volume', 'inspect', '--format', '{{.CreatedAt}}', volume)).toBe(created);
  } finally {
    compose('up', '--no-build', '--wait', '--wait-timeout', '120');
  }
  containers.forEach((container, index) => expect(docker('inspect', '--format', '{{.Id}}', container)).not.toBe(before[index]));
  expect(docker('inspect', '--format', '{{.State.ExitCode}}', `${project}-migrate-1`)).toBe('0');
  await page.reload();
  await expect(page).toHaveURL(/\/workspace$/);
  await expect(page.getByText('Live connection established.', { exact: true })).toBeVisible();
  expect((await context.cookies()).find(item => item.name === 'chat_session')?.value).toBe(cookie.value);
  expect(await send()).toEqual(originalMessage);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/login\?reason=signed-out$/);
  await signIn();
});
