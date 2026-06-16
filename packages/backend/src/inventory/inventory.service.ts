import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface ListNegativeInventoryParams {
  branchCode?: string;
  limit?: number;
}

export interface InventoryRecord {
  id: string;
  productSku: string;
  productName?: string | null;
  branchCode: string;
  quantityChange: Prisma.Decimal | number | string;
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

  constructor(private readonly prisma: PrismaService) {}

  async listNegativeInventory(params?: ListNegativeInventoryParams) {
    const conditions: Prisma.Sql[] = [Prisma.sql`"isNegativeInventory" = TRUE`];

    if (params?.branchCode) {
      conditions.push(Prisma.sql`"branchCode" = ${params.branchCode}`);
    }

    const take = params?.limit ?? 50;

    return this.prisma.$queryRaw<InventoryRecord[]>(Prisma.sql`
      SELECT *
      FROM "InventorySyncTracker"
      WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY "createdAt" DESC
      LIMIT ${take}
    `);
  }

  async markAsReviewed(id: string, reviewedBy: string, reviewNote?: string) {
    const [record] = await this.prisma.$queryRaw<InventoryRecord[]>(Prisma.sql`
      UPDATE "InventorySyncTracker"
      SET
        "reviewedAt" = NOW(),
        "reviewedBy" = ${reviewedBy},
        "reviewNote" = ${reviewNote ?? null}
      WHERE "id" = ${id}
      RETURNING *
    `);

    if (!record) {
      throw new NotFoundException(`Inventory tracker ${id} not found`);
    }

    this.logger.log(`Inventory tracker ${id} reviewed by ${reviewedBy}`);
    return record;
  }

  async getInventoryStats() {
    const [summary, byBranch] = await Promise.all([
      this.prisma.$queryRaw<InventoryStatsRow[]>(Prisma.sql`
        SELECT
          COUNT(*)::int AS "totalNegative",
          COALESCE(SUM(CASE WHEN "reviewedAt" IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS "reviewed",
          COALESCE(SUM(CASE WHEN "reviewedAt" IS NULL THEN 1 ELSE 0 END), 0)::int AS "unreviewed"
        FROM "InventorySyncTracker"
        WHERE "isNegativeInventory" = TRUE
      `),
      this.prisma.$queryRaw<InventoryBranchStatsRow[]>(Prisma.sql`
        SELECT
          "branchCode",
          COUNT(*)::int AS "total",
          COALESCE(SUM(CASE WHEN "reviewedAt" IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS "reviewed",
          COALESCE(SUM(CASE WHEN "reviewedAt" IS NULL THEN 1 ELSE 0 END), 0)::int AS "unreviewed"
        FROM "InventorySyncTracker"
        WHERE "isNegativeInventory" = TRUE
        GROUP BY "branchCode"
        ORDER BY "branchCode" ASC
      `),
    ]);

    return {
      totalNegative: summary[0]?.totalNegative ?? 0,
      reviewed: summary[0]?.reviewed ?? 0,
      unreviewed: summary[0]?.unreviewed ?? 0,
      byBranch,
    };
  }

  async getAlertHistory(limit = 50) {
    return this.prisma.$queryRaw<InventoryRecord[]>(Prisma.sql`
      SELECT *
      FROM "InventorySyncTracker"
      ORDER BY "createdAt" DESC
      LIMIT ${limit}
    `);
  }
}
