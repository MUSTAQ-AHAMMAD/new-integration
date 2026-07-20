import { Repository } from 'typeorm';
import { AlertsService } from '../alerts/alerts.service';
import { OrderSyncQueue } from '../database/entities/order-sync-queue.entity';
import { ValidationService } from './validation.service';
import { ValidationStatus } from '../database/enums';

const mockOrdersRepo = {
  findOne: jest.fn(),
};

// Store config returned by getOrCreateStoreConfig; driven per-test.
const storeConfigResult = {
  findOne: jest.fn(),
};

const mockAlerts = {
  createAlert: jest.fn().mockResolvedValue({}),
};

const mockStoreConfig = {
  // Delegate to the store-config mock so existing expectations continue to drive
  // the store config returned to the service.
  getOrCreateStoreConfig: jest.fn(() => storeConfigResult.findOne()),
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
      mockOrdersRepo as unknown as Repository<OrderSyncQueue>,
      mockAlerts as unknown as AlertsService,
      mockStoreConfig as never,
    );
    jest.clearAllMocks();
  });

  it('returns invalid when order is not found', async () => {
    mockOrdersRepo.findOne.mockResolvedValueOnce(null);
    const result = await service.validateOrder('order-1', 'BR001');
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Order order-1 not found in sync queue');
    expect(result.holdForNegativeInventory).toBe(false);
  });

  it('returns invalid when order is not paid', async () => {
    mockOrdersRepo.findOne.mockResolvedValueOnce(
      makePaidOrder({ isPaid: false }),
    );
    storeConfigResult.findOne.mockResolvedValueOnce(makeActiveStore());
    const result = await service.validateOrder('order-1', 'BR001');
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.includes('not paid'))).toBe(true);
  });

  it('returns invalid when order is cancelled', async () => {
    mockOrdersRepo.findOne.mockResolvedValueOnce(
      makePaidOrder({ isCancelled: true }),
    );
    storeConfigResult.findOne.mockResolvedValueOnce(makeActiveStore());
    const result = await service.validateOrder('order-1', 'BR001');
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Order is cancelled');
  });

  it('returns invalid when store config is missing', async () => {
    mockOrdersRepo.findOne.mockResolvedValueOnce(makePaidOrder());
    storeConfigResult.findOne.mockResolvedValueOnce(null);
    const result = await service.validateOrder('order-1', 'BR001');
    expect(result.isValid).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes('Failed to get or create store configuration'),
      ),
    ).toBe(true);
  });

  it('returns valid for a paid, active, fully-configured order', async () => {
    mockOrdersRepo.findOne.mockResolvedValueOnce(makePaidOrder());
    storeConfigResult.findOne.mockResolvedValueOnce(makeActiveStore());
    const result = await service.validateOrder('order-1', 'BR001');
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.holdForNegativeInventory).toBe(false);
  });

  it('fires a NEGATIVE_INVENTORY alert when negative inventory flag is set', async () => {
    mockOrdersRepo.findOne.mockResolvedValueOnce(
      makePaidOrder({
        negativeInventoryFlag: true,
        negativeInventoryItems: [{ sku: 'SKU-A', quantity: -3 }],
      }),
    );
    storeConfigResult.findOne.mockResolvedValueOnce(makeActiveStore());

    await service.validateOrder('order-1', 'BR001');

    expect(mockAlerts.createAlert).toHaveBeenCalledWith(
      expect.objectContaining({ alertType: 'NEGATIVE_INVENTORY' }),
    );
  });

  it('includes SKU details in the NEGATIVE_INVENTORY alert message', async () => {
    mockOrdersRepo.findOne.mockResolvedValueOnce(
      makePaidOrder({
        negativeInventoryFlag: true,
        negativeInventoryItems: [{ sku: 'SKU-B', quantity: -7 }],
      }),
    );
    storeConfigResult.findOne.mockResolvedValueOnce(makeActiveStore());

    await service.validateOrder('order-1', 'BR001');

    const alertCall = mockAlerts.createAlert.mock.calls[0][0] as {
      message: string;
    };
    expect(alertCall.message).toContain('SKU-B');
  });

  it('sets holdForNegativeInventory=true for a valid order with negative inventory', async () => {
    mockOrdersRepo.findOne.mockResolvedValueOnce(
      makePaidOrder({ negativeInventoryFlag: true }),
    );
    storeConfigResult.findOne.mockResolvedValueOnce(makeActiveStore());

    const result = await service.validateOrder('order-1', 'BR001');

    expect(result.isValid).toBe(true);
    expect(result.holdForNegativeInventory).toBe(true);
  });

  it('sets holdForNegativeInventory=false when negative inventory is absent', async () => {
    mockOrdersRepo.findOne.mockResolvedValueOnce(makePaidOrder());
    storeConfigResult.findOne.mockResolvedValueOnce(makeActiveStore());

    const result = await service.validateOrder('order-1', 'BR001');

    expect(result.holdForNegativeInventory).toBe(false);
  });

  it('does NOT set holdForNegativeInventory when the order itself is invalid', async () => {
    // Order has negative inventory BUT is also unpaid — invalid wins; hold must be false
    mockOrdersRepo.findOne.mockResolvedValueOnce(
      makePaidOrder({ isPaid: false, negativeInventoryFlag: true }),
    );
    storeConfigResult.findOne.mockResolvedValueOnce(makeActiveStore());

    const result = await service.validateOrder('order-1', 'BR001');

    expect(result.isValid).toBe(false);
    expect(result.holdForNegativeInventory).toBe(false);
  });
});
