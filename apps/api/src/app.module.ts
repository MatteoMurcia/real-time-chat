import { Module, type DynamicModule } from '@nestjs/common';
import { LiveController } from './health/live.controller.js';
import { DatabaseService } from './database/database.service.js';
import { APP_FILTER } from '@nestjs/core';
import { ErrorFilter } from './http/error.filter.js';

@Module({
  controllers: [LiveController],
  providers: [{ provide: APP_FILTER, useClass: ErrorFilter }],
})
export class AppModule {
  static register(databaseUrl: string): DynamicModule {
    return {
      module: AppModule,
      providers: [{ provide: DatabaseService, useFactory: () => new DatabaseService(databaseUrl) }],
      exports: [DatabaseService],
    };
  }
}
