import { mock } from 'node:test';
import { createApp } from '../../src/app.js';
import { SendMessageService } from '../../src/messaging/send-message.service.js';
import { installShutdownHandlers } from '../../src/shutdown/shutdown.js';

try {
  const { app } = await createApp(process.env);
  // Faults exist only in this test entrypoint, never as production environment switches.
  if (process.argv[2] === 'stall') mock.method(app.get(SendMessageService), 'send', async () => {
    process.send?.({ event: 'send-held' }); await new Promise(() => {}); throw new Error('unreachable');
  });
  if (process.argv[2] === 'leak') setInterval(() => {}, 1000);
  await app.listen(0, '127.0.0.1'); installShutdownHandlers(app);
  process.send?.({ event: 'listening', url: await app.getUrl() });
} catch {
  process.stderr.write('Shutdown fixture startup failed\n'); process.exit(1);
}
