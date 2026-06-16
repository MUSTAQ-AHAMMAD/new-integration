import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, SyncStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

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
  refundAmount: Prisma.Decimal | number | string;
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

  constructor(private readonly prisma: PrismaService) {}

  async listRefunds(params?: ListRefundsParams) {
    const conditions: Prisma.Sql[] = [];

    if (params?.status) {
      conditions.push(
        Prisma.sql`"creditMemoStatus" = ${params.status.toUpperCase()}`,
      );
    }

    if (params?.month) {
      conditions.push(
        Prisma.sql`EXTRACT(MONTH FROM "refundDate") = ${params.month}`,
      );
    }

    if (params?.year) {
      conditions.push(
        Prisma.sql`EXTRACT(YEAR FROM "refundDate") = ${params.year}`,
      );
    }

    const whereClause = conditions.length
      ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
      : Prisma.empty;
    const take = params?.limit ?? 50;

    return this.prisma.$queryRaw<RefundRecord[]>(Prisma.sql`
      SELECT *
      FROM "RefundTracking"
      ${whereClause}
      ORDER BY "refundDate" DESC, "createdAt" DESC
      LIMIT ${take}
    `);
  }

  async getRefund(id: string) {
    const [refund] = await this.prisma.$queryRaw<RefundRecord[]>(Prisma.sql`
      SELECT *
      FROM "RefundTracking"
      WHERE "id" = ${id}
      LIMIT 1
    `);

    if (!refund) {
      throw new NotFoundException(`Refund ${id} not found`);
    }

    return refund;
  }

  async reconcileRefund(id: string, reconcileNote: string) {
    const [refund] = await this.prisma.$queryRaw<RefundRecord[]>(Prisma.sql`
      UPDATE "RefundTracking"
      SET
        "isReconciled" = TRUE,
        "reconcileNote" = ${reconcileNote},
        "updatedAt" = NOW()
      WHERE "id" = ${id}
      RETURNING *
    `);

    if (!refund) {
      throw new NotFoundException(`Refund ${id} not found`);
    }

    this.logger.log(`Refund ${id} marked as reconciled`);
    return refund;
  }

  async createManualCreditMemo(data: ManualCreditMemoInput) {
    const refund = await this.prisma.refundTracking.create({
      data: {
        originalOrderId: data.originalOrderId,
        originalOrderNumber: data.originalOrderNumber,
        refundOrderId: data.refundOrderId,
        refundOrderNumber: data.refundOrderNumber,
        refundAmount: new Prisma.Decimal(data.refundAmount),
        refundReason: data.refundReason,
        refundDate: data.refundDate,
        oracleCreditMemoNumber: '',
        creditMemoStatus: SyncStatus.PENDING,
      },
    });

    this.logger.log(
      `Manual credit memo created for refund order ${data.refundOrderNumber}`,
    );

    return refund;
  }

  async getRefundStats() {
    const [stats] = await this.prisma.$queryRaw<RefundStatsRow[]>(Prisma.sql`
      SELECT
        COUNT(*)::int AS "total",
        COALESCE(SUM(CASE WHEN COALESCE("isReconciled", FALSE) = TRUE THEN 1 ELSE 0 END), 0)::int AS "reconciled",
        COALESCE(SUM(CASE WHEN "creditMemoStatus" = 'PENDING' THEN 1 ELSE 0 END), 0)::int AS "pending",
        COALESCE(SUM(CASE WHEN "creditMemoStatus" = 'FAILED' THEN 1 ELSE 0 END), 0)::int AS "failed"
      FROM "RefundTracking"
    `);

    return (
      stats ?? {
        total: 0,
        reconciled: 0,
        pending: 0,
        failed: 0,
      }
    );
  }
}
