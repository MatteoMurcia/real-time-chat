import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PayloadTooLargeException } from '@nestjs/common';
import type { ErrorRequestHandler } from 'express';

export async function createApp(env: NodeJS.ProcessEnv) {
  const config = loadConfig(env);
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config.databaseUrl, config.appOrigin), {
    abortOnError: false,
    bodyParser: false,
    logger: config.nodeEnv === 'test' ? false : ['log', 'warn', 'error'],
  });
  app.useBodyParser('json', { limit: '8kb' });
  const parserErrors: ErrorRequestHandler = (error: unknown, _request, _response, next) => {
    next(error instanceof Error && 'type' in error && error.type === 'entity.too.large'
      ? new PayloadTooLargeException() : error);
  };
  app.use(parserErrors);
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  return { app, config };
}
