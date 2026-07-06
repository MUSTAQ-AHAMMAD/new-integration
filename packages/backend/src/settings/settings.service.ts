import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CronTime, validateCronExpression } from 'cron';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

export interface AlertThresholds {
  failureRateThreshold: number;
  latencyThresholdMs: number;
  maxQueueDepth: number;
  alertCooldownMinutes: number;
}

export interface RetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  backoffMultiplier: number;
  maxDelayMs: number;
}

export interface SyncScheduleItem {
  expression: string;
  description: string;
}

export interface SyncSchedule {
  orderSync: SyncScheduleItem;
  retryFailed: SyncScheduleItem;
  healthCheck: SyncScheduleItem;
}

export interface CronValidationResult {
  nextRuns: string[];
}

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private readonly alertThresholdsKey = 'settings:alert-thresholds';
  private readonly retryPolicyKey = 'settings:retry-policy';

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
    const defaults = this.getDefaultAlertThresholds();
    const stored = await this.redis.get(this.alertThresholdsKey);
    if (!stored) {
      return defaults;
    }

    try {
      const parsed: unknown = JSON.parse(stored);
      if (this.isRecord(parsed)) {
        return {
          failureRateThreshold: this.toNumber(
            parsed.failureRateThreshold,
            defaults.failureRateThreshold,
          ),
          latencyThresholdMs: this.toNumber(
            parsed.latencyThresholdMs,
            defaults.latencyThresholdMs,
          ),
          maxQueueDepth: this.toNumber(
            parsed.maxQueueDepth,
            defaults.maxQueueDepth,
          ),
          alertCooldownMinutes: this.toNumber(
            parsed.alertCooldownMinutes,
            defaults.alertCooldownMinutes,
          ),
        };
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to parse alert thresholds from Redis: ${message}`,
      );
    }

    return defaults;
  }

  async updateAlertThresholds(data: AlertThresholds) {
    await this.redis.set(this.alertThresholdsKey, JSON.stringify(data));
    this.logger.log('Alert thresholds updated');
    return this.getAlertThresholds();
  }

  getSyncSchedule(): SyncSchedule {
    return {
      orderSync: {
        expression: this.configService.get<string>(
          'ORDER_SYNC_CRON',
          '*/5 * * * *',
        ),
        description: 'Order synchronization',
      },
      retryFailed: {
        expression: this.configService.get<string>(
          'RETRY_FAILED_CRON',
          '*/15 * * * *',
        ),
        description: 'Retry failed orders',
      },
      healthCheck: {
        expression: this.configService.get<string>(
          'HEALTH_CHECK_CRON',
          '*/5 * * * *',
        ),
        description: 'Health check',
      },
    };
  }

  /**
   * Validates a cron expression and returns the next execution times as ISO
   * strings. Throws BadRequestException when the expression is invalid.
   */
  validateCron(expression: string, count = 3): CronValidationResult {
    const validation = validateCronExpression(expression);
    if (!validation.valid) {
      const message =
        validation.error instanceof Error
          ? validation.error.message
          : 'Invalid cron expression';
      throw new BadRequestException(`Invalid cron expression: ${message}`);
    }

    const cronTime = new CronTime(expression);
    const nextRuns: string[] = [];
    let from = new Date();
    for (let i = 0; i < count; i += 1) {
      const next = cronTime.getNextDateFrom(from);
      const iso = next.toISO();
      // Luxon returns null from toISO() only for an invalid DateTime; the
      // expression is already validated above, so this is defensive — bail
      // out rather than push a null/empty value.
      if (!iso) {
        break;
      }
      nextRuns.push(iso);
      from = next.toJSDate();
    }

    return { nextRuns };
  }

  async getRetryPolicy(): Promise<RetryPolicy> {
    const defaults = this.getDefaultRetryPolicy();
    const stored = await this.redis.get(this.retryPolicyKey);
    if (!stored) {
      return defaults;
    }

    try {
      const parsed: unknown = JSON.parse(stored);
      if (this.isRecord(parsed)) {
        return {
          maxRetries: this.toNumber(parsed.maxRetries, defaults.maxRetries),
          initialDelayMs: this.toNumber(
            parsed.initialDelayMs,
            defaults.initialDelayMs,
          ),
          backoffMultiplier: this.toNumber(
            parsed.backoffMultiplier,
            defaults.backoffMultiplier,
          ),
          maxDelayMs: this.toNumber(parsed.maxDelayMs, defaults.maxDelayMs),
        };
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to parse retry policy from Redis: ${message}`);
    }

    return defaults;
  }

  async updateRetryPolicy(data: RetryPolicy) {
    await this.redis.set(this.retryPolicyKey, JSON.stringify(data));
    this.logger.log('Retry policy updated');
    return this.getRetryPolicy();
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
      .filter(
        (entry): entry is { name: string; value: string } => entry !== null,
      );
  }

  private getDefaultAlertThresholds(): AlertThresholds {
    return {
      failureRateThreshold: this.getNumberConfig(
        'FAILURE_RATE_THRESHOLD',
        0.05,
      ),
      latencyThresholdMs: this.getNumberConfig('LATENCY_THRESHOLD_MS', 3000),
      maxQueueDepth: this.getNumberConfig('MAX_QUEUE_DEPTH', 100),
      alertCooldownMinutes: this.getNumberConfig('ALERT_COOLDOWN_MINUTES', 15),
    };
  }

  private getDefaultRetryPolicy(): RetryPolicy {
    return {
      maxRetries: this.getNumberConfig('MAX_RETRY_ATTEMPTS', 3),
      initialDelayMs: this.getNumberConfig('RETRY_BACKOFF_MS', 5000),
      backoffMultiplier: this.getNumberConfig('RETRY_BACKOFF_MULTIPLIER', 2),
      maxDelayMs: this.getNumberConfig('RETRY_MAX_DELAY_MS', 30000),
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

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}
