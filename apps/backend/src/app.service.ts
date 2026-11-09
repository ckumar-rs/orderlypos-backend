import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';

@Injectable()
export class AppService {
  constructor(private readonly prisma: PrismaService) {}

  getHello(): string {
    return 'Hello World!';
  }

  async getHealth() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', database: 'up' as const };
    } catch (error) {
      return {
        status: 'degraded' as const,
        database: 'down' as const,
        detail: error instanceof Error ? error.message : 'database unreachable',
      };
    }
  }
}
