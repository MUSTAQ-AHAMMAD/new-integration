import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Decimal } from 'decimal.js';
import { InventorySyncTracker } from '../database/entities/inventory-sync-tracker.entity';

export interface ListNegativeInventoryParams {
  branchCode?: string;
  limit?: number;
}

export interface InventoryRecord {
  id: string;
  productSku: string;
  productName?: string | null;
  branchCode: string;
  quantityChange: Decimal | number | string;
  isNegativeInventory: boolean;
  negativeInventoryAlertSent: boolean;
  reviewedAt?: Date | null;
  reviewedBy?: string | null;
  reviewNote?: string | null;
  createdAt: Date;
}

export interface InventoryStatsRow {
  totalNegative: number;
  reviewed: number;
  unreviewed: number;
}

export interface InventoryBranchStatsRow {
  branchCode: string;
  total: number;
  reviewed: number;
  unreviewed: number;
}

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    @InjectRepository(InventorySyncTracker)
    private readonly trackers: Repository<InventorySyncTracker>,
  ) {}

  async listNegativeInventory(params?: ListNegativeInventoryParams) {
    const qb = this.trackers
      .createQueryBuilder('t')
      .where('t.isNegativeInventory = :neg', { neg: true });

    if (params?.branchCode) {
      qb.andWhere('t.branchCode = :branchCode', {
        branchCode: params.branchCode,
      });
    }

    return qb
      .orderBy('t.createdAt', 'DESC')
      .take(params?.limit ?? 50)
      .getMany();
  }

  async markAsReviewed(id: string, reviewedBy: string, reviewNote?: string) {
    const record = await this.trackers.findOne({ where: { id } });
    if (!record) {
      throw new NotFoundException(`Inventory tracker ${id} not found`);
    }

    record.reviewedAt = new Date();
    record.reviewedBy = reviewedBy;
    record.reviewNote = reviewNote ?? null;
    const saved = await this.trackers.save(record);

    this.logger.log(`Inventory tracker ${id} reviewed by ${reviewedBy}`);
    return saved;
  }

  async getInventoryStats() {
    const summary = await this.trackers
      .createQueryBuilder('t')
      .select('COUNT(*)', 'totalNegative')
      .addSelect(
        'COALESCE(SUM(CASE WHEN t.reviewedAt IS NOT NULL THEN 1 ELSE 0 END), 0)',
        'reviewed',
      )
      .addSelect(
        'COALESCE(SUM(CASE WHEN t.reviewedAt IS NULL THEN 1 ELSE 0 END), 0)',
        'unreviewed',
      )
      .where('t.isNegativeInventory = :neg', { neg: true })
      .getRawOne<{
        totalNegative: string | number;
        reviewed: string | number;
        unreviewed: string | number;
      }>();

    const byBranchRaw = await this.trackers
      .createQueryBuilder('t')
      .select('t.branchCode', 'branchCode')
      .addSelect('COUNT(*)', 'total')
      .addSelect(
        'COALESCE(SUM(CASE WHEN t.reviewedAt IS NOT NULL THEN 1 ELSE 0 END), 0)',
        'reviewed',
      )
      .addSelect(
        'COALESCE(SUM(CASE WHEN t.reviewedAt IS NULL THEN 1 ELSE 0 END), 0)',
        'unreviewed',
      )
      .where('t.isNegativeInventory = :neg', { neg: true })
      .groupBy('t.branchCode')
      .orderBy('t.branchCode', 'ASC')
      .getRawMany<{
        branchCode: string;
        total: string | number;
        reviewed: string | number;
        unreviewed: string | number;
      }>();

    const byBranch: InventoryBranchStatsRow[] = byBranchRaw.map((r) => ({
      branchCode: r.branchCode,
      total: Number(r.total),
      reviewed: Number(r.reviewed),
      unreviewed: Number(r.unreviewed),
    }));

    return {
      totalNegative: Number(summary?.totalNegative ?? 0),
      reviewed: Number(summary?.reviewed ?? 0),
      unreviewed: Number(summary?.unreviewed ?? 0),
      byBranch,
    };
  }

  async getAlertHistory(limit = 50) {
    return this.trackers.find({
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }
}
