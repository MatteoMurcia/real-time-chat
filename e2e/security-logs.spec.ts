import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { io } from 'socket.io-client';

test('credentials stay out of public responses and service logs, including database constraint errors', async ({ request }) => {
  const project = process.env.E2E_COMPOSE_PROJECT ?? '';
  expect(['ci-chat', 'chat-e2e', 'handshake-verification']).toContain(project);
  const docker = (...args: string[]) => {
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 10000 });
    expect(result.status, `Docker ${args[0]} must succeed`).toBe(0);
    return `${result.stdout}${result.stderr}`;
  };
  for (const service of ['api', 'web', 'db', 'migrate']) {
    expect(docker('inspect', '--format', '{{ index .Config.Labels "com.docker.compose.project" }}', `${project}-${service}-1`).trim()).toBe(project);
  }
  const canary = randomUUID(), password = `Privacy ${randomUUID()}`, secrets = [canary, password];
  const origin = process.env.E2E_BASE_URL!;
  const safe = (value: unknown) => {
    const text = JSON.stringify(value);
    expect(secrets.some(secret => text.includes(secret)), 'Credential values must be absent').toBe(false);
  };
  const bootstrap = await request.get('/api/auth/csrf', { headers: { origin } });
  const { csrfToken } = await bootstrap.json();
  secrets.push(csrfToken);
  const email = `privacy-${randomUUID()}@example.test`;
  const authHeaders = { origin, 'x-csrf-token': csrfToken };
  const registered = await request.post('/api/auth/register', { headers: authHeaders,
    data: { email, displayName: 'Privacy probe', password } });
  expect(registered.status()).toBe(201);
  safe(await registered.json());
  const login = await request.post('/api/auth/login', { headers: authHeaders, data: { email, password } });
  expect(login.status()).toBe(200);
  const loginBody = await login.json();
  const cookies = (await request.storageState()).cookies;
  const session = cookies.find(cookie => cookie.name === 'chat_session')!;
  expect(!!session).toBe(true);
  secrets.push(session.value, createHash('sha256').update(session.value).digest('hex'));
  safe(loginBody);
  safe(await (await request.get('/api/auth/me')).json());
  const sessionCsrf = await request.get('/api/auth/session/csrf', { headers: { origin } });
  secrets.push((await sessionCsrf.json()).csrfToken);
  const headers = { origin, cookie: '', authorization: `Bearer ${session.value}`, referer: `${origin}/?token=${canary}`, 'x-csrf-token': canary };
  for (const path of ['/api/auth/me', '/api/channels', '/api/missing']) {
    const response = await request.get(`${path}?token=${session.value}&password=${canary}`, { headers })
      .catch(() => { throw new Error('Credential query probe request failed'); });
    expect(response.status()).toBe(path === '/api/missing' ? 404 : 401);
    safe(await response.json());
    safe(response.headers());
  }
  const malformed = await request.post(`/api/auth/login?token=${canary}`, {
    headers: { ...headers, 'content-type': 'application/json' }, data: `{"password":"${canary}",`,
  });
  expect(malformed.status()).toBe(400);
  safe(await malformed.json());
  const socket = io(origin, { autoConnect: false, reconnection: false, timeout: 3000, transports: ['websocket'],
    auth: { token: session.value }, query: { token: session.value }, extraHeaders: headers });
  try {
    const error = await new Promise<{ message: string; data?: unknown }>((resolve, reject) => {
      socket.once('connect', () => reject(new Error('Query credentials must not authenticate')));
      socket.once('connect_error', resolve); socket.connect();
    });
    safe({ message: error.message, data: error.data });
    expect(error.data).toMatchObject({ code: 'UNAUTHENTICATED' });
  } finally { socket.disconnect(); }
  const database = docker('exec', `${project}-db-1`, 'printenv', 'POSTGRES_DB').trim();
  const user = docker('exec', `${project}-db-1`, 'printenv', 'POSTGRES_USER').trim();
  const sql = `CREATE TEMP TABLE privacy_probe ("tokenHash" text UNIQUE); INSERT INTO privacy_probe VALUES ('${canary}'); INSERT INTO privacy_probe VALUES ('${canary}');`;
  const constraint = spawnSync('docker', ['exec', '-i', `${project}-db-1`, 'psql', '-U', user, '-d', database, '-v', 'ON_ERROR_STOP=1'],
    { input: sql, encoding: 'utf8', timeout: 10000 });
  expect(constraint.status, 'The database must reject the duplicate').toBe(3);
  secrets.push(docker('exec', `${project}-db-1`, 'printenv', 'POSTGRES_PASSWORD').trim());
  for (const service of ['api', 'web', 'db', 'migrate']) safe(docker('logs', `${project}-${service}-1`));
});
