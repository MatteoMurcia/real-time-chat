import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

export class DatabaseService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(databaseUrl: string) {
    super({ adapter: new PrismaPg({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 }) });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
    } catch {
      await this.$disconnect();
      throw new Error('Database connection failed');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
