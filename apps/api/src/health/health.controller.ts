import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import type { HealthResponse } from '@chatflow/types';
import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('health')
  async getHealth(): Promise<HealthResponse> {
    const databaseUp = await this.isDatabaseUp();
    const health: HealthResponse = {
      status: databaseUp ? 'ok' : 'error',
      service: 'api',
      timestamp: new Date().toISOString(),
      database: databaseUp ? 'up' : 'down',
    };

    if (!databaseUp) {
      throw new ServiceUnavailableException(health);
    }

    return health;
  }

  private async isDatabaseUp(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
