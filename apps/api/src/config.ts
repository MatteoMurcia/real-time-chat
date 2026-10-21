import { isIP } from 'node:net';

export const defaultTrafficLimits = { send: 30, typing: 10, login: 10, register: 5, createChannel: 10, connections: 5 };
export type TrafficLimits = typeof defaultTrafficLimits;

export function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}

export function loadConfig(env: NodeJS.ProcessEnv) {
  const nodeEnv = env.NODE_ENV;
  if (!nodeEnv) throw new Error('NODE_ENV is required');
  if (nodeEnv !== 'development' && nodeEnv !== 'test' && nodeEnv !== 'production') {
    throw new Error('NODE_ENV must be development, test, or production');
  }

  const rawPort = env.PORT;
  if (!rawPort) throw new Error('PORT is required');
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  const host = env.HOST ?? '127.0.0.1';
  if (!isIP(host)) throw new Error('HOST must be an IP address');

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  try {
    const url = new URL(databaseUrl);
    if (!['postgresql:', 'postgres:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) {
      throw new Error();
    }
  } catch {
    throw new Error('DATABASE_URL must be a PostgreSQL connection URL with a database name');
  }

  const appOrigin = env.APP_ORIGIN ?? 'http://127.0.0.1:8080';
  try {
    const url = new URL(appOrigin);
    if (url.origin !== appOrigin || (url.protocol !== 'https:'
      && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error();
  } catch {
    throw new Error('APP_ORIGIN must be an HTTPS origin or a loopback HTTP origin without a path');
  }

  const rawTtl = env.SESSION_TTL_SECONDS ?? '86400';
  const sessionTtlSeconds = Number(rawTtl);
  if (!/^\d+$/.test(rawTtl) || sessionTtlSeconds < 1 || sessionTtlSeconds > 604800) {
    throw new Error('SESSION_TTL_SECONDS must be an integer between 1 and 604800');
  }

  const trafficLimits = { ...defaultTrafficLimits };
  const names = { send: 'SEND_LIMIT', typing: 'TYPING_LIMIT', login: 'LOGIN_LIMIT', register: 'REGISTER_LIMIT', createChannel: 'CHANNEL_CREATE_LIMIT', connections: 'SESSION_CONNECTION_LIMIT' } as const;
  for (const key of Object.keys(names) as (keyof TrafficLimits)[]) {
    const raw = env[names[key]] ?? String(trafficLimits[key]);
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 1000) throw new Error(`${names[key]} must be an integer between 1 and 1000`);
    trafficLimits[key] = Number(raw);
  }
  const trustedProxyIps = env.TRUSTED_PROXY_IPS ? env.TRUSTED_PROXY_IPS.split(',').map(ip => normalizeIp(ip.trim())) : [];
  if (trustedProxyIps.some(ip => !isIP(ip))) throw new Error('TRUSTED_PROXY_IPS must be a comma-separated list of IP addresses');
  return { nodeEnv, port, host, databaseUrl, appOrigin, sessionTtlSeconds, trafficLimits, trustedProxyIps };
}
