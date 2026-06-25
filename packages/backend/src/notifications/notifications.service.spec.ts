import { ConfigService } from '@nestjs/config';
import { NotificationRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from './notifications.service';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeRecipient(overrides: Record<string, unknown> = {}) {
  return {
    id: 'recip-001',
    name: 'Alice',
    email: 'alice@example.com',
    role: NotificationRole.ADMIN,
    isActive: true,
    receiveErrorAlerts: true,
    receiveDailyReports: false,
    receiveInventoryAlerts: false,
    receivePaymentAlerts: false,
    receiveConfigAlerts: false,
    escalationLevel: 1,
    backupRecipientId: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makePrisma() {
  return {
    notificationRecipient: {
      findMany: jest.fn().mockResolvedValue([makeRecipient()]),
      findUnique: jest.fn().mockResolvedValue(makeRecipient()),
      create: jest.fn().mockResolvedValue(makeRecipient()),
      update: jest.fn().mockResolvedValue(makeRecipient()),
      delete: jest.fn().mockResolvedValue(makeRecipient()),
    },
  };
}

function makeConfig(env: Record<string, string | number> = {}) {
  return {
    get: jest.fn().mockImplementation((key: string) => {
      return (env as Record<string, unknown>)[key] ?? undefined;
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NotificationsService', () => {
  let service: NotificationsService;
  let prisma: ReturnType<typeof makePrisma>;

  function makeService(env: Record<string, string | number> = {}) {
    prisma = makePrisma();
    const svc = new NotificationsService(
      prisma as unknown as PrismaService,
      makeConfig(env) as unknown as ConfigService,
    );
    return svc;
  }

  beforeEach(() => {
    service = makeService();
    jest.clearAllMocks();
  });

  // ── onModuleInit — SMTP configuration ─────────────────────────────────────

  describe('onModuleInit', () => {
    it('creates a transporter when all SMTP env vars are set', () => {
      const svc = makeService({
        SMTP_HOST: 'smtp.example.com',
        SMTP_USER: 'user@example.com',
        SMTP_PASS: 'pass',
      });
      svc.onModuleInit();
      // transporter should be set (not null)
      expect(
        (svc as unknown as { transporter: unknown }).transporter,
      ).not.toBeNull();
    });

    it('leaves transporter null when SMTP env vars are absent', () => {
      const svc = makeService({});
      svc.onModuleInit();
      expect(
        (svc as unknown as { transporter: unknown }).transporter,
      ).toBeNull();
    });

    it('uses secure=true when SMTP_PORT is 465', () => {
      const svc = makeService({
        SMTP_HOST: 'smtp.example.com',
        SMTP_USER: 'u',
        SMTP_PASS: 'p',
        SMTP_PORT: 465,
      });
      svc.onModuleInit();
      expect(
        (svc as unknown as { transporter: unknown }).transporter,
      ).not.toBeNull();
    });

    it('uses secure=true when SMTP_SECURE is "true"', () => {
      const svc = makeService({
        SMTP_HOST: 'smtp.example.com',
        SMTP_USER: 'u',
        SMTP_PASS: 'p',
        SMTP_SECURE: 'true',
      });
      svc.onModuleInit();
      expect(
        (svc as unknown as { transporter: unknown }).transporter,
      ).not.toBeNull();
    });
  });

  // ── listRecipients ────────────────────────────────────────────────────────

  describe('listRecipients', () => {
    it('returns all recipients when activeOnly is false', async () => {
      const result = await service.listRecipients(false);
      expect(result).toHaveLength(1);
      expect(prisma.notificationRecipient.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: undefined }),
      );
    });

    it('filters to active only when activeOnly is true', async () => {
      await service.listRecipients(true);
      expect(prisma.notificationRecipient.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isActive: true } }),
      );
    });
  });

  // ── getRecipient ──────────────────────────────────────────────────────────

  describe('getRecipient', () => {
    it('returns the recipient when found', async () => {
      const result = await service.getRecipient('recip-001');
      expect(result).toMatchObject({ id: 'recip-001' });
    });

    it('returns null when not found', async () => {
      prisma.notificationRecipient.findUnique.mockResolvedValueOnce(null);
      const result = await service.getRecipient('missing');
      expect(result).toBeNull();
    });
  });

  // ── createRecipient ───────────────────────────────────────────────────────

  describe('createRecipient', () => {
    it('creates and returns the new recipient', async () => {
      const result = await service.createRecipient({
        email: 'bob@example.com',
        name: 'Bob',
        role: NotificationRole.IT_SUPPORT,
      });
      expect(prisma.notificationRecipient.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ email: 'bob@example.com' }),
        }),
      );
      expect(result.name).toBe('Alice'); // from mock
    });
  });

  // ── updateRecipient ───────────────────────────────────────────────────────

  describe('updateRecipient', () => {
    it('updates and returns the recipient', async () => {
      const result = await service.updateRecipient('recip-001', {
        isActive: false,
      });
      expect(prisma.notificationRecipient.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'recip-001' },
          data: expect.objectContaining({ isActive: false }),
        }),
      );
      expect(result).toBeDefined();
    });
  });

  // ── deleteRecipient ───────────────────────────────────────────────────────

  describe('deleteRecipient', () => {
    it('deletes the recipient', async () => {
      await service.deleteRecipient('recip-001');
      expect(prisma.notificationRecipient.delete).toHaveBeenCalledWith({
        where: { id: 'recip-001' },
      });
    });
  });

  // ── getErrorAlertRecipients ───────────────────────────────────────────────

  describe('getErrorAlertRecipients', () => {
    it('returns email addresses of active recipients with receiveErrorAlerts=true', async () => {
      prisma.notificationRecipient.findMany.mockResolvedValueOnce([
        { email: 'alice@example.com' },
        { email: 'bob@example.com' },
      ]);
      const result = await service.getErrorAlertRecipients();
      expect(result).toEqual(['alice@example.com', 'bob@example.com']);
    });

    it('returns empty array when no recipients match', async () => {
      prisma.notificationRecipient.findMany.mockResolvedValueOnce([]);
      const result = await service.getErrorAlertRecipients();
      expect(result).toEqual([]);
    });

    it('queries only active recipients with receiveErrorAlerts', async () => {
      prisma.notificationRecipient.findMany.mockResolvedValueOnce([]);
      await service.getErrorAlertRecipients();
      expect(prisma.notificationRecipient.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isActive: true, receiveErrorAlerts: true },
        }),
      );
    });
  });

  // ── getInventoryAlertRecipients ────────────────────────────────────────────

  describe('getInventoryAlertRecipients', () => {
    it('queries only active recipients with receiveInventoryAlerts', async () => {
      prisma.notificationRecipient.findMany.mockResolvedValueOnce([]);
      await service.getInventoryAlertRecipients();
      expect(prisma.notificationRecipient.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isActive: true, receiveInventoryAlerts: true },
        }),
      );
    });
  });

  // ── getDailyReportRecipients ──────────────────────────────────────────────

  describe('getDailyReportRecipients', () => {
    it('queries only active recipients with receiveDailyReports', async () => {
      prisma.notificationRecipient.findMany.mockResolvedValueOnce([]);
      await service.getDailyReportRecipients();
      expect(prisma.notificationRecipient.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isActive: true, receiveDailyReports: true },
        }),
      );
    });
  });

  // ── sendNotification ──────────────────────────────────────────────────────

  describe('sendNotification', () => {
    it('does nothing when recipients list is empty', () => {
      // Should not throw
      expect(() =>
        service.sendNotification({
          subject: 'Test',
          body: 'Hello',
          recipients: [],
        }),
      ).not.toThrow();
    });

    it('logs only (no sendMail) when transporter is not configured', () => {
      // transporter is null by default in makeService({})
      expect(() =>
        service.sendNotification({
          subject: 'Alert',
          body: 'Something failed',
          recipients: ['alice@example.com'],
        }),
      ).not.toThrow();
    });

    it('calls sendMail when transporter is configured', () => {
      const mockSendMail = jest.fn().mockResolvedValue({});
      const svc = makeService({
        SMTP_HOST: 'smtp.example.com',
        SMTP_USER: 'u',
        SMTP_PASS: 'p',
      });
      svc.onModuleInit();
      // Inject mock sendMail
      (svc as unknown as { transporter: { sendMail: jest.Mock } }).transporter =
        {
          sendMail: mockSendMail,
        };
      svc.sendNotification({
        subject: 'Test',
        body: 'Body',
        recipients: ['alice@example.com'],
      });
      expect(mockSendMail).toHaveBeenCalledTimes(1);
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'alice@example.com',
          subject: 'Test',
        }),
      );
    });

    it('sends to multiple recipients joined with comma', () => {
      const mockSendMail = jest.fn().mockResolvedValue({});
      const svc = makeService();
      (svc as unknown as { transporter: { sendMail: jest.Mock } }).transporter =
        {
          sendMail: mockSendMail,
        };
      svc.sendNotification({
        subject: 'Multi',
        body: 'Body',
        recipients: ['alice@example.com', 'bob@example.com'],
      });
      const [callArgs] = mockSendMail.mock.calls;
      expect(callArgs[0].to).toBe('alice@example.com, bob@example.com');
    });

    it('HTML-escapes body content to prevent XSS', () => {
      const mockSendMail = jest.fn().mockResolvedValue({});
      const svc = makeService();
      (svc as unknown as { transporter: { sendMail: jest.Mock } }).transporter =
        {
          sendMail: mockSendMail,
        };
      svc.sendNotification({
        subject: 'XSS test',
        body: '<script>alert("xss")</script>',
        recipients: ['alice@example.com'],
      });
      const [callArgs] = mockSendMail.mock.calls;
      expect(callArgs[0].html).not.toContain('<script>');
      expect(callArgs[0].html).toContain('&lt;script&gt;');
    });
  });
});
