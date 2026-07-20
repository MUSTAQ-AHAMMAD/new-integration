import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { NotificationRecipient } from '../database/entities/notification-recipient.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { RedisService } from '../redis/redis.service';
import { SettingsService } from './settings.service';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeRecipient(overrides: Record<string, unknown> = {}) {
  return {
    id: 'recip-001',
    name: 'Alice',
    email: 'alice@example.com',
    isActive: true,
    receiveErrorAlerts: true,
    ...overrides,
  };
}

function makeRecipientsRepo() {
  return {
    find: jest.fn().mockResolvedValue([makeRecipient()]),
  };
}

function makeRedis() {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  };
}

function makeConfig(env: Record<string, string | number> = {}) {
  return {
    get: jest.fn().mockImplementation((key: string, fallback?: unknown) => {
      return (env as Record<string, unknown>)[key] ?? fallback;
    }),
  };
}

function makeNotifications() {
  return {
    getErrorAlertRecipients: jest.fn().mockResolvedValue([]),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SettingsService', () => {
  let service: SettingsService;
  let recipients: ReturnType<typeof makeRecipientsRepo>;
  let redis: ReturnType<typeof makeRedis>;
  let config: ReturnType<typeof makeConfig>;
  let notifications: ReturnType<typeof makeNotifications>;

  beforeEach(() => {
    recipients = makeRecipientsRepo();
    redis = makeRedis();
    config = makeConfig();
    notifications = makeNotifications();
    service = new SettingsService(
      recipients as unknown as Repository<NotificationRecipient>,
      redis as unknown as RedisService,
      config as unknown as ConfigService,
      notifications as unknown as NotificationsService,
    );
    jest.clearAllMocks();
  });

  // ── getSettings ──────────────────────────────────────────────────────────

  describe('getSettings', () => {
    it('returns recipients, alertThresholds and notificationsEnabled', async () => {
      const result = await service.getSettings();
      expect(result.recipients).toHaveLength(1);
      expect(result.alertThresholds).toBeDefined();
      expect(typeof result.notificationsEnabled).toBe('boolean');
    });

    it('notificationsEnabled is true when error alert recipients exist', async () => {
      notifications.getErrorAlertRecipients.mockResolvedValueOnce([
        'alice@example.com',
      ]);
      const result = await service.getSettings();
      expect(result.notificationsEnabled).toBe(true);
    });

    it('notificationsEnabled is false when no error alert recipients', async () => {
      notifications.getErrorAlertRecipients.mockResolvedValueOnce([]);
      const result = await service.getSettings();
      expect(result.notificationsEnabled).toBe(false);
    });
  });

  // ── getAlertThresholds ───────────────────────────────────────────────────

  describe('getAlertThresholds', () => {
    it('returns defaults when Redis has no stored value', async () => {
      redis.get.mockResolvedValueOnce(null);
      const result = await service.getAlertThresholds();
      expect(result.failureRateThreshold).toBeGreaterThan(0);
      expect(result.latencyThresholdMs).toBeGreaterThan(0);
      expect(result.maxQueueDepth).toBeGreaterThan(0);
      expect(result.alertCooldownMinutes).toBeGreaterThan(0);
    });

    it('returns values from Redis when stored', async () => {
      redis.get.mockResolvedValueOnce(
        JSON.stringify({
          failureRateThreshold: 0.1,
          latencyThresholdMs: 5000,
          maxQueueDepth: 200,
          alertCooldownMinutes: 30,
        }),
      );
      const result = await service.getAlertThresholds();
      expect(result.failureRateThreshold).toBe(0.1);
      expect(result.latencyThresholdMs).toBe(5000);
      expect(result.maxQueueDepth).toBe(200);
      expect(result.alertCooldownMinutes).toBe(30);
    });

    it('falls back to defaults when Redis returns invalid JSON', async () => {
      redis.get.mockResolvedValueOnce('not-valid-json{{{');
      const result = await service.getAlertThresholds();
      // Should not throw, should return defaults
      expect(result.failureRateThreshold).toBeDefined();
      expect(result.latencyThresholdMs).toBeDefined();
      expect(result.maxQueueDepth).toBeDefined();
      expect(result.alertCooldownMinutes).toBeDefined();
    });

    it('uses env var overrides for defaults', async () => {
      const svc = new SettingsService(
        recipients as unknown as Repository<NotificationRecipient>,
        redis as unknown as RedisService,
        makeConfig({
          FAILURE_RATE_THRESHOLD: 0.2,
          LATENCY_THRESHOLD_MS: 8000,
          MAX_QUEUE_DEPTH: 250,
          ALERT_COOLDOWN_MINUTES: 45,
        }) as unknown as ConfigService,
        notifications as unknown as NotificationsService,
      );
      redis.get.mockResolvedValueOnce(null);
      const result = await svc.getAlertThresholds();
      expect(result.failureRateThreshold).toBe(0.2);
      expect(result.latencyThresholdMs).toBe(8000);
      expect(result.maxQueueDepth).toBe(250);
      expect(result.alertCooldownMinutes).toBe(45);
    });
  });

  // ── updateAlertThresholds ─────────────────────────────────────────────────

  describe('updateAlertThresholds', () => {
    it('writes thresholds to Redis and returns updated values', async () => {
      const payload = {
        failureRateThreshold: 0.15,
        latencyThresholdMs: 4000,
        maxQueueDepth: 150,
        alertCooldownMinutes: 20,
      };
      redis.get.mockResolvedValueOnce(JSON.stringify(payload));
      const result = await service.updateAlertThresholds(payload);
      expect(redis.set).toHaveBeenCalledWith(
        'settings:alert-thresholds',
        JSON.stringify(payload),
      );
      expect(result.failureRateThreshold).toBe(0.15);
      expect(result.latencyThresholdMs).toBe(4000);
      expect(result.maxQueueDepth).toBe(150);
      expect(result.alertCooldownMinutes).toBe(20);
    });
  });

  // ── getSyncSchedule ───────────────────────────────────────────────────────

  describe('getSyncSchedule', () => {
    it('returns schedule config with all keys', () => {
      const schedule = service.getSyncSchedule();
      expect(schedule).toHaveProperty('orderSync');
      expect(schedule).toHaveProperty('retryFailed');
      expect(schedule).toHaveProperty('healthCheck');
      expect(schedule.orderSync).toHaveProperty('expression');
      expect(schedule.orderSync).toHaveProperty('description');
    });

    it('uses env var overrides when provided', () => {
      const svc = new SettingsService(
        recipients as unknown as Repository<NotificationRecipient>,
        redis as unknown as RedisService,
        makeConfig({
          ORDER_SYNC_CRON: '*/1 * * * *',
        }) as unknown as ConfigService,
        notifications as unknown as NotificationsService,
      );
      const schedule = svc.getSyncSchedule();
      expect(schedule.orderSync.expression).toBe('*/1 * * * *');
    });
  });

  // ── validateCron ──────────────────────────────────────────────────────────

  describe('validateCron', () => {
    it('returns the requested number of upcoming ISO run times', () => {
      const result = service.validateCron('*/5 * * * *');
      expect(result.nextRuns).toHaveLength(3);
      result.nextRuns.forEach((run) => {
        expect(Number.isNaN(Date.parse(run))).toBe(false);
      });
    });

    it('throws BadRequestException for an invalid cron expression', () => {
      expect(() => service.validateCron('not-a-cron')).toThrow();
    });
  });

  // ── getRetryPolicy ────────────────────────────────────────────────────────

  describe('getRetryPolicy', () => {
    it('returns retry config with all keys', async () => {
      redis.get.mockResolvedValueOnce(null);
      const policy = await service.getRetryPolicy();
      expect(policy).toHaveProperty('maxRetries');
      expect(policy).toHaveProperty('initialDelayMs');
      expect(policy).toHaveProperty('backoffMultiplier');
      expect(policy).toHaveProperty('maxDelayMs');
    });

    it('uses env var for maxRetries when configured', async () => {
      const svc = new SettingsService(
        recipients as unknown as Repository<NotificationRecipient>,
        redis as unknown as RedisService,
        makeConfig({ MAX_RETRY_ATTEMPTS: 5 }) as unknown as ConfigService,
        notifications as unknown as NotificationsService,
      );
      redis.get.mockResolvedValueOnce(null);
      expect((await svc.getRetryPolicy()).maxRetries).toBe(5);
    });

    it('returns values from Redis when stored', async () => {
      redis.get.mockResolvedValueOnce(
        JSON.stringify({
          maxRetries: 7,
          initialDelayMs: 1234,
          backoffMultiplier: 3,
          maxDelayMs: 60000,
        }),
      );
      const policy = await service.getRetryPolicy();
      expect(policy.maxRetries).toBe(7);
      expect(policy.initialDelayMs).toBe(1234);
      expect(policy.backoffMultiplier).toBe(3);
      expect(policy.maxDelayMs).toBe(60000);
    });
  });

  // ── updateRetryPolicy ─────────────────────────────────────────────────────

  describe('updateRetryPolicy', () => {
    it('writes retry policy to Redis and returns updated values', async () => {
      const payload = {
        maxRetries: 4,
        initialDelayMs: 2000,
        backoffMultiplier: 2,
        maxDelayMs: 20000,
      };
      redis.get.mockResolvedValueOnce(JSON.stringify(payload));
      const result = await service.updateRetryPolicy(payload);
      expect(redis.set).toHaveBeenCalledWith(
        'settings:retry-policy',
        JSON.stringify(payload),
      );
      expect(result.maxRetries).toBe(4);
      expect(result.maxDelayMs).toBe(20000);
    });
  });

  // ── listApiKeys ───────────────────────────────────────────────────────────

  describe('listApiKeys', () => {
    it('returns only keys that are set in config', () => {
      const svc = new SettingsService(
        recipients as unknown as Repository<NotificationRecipient>,
        redis as unknown as RedisService,
        makeConfig({
          ODOO_PASSWORD: 'supersecret123',
        }) as unknown as ConfigService,
        notifications as unknown as NotificationsService,
      );
      const keys = svc.listApiKeys();
      expect(keys.length).toBeGreaterThanOrEqual(1);
      const odooKey = keys.find((k) => k.name === 'ODOO_PASSWORD');
      expect(odooKey).toBeDefined();
    });

    it('masks the value and does not expose the raw secret', () => {
      const svc = new SettingsService(
        recipients as unknown as Repository<NotificationRecipient>,
        redis as unknown as RedisService,
        makeConfig({
          ODOO_PASSWORD: 'supersecret123',
        }) as unknown as ConfigService,
        notifications as unknown as NotificationsService,
      );
      const keys = svc.listApiKeys();
      const odooKey = keys.find((k) => k.name === 'ODOO_PASSWORD');
      expect(odooKey?.value).not.toBe('supersecret123');
      expect(odooKey?.value).toContain('*');
    });

    it('returns empty array when no configured secrets are found', () => {
      const svc = new SettingsService(
        recipients as unknown as Repository<NotificationRecipient>,
        redis as unknown as RedisService,
        makeConfig({}) as unknown as ConfigService,
        notifications as unknown as NotificationsService,
      );
      expect(svc.listApiKeys()).toHaveLength(0);
    });

    it('masks short values (≤6 chars) entirely with asterisks', () => {
      const svc = new SettingsService(
        recipients as unknown as Repository<NotificationRecipient>,
        redis as unknown as RedisService,
        makeConfig({ ODOO_PASSWORD: 'abc' }) as unknown as ConfigService,
        notifications as unknown as NotificationsService,
      );
      const keys = svc.listApiKeys();
      const odooKey = keys.find((k) => k.name === 'ODOO_PASSWORD');
      expect(odooKey?.value).toBe('***');
    });
  });
});
