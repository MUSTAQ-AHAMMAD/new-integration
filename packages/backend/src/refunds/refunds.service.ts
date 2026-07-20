import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Decimal } from 'decimal.js';
import { RefundTracking } from '../database/entities/refund-tracking.entity';
import { SyncStatus } from '../database/enums';

export interface ListRefundsParams {
  status?: string;
  month?: number;
  year?: number;
  limit?: number;
}

export interface ManualCreditMemoInput {
  originalOrderId: string;
  originalOrderNumber: string;
  refundOrderId: string;
  refundOrderNumber: string;
  refundAmount: number;
  refundReason: string;
  refundDate: Date;
}

export interface RefundRecord {
  id: string;
  originalOrderId: string;
  originalOrderNumber: string;
  refundOrderId: string;
  refundOrderNumber: string;
  refundAmount: Decimal | number | string;
  refundReason: string;
  refundDate: Date;
  oracleCreditMemoNumber: string | null;
  creditMemoStatus: string;
  isReconciled?: boolean;
  reconcileNote?: string | null;
  createdAt: Date;
  updatedAt?: Date;
}

export interface RefundStatsRow {
  total: number;
  reconciled: number;
  pending: number;
  failed: number;
}

@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    @InjectRepository(RefundTracking)
    private readonly refunds: Repository<RefundTracking>,
  ) {}

  async listRefunds(params?: ListRefundsParams) {
    const qb = this.refunds.createQueryBuilder('r');

    if (params?.status) {
      qb.andWhere('r.creditMemoStatus = :status', {
        status: params.status.toUpperCase(),
      });
    }
    if (params?.month) {
      qb.andWhere('EXTRACT(MONTH FROM r.refundDate) = :month', {
        month: params.month,
      });
    }
    if (params?.year) {
      qb.andWhere('EXTRACT(YEAR FROM r.refundDate) = :year', {
        year: params.year,
      });
    }

    return qb
      .orderBy('r.refundDate', 'DESC')
      .addOrderBy('r.createdAt', 'DESC')
      .take(params?.limit ?? 50)
      .getMany();
  }

  async getRefund(id: string) {
    const refund = await this.refunds.findOne({ where: { id } });
    if (!refund) {
      throw new NotFoundException(`Refund ${id} not found`);
    }
    return refund;
  }

  async reconcileRefund(id: string, reconcileNote: string) {
    const refund = await this.refunds.findOne({ where: { id } });
    if (!refund) {
      throw new NotFoundException(`Refund ${id} not found`);
    }

    refund.isReconciled = true;
    refund.reconcileNote = reconcileNote;
    refund.reconciledAt = new Date();
    const saved = await this.refunds.save(refund);

    this.logger.log(`Refund ${id} marked as reconciled`);
    return saved;
  }

  async createManualCreditMemo(data: ManualCreditMemoInput) {
    const refund = this.refunds.create({
      originalOrderId: data.originalOrderId,
      originalOrderNumber: data.originalOrderNumber,
      refundOrderId: data.refundOrderId,
      refundOrderNumber: data.refundOrderNumber,
      refundAmount: new Decimal(data.refundAmount),
      refundReason: data.refundReason,
      refundDate: data.refundDate,
      oracleCreditMemoNumber: '',
      creditMemoStatus: SyncStatus.PENDING,
    });
    const saved = await this.refunds.save(refund);

    this.logger.log(
      `Manual credit memo created for refund order ${data.refundOrderNumber}`,
    );

    return saved;
  }

  async getRefundStats(): Promise<RefundStatsRow> {
    const [total, reconciled, pending, failed] = await Promise.all([
      this.refunds.count(),
      this.refunds.count({ where: { isReconciled: true } }),
      this.refunds.count({ where: { creditMemoStatus: SyncStatus.PENDING } }),
      this.refunds.count({ where: { creditMemoStatus: SyncStatus.FAILED } }),
    ]);

    return { total, reconciled, pending, failed };
  }
}
