import { ConfigService } from '@nestjs/config';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
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

function makePrisma() {
  return {
    notificationRecipient: {
      findMany: jest.fn().mockResolvedValue([makeRecipient()]),
    },
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
  let prisma: ReturnType<typeof makePrisma>;
  let redis: ReturnType<typeof makeRedis>;
  let config: ReturnType<typeof makeConfig>;
  let notifications: ReturnType<typeof makeNotifications>;

  beforeEach(() => {
    prisma = makePrisma();
    redis = makeRedis();
    config = makeConfig();
    notifications = makeNotifications();
    service = new SettingsService(
      prisma as unknown as PrismaService,
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
      expect(result.latencyThreshold).toBeGreaterThan(0);
    });

    it('returns values from Redis when stored', async () => {
      redis.get.mockResolvedValueOnce(
        JSON.stringify({ failureRateThreshold: 0.1, latencyThreshold: 5000 }),
      );
      const result = await service.getAlertThresholds();
      expect(result.failureRateThreshold).toBe(0.1);
      expect(result.latencyThreshold).toBe(5000);
    });

    it('falls back to defaults when Redis returns invalid JSON', async () => {
      redis.get.mockResolvedValueOnce('not-valid-json{{{');
      const result = await service.getAlertThresholds();
      // Should not throw, should return defaults
      expect(result.failureRateThreshold).toBeDefined();
      expect(result.latencyThreshold).toBeDefined();
    });

    it('uses env var overrides for defaults', async () => {
      const svc = new SettingsService(
        prisma as unknown as PrismaService,
        redis as unknown as RedisService,
        makeConfig({ FAILURE_RATE_THRESHOLD: 0.2, LATENCY_THRESHOLD_MS: 8000 }) as unknown as ConfigService,
        notifications as unknown as NotificationsService,
      );
      redis.get.mockResolvedValueOnce(null);
      const result = await svc.getAlertThresholds();
      expect(result.failureRateThreshold).toBe(0.2);
      expect(result.latencyThreshold).toBe(8000);
    });
  });

  // ── updateAlertThresholds ─────────────────────────────────────────────────

  describe('updateAlertThresholds', () => {
    it('writes thresholds to Redis and returns updated values', async () => {
      redis.get.mockResolvedValueOnce(
        JSON.stringify({ failureRateThreshold: 0.15, latencyThreshold: 4000 }),
      );
      const result = await service.updateAlertThresholds({
        failureRateThreshold: 0.15,
        latencyThreshold: 4000,
      });
      expect(redis.set).toHaveBeenCalledWith(
        'settings:alert-thresholds',
        JSON.stringify({ failureRateThreshold: 0.15, latencyThreshold: 4000 }),
      );
      expect(result.failureRateThreshold).toBe(0.15);
      expect(result.latencyThreshold).toBe(4000);
    });
  });

  // ── getSyncSchedule ───────────────────────────────────────────────────────

  describe('getSyncSchedule', () => {
    it('returns schedule config with all keys', () => {
      const schedule = service.getSyncSchedule();
      expect(schedule).toHaveProperty('orderSync');
      expect(schedule).toHaveProperty('inventorySync');
      expect(schedule).toHaveProperty('healthCheck');
      expect(schedule).toHaveProperty('dailyReport');
    });

    it('uses env var overrides when provided', () => {
      const svc = new SettingsService(
        prisma as unknown as PrismaService,
        redis as unknown as RedisService,
        makeConfig({ ORDER_SYNC_CRON: '*/1 * * * *' }) as unknown as ConfigService,
        notifications as unknown as NotificationsService,
      );
      const schedule = svc.getSyncSchedule();
      expect(schedule.orderSync).toBe('*/1 * * * *');
    });
  });

  // ── getRetryPolicy ────────────────────────────────────────────────────────

  describe('getRetryPolicy', () => {
    it('returns retry config with all keys', () => {
      const policy = service.getRetryPolicy();
      expect(policy).toHaveProperty('maxAttempts');
      expect(policy).toHaveProperty('initialBackoffMs');
      expect(policy).toHaveProperty('backoffMultiplier');
      expect(policy).toHaveProperty('strategy');
    });

    it('uses env var for maxAttempts when configured', () => {
      const svc = new SettingsService(
        prisma as unknown as PrismaService,
        redis as unknown as RedisService,
        makeConfig({ MAX_RETRY_ATTEMPTS: 5 }) as unknown as ConfigService,
        notifications as unknown as NotificationsService,
      );
      expect(svc.getRetryPolicy().maxAttempts).toBe(5);
    });
  });

  // ── listApiKeys ───────────────────────────────────────────────────────────

  describe('listApiKeys', () => {
    it('returns only keys that are set in config', () => {
      const svc = new SettingsService(
        prisma as unknown as PrismaService,
        redis as unknown as RedisService,
        makeConfig({ ODOO_PASSWORD: 'supersecret123' }) as unknown as ConfigService,
        notifications as unknown as NotificationsService,
      );
      const keys = svc.listApiKeys();
      expect(keys.length).toBeGreaterThanOrEqual(1);
      const odooKey = keys.find((k) => k.name === 'ODOO_PASSWORD');
      expect(odooKey).toBeDefined();
    });

    it('masks the value and does not expose the raw secret', () => {
      const svc = new SettingsService(
        prisma as unknown as PrismaService,
        redis as unknown as RedisService,
        makeConfig({ ODOO_PASSWORD: 'supersecret123' }) as unknown as ConfigService,
        notifications as unknown as NotificationsService,
      );
      const keys = svc.listApiKeys();
      const odooKey = keys.find((k) => k.name === 'ODOO_PASSWORD');
      expect(odooKey?.value).not.toBe('supersecret123');
      expect(odooKey?.value).toContain('*');
    });

    it('returns empty array when no configured secrets are found', () => {
      const svc = new SettingsService(
        prisma as unknown as PrismaService,
        redis as unknown as RedisService,
        makeConfig({}) as unknown as ConfigService,
        notifications as unknown as NotificationsService,
      );
      expect(svc.listApiKeys()).toHaveLength(0);
    });

    it('masks short values (≤6 chars) entirely with asterisks', () => {
      const svc = new SettingsService(
        prisma as unknown as PrismaService,
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
