import { Module } from '@nestjs/common';
import { LiveController } from './health/live.controller.js';

@Module({ controllers: [LiveController] })
export class AppModule {}
