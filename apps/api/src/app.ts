import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';

export async function createApp(env: NodeJS.ProcessEnv) {
  const config = loadConfig(env);
  const app = await NestFactory.create(AppModule, {
    abortOnError: false,
    logger: config.nodeEnv === 'test' ? false : ['log', 'warn', 'error'],
  });
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  return { app, config };
}
