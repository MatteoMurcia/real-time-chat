import { isIP } from 'node:net';

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

  return { nodeEnv, port, host, databaseUrl, appOrigin };
}
