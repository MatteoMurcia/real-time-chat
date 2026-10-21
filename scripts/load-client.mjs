import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { io } from 'socket.io-client';
import { loadOptions, summarize, deliveryAudit, messageFingerprint, isLoadMessage, isLoadAck } from './load-metrics.mjs';

if (process.env.BENCHMARK_DISPOSABLE !== 'chat_benchmark') throw new Error('Dedicated benchmark container required');
const options = loadOptions(process.argv.slice(2));
const origin = 'http://localhost:8080', endpoint = 'http://api:3000';
const sockets = [], received = [], acknowledged = new Map();
let channelId, duplicates = 0, invalidEvents = 0, disconnects = 0, closing = false, stage = 'fixture';

async function account(index) {
  const jar = new Map();
  const request = async (path, method = 'GET', data, token) => {
    const response = await fetch(endpoint + path, { method, signal: AbortSignal.timeout(10000),
      headers: { origin, cookie: [...jar.values()].join('; '), ...(data ? { 'content-type': 'application/json' } : {}), ...(token ? { 'x-csrf-token': token } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}) });
    for (const cookie of response.headers.getSetCookie()) jar.set(cookie.split('=')[0], cookie.split(';')[0]);
    if (!response.ok) throw new Error(`Fixture HTTP ${response.status} ${method} ${path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')}`);
    return response.json();
  };
  const { csrfToken } = await request('/api/auth/csrf');
  const email = `load-${randomUUID()}@example.test`, password = randomUUID() + randomUUID();
  await request('/api/auth/register', 'POST', { email, password, displayName: `Load User ${index}` }, csrfToken);
  const { user } = await request('/api/auth/login', 'POST', { email, password }, csrfToken);
  const auth = await request('/api/auth/session/csrf');
  if (!channelId) channelId = (await request('/api/channels', 'POST', { name: 'Benchmark channel', slug: 'benchmark-channel' }, auth.csrfToken)).channel.id;
  else await request(`/api/channels/${channelId}/membership`, 'PUT', undefined, auth.csrfToken);
  for (let tab = 0; tab < options.connections; tab++) {
    const socket = io(endpoint, { autoConnect: false, reconnection: false, transports: ['websocket'],
      extraHeaders: { origin, cookie: [...jar.values()].join('; ') } });
    sockets.push({ socket, userId: user.id, pending: 0 });
    const ids = new Map(); received.push(ids);
    socket.on('message:created', message => {
      if (!isLoadMessage(message) || message.channelId !== channelId) { invalidEvents++; return; }
      if (ids.has(message.id)) duplicates++;
      ids.set(message.id, messageFingerprint(message));
    });
    socket.on('disconnect', () => { if (!closing) disconnects++; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture connection timeout')), 10000);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.once('connect_error', () => { clearTimeout(timer); reject(new Error('Fixture connection failed')); });
      socket.connect();
    });
    const ack = await socket.timeout(5000).emitWithAck('channel:subscribe', { channelId });
    if (!ack?.ok) throw new Error('Fixture subscription failed');
  }
}

async function phase(seconds) {
  const startedAt = new Date().toISOString(), start = performance.now();
  const planned = Math.floor(seconds * options.rate) * sockets.length;
  const latencyMs = [], lagMs = [], errors = Object.create(null), pending = new Set();
  let sent = 0;
  const spacing = 1000 / (options.rate * sockets.length);
  for (let slot = 0; slot < planned; slot++) {
    const due = start + slot * spacing;
    await sleep(Math.max(0, due - performance.now()));
    const lag = Math.max(0, performance.now() - due), actor = sockets[slot % sockets.length];
    // Missed slots are reported, never hidden by catch-up bursts or an unbounded queue.
    if (lag > spacing || actor.pending >= 2) continue;
    lagMs.push(lag); sent++; actor.pending++;
    const input = { channelId, clientMessageId: randomUUID(), body: 'x'.repeat(128) }, before = performance.now();
    const operation = actor.socket.timeout(5000).emitWithAck('message:send', input).then(ack => {
      if (ack?.ok === false) {
        const code = /^[A-Z_]+$/.test(ack?.error?.code ?? '') ? ack.error.code : 'MALFORMED_ACK';
        errors[code] = (errors[code] ?? 0) + 1; return;
      }
      const message = ack?.data;
      if (!isLoadAck(ack) || message.channelId !== channelId || message.clientMessageId !== input.clientMessageId
        || message.author?.id !== actor.userId || message.body !== input.body || acknowledged.has(message.id)) {
        errors.INVALID_ACK = (errors.INVALID_ACK ?? 0) + 1; return;
      }
      acknowledged.set(message.id, messageFingerprint(message)); latencyMs.push(performance.now() - before);
    }).catch(() => { errors.TIMEOUT_OR_TRANSPORT = (errors.TIMEOUT_OR_TRANSPORT ?? 0) + 1; })
      .finally(() => { actor.pending--; pending.delete(operation); });
    pending.add(operation);
  }
  await sleep(Math.max(0, start + seconds * 1000 - performance.now()));
  await Promise.all(pending);
  return { startedAt, endedAt: new Date().toISOString(), ...summarize({ planned, sent, latencyMs, errors, lagMs, elapsedMs: performance.now() - start }), ackSamplesMs: latencyMs };
}

try {
  for (let index = 0; index < options.users; index++) await account(index);
  stage = 'warmup';
  const warmup = options.warmup ? await phase(options.warmup) : null;
  const cpuBefore = process.cpuUsage();
  stage = 'measurement';
  const measurement = await phase(options.seconds);
  const cpu = process.cpuUsage(cpuBefore);
  stage = 'delivery';
  const deadline = performance.now() + 5000;
  while (deliveryAudit(received, acknowledged).missing > 0 && performance.now() < deadline) await sleep(50);
  process.stdout.write(JSON.stringify({ schemaVersion: 1, node: process.version, options,
    dataset: { users: options.users, sessions: options.users, connections: sockets.length, channels: 1, messageBodyBytes: 128, acknowledgedMessages: acknowledged.size },
    warmup, measurement, delivery: { ...deliveryAudit(received, acknowledged), duplicates, invalidEvents, disconnects },
    generator: { measurementCpuUserMs: cpu.user / 1000, measurementCpuSystemMs: cpu.system / 1000, lifetimePeakRssBytes: process.resourceUsage().maxRSS * 1024 } }) + '\n');
} catch (error) {
  const reason = /^Fixture (HTTP \d{3} (GET|POST|PUT) \/[\w/:-]+|connection (timeout|failed)|subscription failed)$/.test(error.message) ? error.message : 'WORKER_EXCEPTION';
  process.stdout.write(JSON.stringify({ failure: { stage, reason } }) + '\n');
  process.stderr.write('Benchmark fixture or measurement failed; no complete worker result.\n'); process.exitCode = 1;
} finally { closing = true; for (const { socket } of sockets) socket.disconnect(); }
