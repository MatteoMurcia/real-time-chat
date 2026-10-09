import { Module, type DynamicModule } from '@nestjs/common';
import { LiveController } from './health/live.controller.js';
import { DatabaseService } from './database/database.service.js';
import { APP_FILTER } from '@nestjs/core';
import { ErrorFilter } from './http/error.filter.js';
import { RegistrationController } from './identity/registration.controller.js';
import { RegistrationService } from './identity/registration.service.js';
import { CsrfService } from './identity/csrf.service.js';

@Module({
  controllers: [LiveController, RegistrationController],
  providers: [{ provide: APP_FILTER, useClass: ErrorFilter }],
})
export class AppModule {
  static register(databaseUrl: string, appOrigin: string): DynamicModule {
    return {
      module: AppModule,
      providers: [
        { provide: DatabaseService, useFactory: () => new DatabaseService(databaseUrl) },
        { provide: CsrfService, useFactory: () => new CsrfService(appOrigin) },
        RegistrationService,
      ],
      exports: [DatabaseService],
    };
  }
}
