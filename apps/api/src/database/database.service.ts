import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

export class DatabaseService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly readiness: PrismaClient;

  constructor(databaseUrl: string) {
    super({ adapter: new PrismaPg({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 }) });
    // A separate, single-connection probe bounds failure without shortening chat transactions.
    this.readiness = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl,
      max: 1, connectionTimeoutMillis: 1000, query_timeout: 1000, statement_timeout: 1000, idleTimeoutMillis: 1000,
    }) });
  }

  async checkReady(): Promise<void> {
    await this.readiness.$queryRaw`SELECT 1`;
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
      await this.$queryRaw`SELECT 1`;
    } catch {
      await this.$disconnect();
      throw new Error('Database connection failed');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.$disconnect(), this.readiness.$disconnect()]);
  }
}
