import { Module, type DynamicModule } from '@nestjs/common';
import { LiveController } from './health/live.controller.js';
import { DatabaseService } from './database/database.service.js';

@Module({ controllers: [LiveController] })
export class AppModule {
  static register(databaseUrl: string): DynamicModule {
    return {
      module: AppModule,
      providers: [{ provide: DatabaseService, useFactory: () => new DatabaseService(databaseUrl) }],
      exports: [DatabaseService],
    };
  }
}
