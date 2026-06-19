import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { HealthStatus, ServiceName } from '@prisma/client';
import { GatewayService } from '../gateway/gateway.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { OracleSoapClient } from '../clients/oracle/oracle-soap.client';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly gateway: GatewayService,
    private readonly oracleSoap: OracleSoapClient,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async runHealthChecks() {
    await Promise.allSettled([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkOracle(),
    ]);
  }

  private async checkService(
    serviceName: ServiceName,
    checkFn: () => Promise<void>,
  ) {
    const start = Date.now();
    try {
      await checkFn();
      const responseTimeMs = Date.now() - start;
      await this.prisma.integrationHealthCheck.create({
        data: {
          serviceName,
          status: HealthStatus.HEALTHY,
          responseTimeMs,
          lastSuccessAt: new Date(),
          consecutiveFailures: 0,
        },
      });
      this.gateway.emitHealthUpdate({
        service: serviceName,
        status: HealthStatus.HEALTHY,
      });
    } catch (err) {
      const responseTimeMs = Date.now() - start;
      const failureReason =
        err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(
        `Health check failed for ${serviceName}: ${failureReason}`,
      );

      // Retrieve the current consecutive-failure count so we can increment it.
      const lastCheck = await this.prisma.integrationHealthCheck
        .findFirst({
          where: { serviceName },
          orderBy: { createdAt: 'desc' },
          select: { consecutiveFailures: true },
        })
        .catch(() => null);

      const consecutiveFailures = (lastCheck?.consecutiveFailures ?? 0) + 1;

      await this.prisma.integrationHealthCheck
        .create({
          data: {
            serviceName,
            status: HealthStatus.UNHEALTHY,
            responseTimeMs,
            lastSuccessAt: new Date(0),
            lastFailureAt: new Date(),
            failureReason,
            consecutiveFailures,
          },
        })
        .catch(() => undefined);
      this.gateway.emitHealthUpdate({
        service: serviceName,
        status: HealthStatus.UNHEALTHY,
      });
    }
  }

  private checkDatabase() {
    return this.checkService(ServiceName.DATABASE, async () => {
      await this.prisma.$queryRaw`SELECT 1`;
    });
  }

  private checkRedis() {
    return this.checkService(ServiceName.REDIS, async () => {
      await this.redis.ping();
    });
  }

  private checkOracle() {
    return this.checkService(ServiceName.ORACLE_SOAP, async () => {
      await this.oracleSoap.ping();
    });
  }
}
