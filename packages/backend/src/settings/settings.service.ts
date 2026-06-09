import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

export interface AlertThresholds {
  failureRateThreshold: number;
  latencyThreshold: number;
}

interface StoredAlertThresholds {
  failureRateThreshold?: unknown;
  latencyThreshold?: unknown;
}

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private readonly alertThresholdsKey = 'settings:alert-thresholds';

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly configService: ConfigService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async getSettings() {
    const recipients = await this.prisma.notificationRecipient.findMany({
      orderBy: { name: 'asc' },
    });

    return {
      recipients,
      alertThresholds: await this.getAlertThresholds(),
      notificationsEnabled:
        (await this.notificationsService.getErrorAlertRecipients()).length > 0,
    };
  }

  async getAlertThresholds(): Promise<AlertThresholds> {
    const stored = await this.redis.get(this.alertThresholdsKey);
    if (!stored) {
      return this.getDefaultAlertThresholds();
    }

    try {
      const parsed: unknown = JSON.parse(stored);
      if (this.isStoredThresholds(parsed)) {
        return {
          failureRateThreshold: this.toNumber(
            parsed.failureRateThreshold,
            this.getDefaultAlertThresholds().failureRateThreshold,
          ),
          latencyThreshold: this.toNumber(
            parsed.latencyThreshold,
            this.getDefaultAlertThresholds().latencyThreshold,
          ),
        };
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to parse alert thresholds from Redis: ${message}`);
    }

    return this.getDefaultAlertThresholds();
  }

  async updateAlertThresholds(data: AlertThresholds) {
    await this.redis.set(this.alertThresholdsKey, JSON.stringify(data));
    this.logger.log('Alert thresholds updated');
    return this.getAlertThresholds();
  }

  getSyncSchedule() {
    return {
      orderSync: this.configService.get<string>('ORDER_SYNC_CRON', '*/5 * * * *'),
      inventorySync: this.configService.get<string>(
        'INVENTORY_SYNC_CRON',
        '*/10 * * * *',
      ),
      healthCheck: this.configService.get<string>(
        'HEALTH_CHECK_CRON',
        '*/5 * * * *',
      ),
      dailyReport: this.configService.get<string>(
        'DAILY_REPORT_CRON',
        '0 6 * * *',
      ),
    };
  }

  getRetryPolicy() {
    return {
      maxAttempts: this.getNumberConfig('MAX_RETRY_ATTEMPTS', 3),
      initialBackoffMs: this.getNumberConfig('RETRY_BACKOFF_MS', 5000),
      backoffMultiplier: this.getNumberConfig(
        'RETRY_BACKOFF_MULTIPLIER',
        2,
      ),
      strategy: this.configService.get<string>('RETRY_STRATEGY', 'exponential'),
    };
  }

  listApiKeys() {
    const candidates = [
      'ODOO_PASSWORD',
      'ORACLE_PASSWORD',
      'SMTP_PASS',
      'JWT_SECRET',
    ];

    return candidates
      .map((name) => {
        const value = this.configService.get<string>(name);
        return value
          ? {
              name,
              value: this.maskValue(value),
            }
          : null;
      })
      .filter((entry): entry is { name: string; value: string } => entry !== null);
  }

  private getDefaultAlertThresholds(): AlertThresholds {
    return {
      failureRateThreshold: this.getNumberConfig(
        'FAILURE_RATE_THRESHOLD',
        0.05,
      ),
      latencyThreshold: this.getNumberConfig('LATENCY_THRESHOLD_MS', 3000),
    };
  }

  private getNumberConfig(key: string, fallback: number): number {
    const value = this.configService.get<string | number>(key);
    return this.toNumber(value, fallback);
  }

  private toNumber(value: unknown, fallback: number): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    }

    return fallback;
  }

  private maskValue(value: string): string {
    if (value.length <= 6) {
      return '*'.repeat(value.length);
    }

    return `${value.slice(0, 3)}${'*'.repeat(Math.max(4, value.length - 5))}${value.slice(-2)}`;
  }

  private isStoredThresholds(value: unknown): value is StoredAlertThresholds {
    return typeof value === 'object' && value !== null;
  }
}
