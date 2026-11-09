import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);

  constructor(private readonly prisma: PrismaService) {}

  getHello(): string {
    return 'Hello World!';
  }

  async getHealth() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', database: 'up' as const };
    } catch (error) {
      // Never return raw driver/Prisma text — hosts/credentials can appear in messages.
      const detail =
        error instanceof Error ? error.message : 'database unreachable';
      this.logger.error(`database probe failed: ${detail}`);
      return {
        status: 'degraded' as const,
        database: 'down' as const,
        detail: 'database unreachable',
      };
    }
  }
}
