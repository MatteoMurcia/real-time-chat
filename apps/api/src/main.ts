import { createApp } from './app.js';
import { installShutdownHandlers } from './shutdown/shutdown.js';

try {
  const { app, config } = await createApp(process.env);
  try {
    await app.listen(config.port, config.host);
    installShutdownHandlers(app);
  } catch (error) {
    await app.close();
    throw error;
  }
} catch (error) {
  console.error('API startup failed:', error instanceof Error ? error.message : 'Unknown error');
  process.exitCode = 1;
}
