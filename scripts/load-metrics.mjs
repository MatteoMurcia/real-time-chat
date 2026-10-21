import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';

export function validateLocalDocker(endpoint) {
  if (typeof endpoint !== 'string' || !(/^unix:\/\/\/[^?#]+$/.test(endpoint) || /^npipe:\/\/\/\/\.\/pipe\/[\w.-]+$/.test(endpoint))) {
    throw new Error('LOCAL_DOCKER_REQUIRED');
  }
}

export function loadOptions(args) {
  const defaults = { users: 8, connections: 2, rate: 1, seconds: 30, warmup: 5 };
  const { values } = parseArgs({ args, options: Object.fromEntries(Object.keys(defaults).map(key => [key, { type: 'string' }])) });
  const options = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, values[key] === undefined ? fallback : Number(values[key])]));
  const { users, connections, rate, seconds, warmup } = options;
  if (![users, connections, seconds, warmup].every(Number.isInteger) || users < 1 || users > 50
    || connections < 1 || connections > 5 || users * connections > 100 || !Number.isFinite(rate) || rate < .1 || rate > 3
    || seconds < 5 || seconds > 120 || warmup < 0 || warmup > 30 || Math.floor(seconds * rate) < 1) throw new Error('Invalid bounded load parameters');
  return options;
}

export function percentile(values, fraction) {
  return values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] : null;
}

export function deliveryAudit(received, acknowledged) {
  let missing = 0, unacknowledged = 0, mismatched = 0;
  for (const ids of received) {
    for (const [id, fingerprint] of acknowledged) {
      if (!ids.has(id)) missing++;
      else if (ids.get(id) !== fingerprint) mismatched++;
    }
    for (const id of ids.keys()) if (!acknowledged.has(id)) unacknowledged++;
  }
  return { expected: received.length * acknowledged.size, received: received.reduce((sum, ids) => sum + ids.size, 0), missing, unacknowledged, mismatched };
}

export function messageFingerprint(message) {
  return createHash('sha256').update(JSON.stringify([message.id, message.channelId, message.clientMessageId,
    message.sequence, message.body, message.author?.id, message.author?.displayName, message.createdAt])).digest('hex');
}

export function summarize({ planned, sent, latencyMs, errors, lagMs, elapsedMs }) {
  const failed = Object.values(errors).reduce((sum, count) => sum + count, 0);
  return { planned, sent, acknowledged: latencyMs.length, errors, skipped: planned - sent,
    errorRate: sent ? failed / sent : null, unsuccessfulScheduledRate: planned ? (planned - latencyMs.length) / planned : null,
    elapsedMs, offeredRps: sent / (elapsedMs / 1000), acknowledgedRps: latencyMs.length / (elapsedMs / 1000),
    ackLatencyMs: { p50: percentile(latencyMs, .5), p95: percentile(latencyMs, .95) }, dispatchLagMs: { p95: percentile(lagMs, .95) } };
}
