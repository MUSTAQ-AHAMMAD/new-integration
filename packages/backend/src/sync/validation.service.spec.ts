import { AlertsService } from '../alerts/alerts.service';
import { PrismaService } from '../prisma/prisma.service';
import { ValidationService } from './validation.service';
import { ValidationStatus } from '@prisma/client';

const mockPrisma = {
  orderSyncQueue: {
    findUnique: jest.fn(),
  },
  storeConfiguration: {
    findUnique: jest.fn(),
  },
};

const mockAlerts = {
  createAlert: jest.fn().mockResolvedValue({}),
};

/** Helper: a valid paid order with no negative inventory */
function makePaidOrder(overrides: Record<string, unknown> = {}) {
  return {
    isPaid: true,
    isCancelled: false,
    negativeInventoryFlag: false,
    negativeInventoryItems: null,
    odooOrderNumber: 'S00001',
    ...overrides,
  };
}

/** Helper: a valid active store config */
function makeActiveStore(overrides: Record<string, unknown> = {}) {
  return {
    isActive: true,
    validationStatus: ValidationStatus.VALIDATED,
    ...overrides,
  };
}

describe('ValidationService', () => {
  let service: ValidationService;

  beforeEach(() => {
    service = new ValidationService(
      mockPrisma as unknown as PrismaService,
      mockAlerts as unknown as AlertsService,
    );
    jest.clearAllMocks();
  });

  it('returns invalid when order is not found', async () => {
    mockPrisma.orderSyncQueue.findUnique.mockResolvedValueOnce(null);
    const result = await service.validateOrder('order-1', 'BR001');
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Order order-1 not found in sync queue');
    expect(result.holdForNegativeInventory).toBe(false);
  });

  it('returns invalid when order is not paid', async () => {
    mockPrisma.orderSyncQueue.findUnique.mockResolvedValueOnce(
      makePaidOrder({ isPaid: false }),
    );
    mockPrisma.storeConfiguration.findUnique.mockResolvedValueOnce(makeActiveStore());
    const result = await service.validateOrder('order-1', 'BR001');
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.includes('not paid'))).toBe(true);
  });

  it('returns invalid when order is cancelled', async () => {
    mockPrisma.orderSyncQueue.findUnique.mockResolvedValueOnce(
      makePaidOrder({ isCancelled: true }),
    );
    mockPrisma.storeConfiguration.findUnique.mockResolvedValueOnce(makeActiveStore());
    const result = await service.validateOrder('order-1', 'BR001');
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Order is cancelled');
  });

  it('returns invalid when store config is missing', async () => {
    mockPrisma.orderSyncQueue.findUnique.mockResolvedValueOnce(makePaidOrder());
    mockPrisma.storeConfiguration.findUnique.mockResolvedValueOnce(null);
    const result = await service.validateOrder('order-1', 'BR001');
    expect(result.isValid).toBe(false);
    expect(
      result.errors.some((e) => e.includes('No store configuration')),
    ).toBe(true);
  });

  it('returns valid for a paid, active, fully-configured order', async () => {
    mockPrisma.orderSyncQueue.findUnique.mockResolvedValueOnce(makePaidOrder());
    mockPrisma.storeConfiguration.findUnique.mockResolvedValueOnce(makeActiveStore());
    const result = await service.validateOrder('order-1', 'BR001');
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.holdForNegativeInventory).toBe(false);
  });

  it('fires a NEGATIVE_INVENTORY alert when negative inventory flag is set', async () => {
    mockPrisma.orderSyncQueue.findUnique.mockResolvedValueOnce(
      makePaidOrder({
        negativeInventoryFlag: true,
        negativeInventoryItems: [{ sku: 'SKU-A', quantity: -3 }],
      }),
    );
    mockPrisma.storeConfiguration.findUnique.mockResolvedValueOnce(makeActiveStore());

    await service.validateOrder('order-1', 'BR001');

    expect(mockAlerts.createAlert).toHaveBeenCalledWith(
      expect.objectContaining({ alertType: 'NEGATIVE_INVENTORY' }),
    );
  });

  it('includes SKU details in the NEGATIVE_INVENTORY alert message', async () => {
    mockPrisma.orderSyncQueue.findUnique.mockResolvedValueOnce(
      makePaidOrder({
        negativeInventoryFlag: true,
        negativeInventoryItems: [{ sku: 'SKU-B', quantity: -7 }],
      }),
    );
    mockPrisma.storeConfiguration.findUnique.mockResolvedValueOnce(makeActiveStore());

    await service.validateOrder('order-1', 'BR001');

    const alertCall = (mockAlerts.createAlert as jest.Mock).mock.calls[0][0] as {
      message: string;
    };
    expect(alertCall.message).toContain('SKU-B');
  });

  it('sets holdForNegativeInventory=true for a valid order with negative inventory', async () => {
    mockPrisma.orderSyncQueue.findUnique.mockResolvedValueOnce(
      makePaidOrder({ negativeInventoryFlag: true }),
    );
    mockPrisma.storeConfiguration.findUnique.mockResolvedValueOnce(makeActiveStore());

    const result = await service.validateOrder('order-1', 'BR001');

    expect(result.isValid).toBe(true);
    expect(result.holdForNegativeInventory).toBe(true);
  });

  it('sets holdForNegativeInventory=false when negative inventory is absent', async () => {
    mockPrisma.orderSyncQueue.findUnique.mockResolvedValueOnce(makePaidOrder());
    mockPrisma.storeConfiguration.findUnique.mockResolvedValueOnce(makeActiveStore());

    const result = await service.validateOrder('order-1', 'BR001');

    expect(result.holdForNegativeInventory).toBe(false);
  });

  it('does NOT set holdForNegativeInventory when the order itself is invalid', async () => {
    // Order has negative inventory BUT is also unpaid — invalid wins; hold must be false
    mockPrisma.orderSyncQueue.findUnique.mockResolvedValueOnce(
      makePaidOrder({ isPaid: false, negativeInventoryFlag: true }),
    );
    mockPrisma.storeConfiguration.findUnique.mockResolvedValueOnce(makeActiveStore());

    const result = await service.validateOrder('order-1', 'BR001');

    expect(result.isValid).toBe(false);
    expect(result.holdForNegativeInventory).toBe(false);
  });
});
