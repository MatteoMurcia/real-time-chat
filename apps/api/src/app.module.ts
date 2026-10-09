import { Module, type DynamicModule } from '@nestjs/common';
import { LiveController } from './health/live.controller.js';
import { DatabaseService } from './database/database.service.js';
import { APP_FILTER } from '@nestjs/core';
import { ErrorFilter } from './http/error.filter.js';
import { RegistrationController } from './identity/registration.controller.js';
import { RegistrationService } from './identity/registration.service.js';
import { CsrfService } from './identity/csrf.service.js';
import { SessionController } from './identity/session.controller.js';
import { SessionService } from './identity/session.service.js';

@Module({
  controllers: [LiveController, RegistrationController, SessionController],
  providers: [{ provide: APP_FILTER, useClass: ErrorFilter }],
})
export class AppModule {
  static register(databaseUrl: string, appOrigin: string, sessionTtlSeconds: number): DynamicModule {
    return {
      module: AppModule,
      providers: [
        { provide: DatabaseService, useFactory: () => new DatabaseService(databaseUrl) },
        { provide: CsrfService, useFactory: () => new CsrfService(appOrigin) },
        RegistrationService,
        { provide: SessionService, inject: [DatabaseService], useFactory: (db: DatabaseService) => new SessionService(db, appOrigin, sessionTtlSeconds) },
      ],
      exports: [DatabaseService],
    };
  }
}
