import { Module, type DynamicModule } from '@nestjs/common';
import { LiveController } from './health/live.controller.js';
import { ReadyController } from './health/ready.controller.js';
import { DatabaseService } from './database/database.service.js';
import { APP_FILTER } from '@nestjs/core';
import { ErrorFilter } from './http/error.filter.js';
import { RegistrationController } from './identity/registration.controller.js';
import { RegistrationService } from './identity/registration.service.js';
import { CsrfService } from './identity/csrf.service.js';
import { SessionController } from './identity/session.controller.js';
import { SessionService } from './identity/session.service.js';
import { ChatGateway } from './realtime/chat.gateway.js';
import { ChannelsController } from './channels/channels.controller.js';
import { ChannelsService } from './channels/channels.service.js';
import { ChannelAccessService } from './channels/channel-access.service.js';
import { ConnectionsService } from './realtime/connections.service.js';
import { SendMessageService } from './messaging/send-message.service.js';
import { HistoryService } from './messaging/history.service.js';
import { HistoryController } from './messaging/history.controller.js';
import { SyncService } from './messaging/sync.service.js';
import { RateLimitService } from './security/rate-limit.service.js';
import type { TrafficLimits } from './config.js';
import { ShutdownState } from './shutdown/shutdown-state.js';

@Module({
  controllers: [LiveController, ReadyController, RegistrationController, SessionController, ChannelsController, HistoryController],
  providers: [{ provide: APP_FILTER, useClass: ErrorFilter }],
})
export class AppModule {
  static register(databaseUrl: string, appOrigin: string, sessionTtlSeconds: number, trafficLimits: TrafficLimits): DynamicModule {
    return {
      module: AppModule,
      providers: [
        ShutdownState,
        { provide: 'APP_ORIGIN', useValue: appOrigin },
        { provide: RateLimitService, useFactory: () => new RateLimitService(trafficLimits) },
        ChatGateway,
        ConnectionsService,
        SendMessageService,
        HistoryService,
        SyncService,
        { provide: DatabaseService, useFactory: () => new DatabaseService(databaseUrl) },
        { provide: CsrfService, useFactory: () => new CsrfService(appOrigin) },
        RegistrationService,
        ChannelsService,
        ChannelAccessService,
        { provide: SessionService, inject: [DatabaseService], useFactory: (db: DatabaseService) => new SessionService(db, appOrigin, sessionTtlSeconds) },
      ],
      exports: [DatabaseService],
    };
  }
}
