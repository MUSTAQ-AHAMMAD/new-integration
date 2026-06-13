import { AlertsService } from '../alerts/alerts.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentMappingService } from './payment-mapping.service';

const mockPrisma = {
  paymentMethodMapping: {
    findUnique: jest.fn(),
    upsert: jest.fn().mockResolvedValue({}),
    update: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn(),
  },
};

const mockAlerts = {
  createAlert: jest.fn().mockResolvedValue({}),
};

describe('PaymentMappingService', () => {
  let service: PaymentMappingService;

  beforeEach(() => {
    service = new PaymentMappingService(
      mockPrisma as unknown as PrismaService,
      mockAlerts as unknown as AlertsService,
    );
    jest.clearAllMocks();
    mockPrisma.paymentMethodMapping.upsert.mockResolvedValue({});
  });

  // ── resolvePaymentMethod ─────────────────────────────────────

  describe('resolvePaymentMethod', () => {
    it('returns null when no mapping exists', async () => {
      mockPrisma.paymentMethodMapping.findUnique.mockResolvedValueOnce(null);

      const result = await service.resolvePaymentMethod('ODOO', 'Cash');

      expect(result).toBeNull();
    });

    it('fires a PAYMENT_METHOD_DISCOVERED alert when no mapping exists', async () => {
      mockPrisma.paymentMethodMapping.findUnique.mockResolvedValueOnce(null);

      await service.resolvePaymentMethod('ODOO', 'CashREDSEA');

      expect(mockAlerts.createAlert).toHaveBeenCalledWith(
        expect.objectContaining({ alertType: 'PAYMENT_METHOD_DISCOVERED' }),
      );
    });

    it('upserts a PENDING_MAPPING placeholder when no mapping exists', async () => {
      mockPrisma.paymentMethodMapping.findUnique.mockResolvedValueOnce(null);

      await service.resolvePaymentMethod('ODOO', 'CashREDSEA');

      expect(mockPrisma.paymentMethodMapping.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            oracleReceiptMethodName: 'PENDING_MAPPING',
            isActive: false,
            requiresApproval: true,
          }),
        }),
      );
    });

    it('returns the mapping when it exists and is active', async () => {
      const mapping = {
        id: 'm-1',
        sourcePaymentName: 'Cash',
        isActive: true,
        requiresApproval: false,
        approvedAt: null,
      };
      mockPrisma.paymentMethodMapping.findUnique.mockResolvedValueOnce(mapping);

      const result = await service.resolvePaymentMethod('ODOO', 'Cash');

      expect(result).toEqual(mapping);
    });

    it('returns the mapping when it is inactive (for fallback handling by caller)', async () => {
      const mapping = {
        id: 'm-2',
        sourcePaymentName: 'OldCash',
        isActive: false,
        requiresApproval: false,
        approvedAt: null,
      };
      mockPrisma.paymentMethodMapping.findUnique.mockResolvedValueOnce(mapping);

      const result = await service.resolvePaymentMethod('ODOO', 'OldCash');

      expect(result).toEqual(mapping);
    });

    it('returns the mapping when requiresApproval but not yet approved', async () => {
      const mapping = {
        id: 'm-3',
        sourcePaymentName: 'NewCard',
        isActive: true,
        requiresApproval: true,
        approvedAt: null,
      };
      mockPrisma.paymentMethodMapping.findUnique.mockResolvedValueOnce(mapping);

      const result = await service.resolvePaymentMethod('ODOO', 'NewCard');

      expect(result).toEqual(mapping);
    });

    it('does NOT fire an alert when a valid mapping already exists', async () => {
      mockPrisma.paymentMethodMapping.findUnique.mockResolvedValueOnce({
        id: 'm-4',
        isActive: true,
        requiresApproval: false,
        approvedAt: null,
      });

      await service.resolvePaymentMethod('ODOO', 'Cash');

      expect(mockAlerts.createAlert).not.toHaveBeenCalled();
    });
  });

  // ── approvePendingMapping ────────────────────────────────────

  describe('approvePendingMapping', () => {
    it('sets requiresApproval=false, isActive=true, and records approvedBy', async () => {
      mockPrisma.paymentMethodMapping.update.mockResolvedValueOnce({ id: 'm-5' });

      await service.approvePendingMapping('m-5', 'admin@example.com');

      expect(mockPrisma.paymentMethodMapping.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'm-5' },
          data: expect.objectContaining({
            requiresApproval: false,
            isActive: true,
            approvedBy: 'admin@example.com',
            approvedAt: expect.any(Date),
          }),
        }),
      );
    });
  });

  // ── listMappings ─────────────────────────────────────────────

  describe('listMappings', () => {
    it('returns all mappings when no sourceSystem filter is supplied', async () => {
      mockPrisma.paymentMethodMapping.findMany.mockResolvedValueOnce([
        { id: 'm-1' },
        { id: 'm-2' },
      ]);

      const result = await service.listMappings();

      expect(result).toHaveLength(2);
      expect(mockPrisma.paymentMethodMapping.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: undefined }),
      );
    });

    it('filters by sourceSystem when provided', async () => {
      mockPrisma.paymentMethodMapping.findMany.mockResolvedValueOnce([]);

      await service.listMappings('ODOO');

      expect(mockPrisma.paymentMethodMapping.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { sourceSystem: 'ODOO' } }),
      );
    });
  });
});
