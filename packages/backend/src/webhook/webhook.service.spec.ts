import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { SyncStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrderSyncService } from '../sync/order-sync.service';
import { WebhookService } from './webhook.service';

const WEBHOOK_SECRET = 'test-webhook-secret';

function makeSignature(body: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function makeService(secret: string | null = WEBHOOK_SECRET): {
  service: WebhookService;
  mockPrisma: jest.Mocked<Partial<PrismaService>>;
  mockOrderSync: jest.Mocked<Partial<OrderSyncService>>;
} {
  const mockPrisma = {
    webhookEvent: {
      create: jest.fn().mockResolvedValue({ id: 'evt-001' }),
      update: jest.fn().mockResolvedValue({}),
    } as unknown as PrismaService['webhookEvent'],
  };

  const mockOrderSync = {
    ingestOrder: jest.fn().mockResolvedValue(undefined),
  };

  const config = {
    get: jest.fn((key: string) =>
      key === 'WEBHOOK_SECRET' ? (secret ?? undefined) : undefined,
    ),
  } as unknown as ConfigService;

  const service = new WebhookService(
    mockPrisma as unknown as PrismaService,
    mockOrderSync as unknown as OrderSyncService,
    config,
  );

  return {
    service,
    mockPrisma: mockPrisma,
    mockOrderSync: mockOrderSync,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePaidOrderPayload(overrides: Record<string, unknown> = {}) {
  return {
    event_type: 'order.paid',
    order: {
      id: 'ORD-001',
      name: 'S00001',
      branch_code: 'DXB',
      date_order: '2024-01-15T10:00:00+04:00',
      timezone: 'Asia/Dubai',
      amount_total: 150,
      currency: 'AED',
      state: 'posted',
      ...overrides,
    },
  };
}

// ── Signature verification ────────────────────────────────────────────────────

describe('WebhookService — HMAC signature verification', () => {
  it('accepts a valid sha256 signature', async () => {
    const { service } = makeService();
    const payload = makePaidOrderPayload();
    const raw = Buffer.from(JSON.stringify(payload));
    const sig = makeSignature(raw, WEBHOOK_SECRET);

    await expect(
      service.processOdooEvent(payload, raw, sig),
    ).resolves.toMatchObject({ received: true });
  });

  it('accepts a sha256= prefixed signature', async () => {
    const { service } = makeService();
    const payload = makePaidOrderPayload();
    const raw = Buffer.from(JSON.stringify(payload));
    const sig = `sha256=${makeSignature(raw, WEBHOOK_SECRET)}`;

    await expect(
      service.processOdooEvent(payload, raw, sig),
    ).resolves.toMatchObject({ received: true });
  });

  it('rejects a signature signed with the wrong secret', async () => {
    const { service } = makeService();
    const payload = makePaidOrderPayload();
    const raw = Buffer.from(JSON.stringify(payload));
    const sig = makeSignature(raw, 'wrong-secret');

    await expect(service.processOdooEvent(payload, raw, sig)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects when signature header is missing and secret is configured', async () => {
    const { service } = makeService();
    const payload = makePaidOrderPayload();
    const raw = Buffer.from(JSON.stringify(payload));

    await expect(
      service.processOdooEvent(payload, raw, undefined),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('accepts any request when no secret is configured', async () => {
    const { service } = makeService(null);
    const payload = makePaidOrderPayload();
    const raw = Buffer.from(JSON.stringify(payload));

    await expect(
      service.processOdooEvent(payload, raw, undefined),
    ).resolves.toMatchObject({ received: true });
  });

  it('rejects a tampered signature (single bit flip)', async () => {
    const { service } = makeService();
    const payload = makePaidOrderPayload();
    const raw = Buffer.from(JSON.stringify(payload));
    const sig = makeSignature(raw, WEBHOOK_SECRET);
    // Flip the last hex character
    const tampered = sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0');

    await expect(
      service.processOdooEvent(payload, raw, tampered),
    ).rejects.toThrow(UnauthorizedException);
  });
});

// ── Event persistence ─────────────────────────────────────────────────────────

describe('WebhookService — event persistence', () => {
  it('persists a WebhookEvent record for every incoming event', async () => {
    const { service, mockPrisma } = makeService(null);
    const payload = makePaidOrderPayload();
    const raw = Buffer.from(JSON.stringify(payload));

    await service.processOdooEvent(payload, raw);

    expect(mockPrisma.webhookEvent!.create as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'order.paid',
          sourceSystem: 'ODOO',
          processingStatus: SyncStatus.PENDING,
        }),
      }),
    );
  });

  it('marks the event as SYNCED after successful processing', async () => {
    const { service, mockPrisma } = makeService(null);
    const payload = makePaidOrderPayload();
    const raw = Buffer.from(JSON.stringify(payload));

    await service.processOdooEvent(payload, raw);

    expect(mockPrisma.webhookEvent!.update as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          processingStatus: SyncStatus.SYNCED,
        }),
      }),
    );
  });

  it('marks the event as FAILED when processing throws', async () => {
    const { service, mockPrisma, mockOrderSync } = makeService(null);
    (mockOrderSync.ingestOrder as jest.Mock).mockRejectedValue(
      new Error('downstream error'),
    );
    const payload = makePaidOrderPayload();
    const raw = Buffer.from(JSON.stringify(payload));

    const result = await service.processOdooEvent(payload, raw);

    expect(result).toMatchObject({
      received: true,
      processingError: expect.any(String),
    });
    expect(mockPrisma.webhookEvent!.update as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          processingStatus: SyncStatus.FAILED,
        }),
      }),
    );
  });

  it('stores the event_type from the payload', async () => {
    const { service, mockPrisma } = makeService(null);
    const payload = {
      event_type: 'order.refund',
      order: { id: 'R-001', state: 'posted', amount_total: -50 },
    };
    const raw = Buffer.from(JSON.stringify(payload));

    await service.processOdooEvent(payload, raw);

    expect(mockPrisma.webhookEvent!.create as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'order.refund' }),
      }),
    );
  });

  it('stores "unknown" as eventType when event_type is absent', async () => {
    const { service, mockPrisma } = makeService(null);
    const payload: Record<string, unknown> = {};
    const raw = Buffer.from(JSON.stringify(payload));

    await service.processOdooEvent(payload, raw);

    expect(mockPrisma.webhookEvent!.create as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'unknown' }),
      }),
    );
  });
});

// ── Order event routing ───────────────────────────────────────────────────────

describe('WebhookService — order event routing', () => {
  const orderEventTypes = [
    'order.paid',
    'order.created',
    'order.updated',
    'order.refund',
  ];

  for (const eventType of orderEventTypes) {
    it(`calls ingestOrder for "${eventType}" events`, async () => {
      const { service, mockOrderSync } = makeService(null);
      const p = {
        event_type: eventType,
        order: { ...makePaidOrderPayload().order },
      };
      const raw = Buffer.from(JSON.stringify(p));

      await service.processOdooEvent(p, raw);

      expect(mockOrderSync.ingestOrder).toHaveBeenCalledTimes(1);
    });
  }

  it('does NOT call ingestOrder for an unknown event type', async () => {
    const { service, mockOrderSync } = makeService(null);
    const payload = { event_type: 'inventory.updated', data: {} };
    const raw = Buffer.from(JSON.stringify(payload));

    await service.processOdooEvent(payload, raw);

    expect(mockOrderSync.ingestOrder).not.toHaveBeenCalled();
  });

  it('does NOT call ingestOrder when the order object is absent', async () => {
    const { service, mockOrderSync } = makeService(null);
    const payload = { event_type: 'order.paid' };
    const raw = Buffer.from(JSON.stringify(payload));

    await service.processOdooEvent(payload, raw);

    expect(mockOrderSync.ingestOrder).not.toHaveBeenCalled();
  });

  it('maps order fields to ingestOrder correctly', async () => {
    const { service, mockOrderSync } = makeService(null);
    const payload = {
      event_type: 'order.paid',
      order: {
        id: 'ORD-123',
        name: 'S00123',
        branch_code: 'AUH',
        timezone: 'Asia/Dubai',
        date_order: '2024-03-01T08:00:00+04:00',
        amount_total: 250.5,
        currency: 'AED',
        state: 'posted',
        partner_name: 'Test Customer',
        partner_email: 'customer@test.com',
      },
    };
    const raw = Buffer.from(JSON.stringify(payload));

    await service.processOdooEvent(payload, raw);

    expect(mockOrderSync.ingestOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        odooOrderId: 'ORD-123',
        odooOrderNumber: 'S00123',
        branchCode: 'AUH',
        totalAmount: 250.5,
        currency: 'AED',
        isPaid: true,
      }),
    );
  });

  it('sets isPaid=true for state "paid"', async () => {
    const { service, mockOrderSync } = makeService(null);
    const p = makePaidOrderPayload({ state: 'paid' });
    const raw = Buffer.from(JSON.stringify(p));

    await service.processOdooEvent(p, raw);

    expect(mockOrderSync.ingestOrder).toHaveBeenCalledWith(
      expect.objectContaining({ isPaid: true }),
    );
  });

  it('sets isPaid=false for state "draft"', async () => {
    const { service, mockOrderSync } = makeService(null);
    const p = {
      event_type: 'order.created',
      order: { id: 'D-1', state: 'draft', amount_total: 100 },
    };
    const raw = Buffer.from(JSON.stringify(p));

    await service.processOdooEvent(p, raw);

    expect(mockOrderSync.ingestOrder).toHaveBeenCalledWith(
      expect.objectContaining({ isPaid: false }),
    );
  });

  it('sets isCancelled=true for state "cancel"', async () => {
    const { service, mockOrderSync } = makeService(null);
    const p = {
      event_type: 'order.updated',
      order: { id: 'C-1', state: 'cancel', amount_total: 100 },
    };
    const raw = Buffer.from(JSON.stringify(p));

    await service.processOdooEvent(p, raw);

    expect(mockOrderSync.ingestOrder).toHaveBeenCalledWith(
      expect.objectContaining({ isCancelled: true }),
    );
  });

  it('auto-detects refund from negative amount_total', async () => {
    const { service, mockOrderSync } = makeService(null);
    const p = {
      event_type: 'order.refund',
      order: { id: 'R-1', state: 'posted', amount_total: -75 },
    };
    const raw = Buffer.from(JSON.stringify(p));

    await service.processOdooEvent(p, raw);

    expect(mockOrderSync.ingestOrder).toHaveBeenCalledWith(
      expect.objectContaining({ isRefund: true }),
    );
  });

  it('defaults branchCode to "UNKNOWN" when branch_code is absent', async () => {
    const { service, mockOrderSync } = makeService(null);
    const p = {
      event_type: 'order.paid',
      order: { id: 'X-1', state: 'posted', amount_total: 100 },
    };
    const raw = Buffer.from(JSON.stringify(p));

    await service.processOdooEvent(p, raw);

    expect(mockOrderSync.ingestOrder).toHaveBeenCalledWith(
      expect.objectContaining({ branchCode: 'UNKNOWN' }),
    );
  });

  it('defaults currency to "AED" when absent', async () => {
    const { service, mockOrderSync } = makeService(null);
    const p = {
      event_type: 'order.paid',
      order: { id: 'X-2', state: 'posted', amount_total: 100 },
    };
    const raw = Buffer.from(JSON.stringify(p));

    await service.processOdooEvent(p, raw);

    expect(mockOrderSync.ingestOrder).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'AED' }),
    );
  });
});
