import { ValidationService } from './validation.service';
import { ValidationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const mockPrisma = {
  orderSyncQueue: {
    findUnique: jest.fn(),
  },
  storeConfiguration: {
    findUnique: jest.fn(),
  },
};

describe('ValidationService', () => {
  let service: ValidationService;

  beforeEach(() => {
    service = new ValidationService(mockPrisma as unknown as PrismaService);
    jest.clearAllMocks();
  });

  it('returns invalid when order is not found', async () => {
    mockPrisma.orderSyncQueue.findUnique.mockResolvedValueOnce(null);
    const result = await service.validateOrder('order-1', 'BR001');
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Order order-1 not found in sync queue');
  });

  it('returns invalid when order is not paid', async () => {
    mockPrisma.orderSyncQueue.findUnique.mockResolvedValueOnce({
      isPaid: false,
      isCancelled: false,
      negativeInventoryFlag: false,
    });
    mockPrisma.storeConfiguration.findUnique.mockResolvedValueOnce({
      isActive: true,
      validationStatus: ValidationStatus.VALIDATED,
    });
    const result = await service.validateOrder('order-1', 'BR001');
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.includes('not paid'))).toBe(true);
  });

  it('returns invalid when order is cancelled', async () => {
    mockPrisma.orderSyncQueue.findUnique.mockResolvedValueOnce({
      isPaid: true,
      isCancelled: true,
      negativeInventoryFlag: false,
    });
    mockPrisma.storeConfiguration.findUnique.mockResolvedValueOnce({
      isActive: true,
      validationStatus: ValidationStatus.VALIDATED,
    });
    const result = await service.validateOrder('order-1', 'BR001');
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Order is cancelled');
  });

  it('returns invalid when store config is missing', async () => {
    mockPrisma.orderSyncQueue.findUnique.mockResolvedValueOnce({
      isPaid: true,
      isCancelled: false,
      negativeInventoryFlag: false,
    });
    mockPrisma.storeConfiguration.findUnique.mockResolvedValueOnce(null);
    const result = await service.validateOrder('order-1', 'BR001');
    expect(result.isValid).toBe(false);
    expect(
      result.errors.some((e) => e.includes('No store configuration')),
    ).toBe(true);
  });

  it('returns valid for a paid, active, fully-configured order', async () => {
    mockPrisma.orderSyncQueue.findUnique.mockResolvedValueOnce({
      isPaid: true,
      isCancelled: false,
      negativeInventoryFlag: false,
    });
    mockPrisma.storeConfiguration.findUnique.mockResolvedValueOnce({
      isActive: true,
      validationStatus: ValidationStatus.VALIDATED,
    });
    const result = await service.validateOrder('order-1', 'BR001');
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('adds warning when negative inventory flag is set', async () => {
    mockPrisma.orderSyncQueue.findUnique.mockResolvedValueOnce({
      isPaid: true,
      isCancelled: false,
      negativeInventoryFlag: true,
    });
    mockPrisma.storeConfiguration.findUnique.mockResolvedValueOnce({
      isActive: true,
      validationStatus: ValidationStatus.VALIDATED,
    });
    const result = await service.validateOrder('order-1', 'BR001');
    expect(result.isValid).toBe(true);
    expect(result.warnings.some((w) => w.includes('negative inventory'))).toBe(
      true,
    );
  });
});
