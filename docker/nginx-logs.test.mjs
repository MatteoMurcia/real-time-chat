import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('real Nginx logs retain diagnostics without request credentials, including upstream failures', { timeout: 60000 }, async () => {
  const name = `chat-nginx-logs-${randomUUID()}`;
  const canary = randomUUID();
  const docker = (...args) => {
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, `Docker ${args[0]} must succeed`);
    return result.stdout;
  };
  docker('network', 'create', name);
  try {
    docker('run', '--detach', '--name', name, '--network', name, '--network-alias', 'api',
      '--publish', '127.0.0.1::8080', '--user', 'nginx',
      '--mount', `type=bind,source=${fileURLToPath(new URL('./nginx.conf', import.meta.url))},target=/etc/nginx/nginx.conf,readonly`,
      '--entrypoint', 'nginx', 'nginx:1.30.5-alpine', '-g', 'daemon off;');
    const port = docker('port', name, '8080/tcp').trim().split(':').at(-1);
    const base = `http://127.0.0.1:${port}`;
    const headers = { authorization: `Bearer ${canary}`, cookie: `chat_session=${canary}`,
      referer: `${base}/?csrf=${canary}`, 'x-csrf-token': canary, 'x-request-id': canary };
    const page = await fetch(`${base}/index.html?token=${canary}`, { headers });
    assert.equal(page.status, 200);
    await page.arrayBuffer();
    // The alias resolves to this Nginx container, where port 3000 is closed.
    const failure = await fetch(`${base}/api/${canary}?password=${canary}`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ password: canary }),
    });
    assert.equal(failure.status, 502);
    await failure.arrayBuffer();
    docker('stop', '--time', '1', name);
    const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8', timeout: 10000 });
    assert.equal(logs.status, 0);
    assert.equal(`${logs.stdout}${logs.stderr}`.includes(canary), false, 'Request credentials must be absent from stdout and stderr');
    const rows = logs.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(rows.map(row => row.status), ['200', '502']);
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ['method', 'requestId', 'requestTime', 'status', 'upstreamStatus', 'upstreamTime']);
      assert.match(row.requestId, /^[a-f0-9]{32}$/);
      assert.match(row.requestTime, /^\d+\.\d{3}$/);
    }
    assert.equal(rows[1].upstreamStatus, '502');
  } finally {
    spawnSync('docker', ['rm', '--force', name], { stdio: 'ignore', timeout: 10000 });
    docker('network', 'rm', name);
  }
});
