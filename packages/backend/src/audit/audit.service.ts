import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditSearchParams {
  orderId?: string;
  entityType?: string;
  action?: string;
  startDate?: string;
  endDate?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface AuditLogRecord {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  branchCode?: string | null;
  userId?: string | null;
  requestPayload: unknown;
  responsePayload?: unknown;
  errorMessage?: string | null;
  statusCode?: number | null;
  durationMs?: number | null;
  correlationId?: string | null;
  createdAt: Date;
}

interface GroupedCountRow {
  key: string;
  count: number;
}

interface AuditTotalsRow {
  total: number;
  errors: number;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async search(params: AuditSearchParams) {
    const conditions: Prisma.Sql[] = [];

    if (params.orderId) {
      conditions.push(Prisma.sql`"entityId" ILIKE ${`%${params.orderId}%`}`);
    }

    if (params.entityType) {
      conditions.push(Prisma.sql`"entityType" = ${params.entityType}`);
    }

    if (params.action) {
      conditions.push(Prisma.sql`"action" = ${params.action}`);
    }

    if (params.startDate) {
      conditions.push(Prisma.sql`"createdAt" >= ${new Date(params.startDate)}`);
    }

    if (params.endDate) {
      conditions.push(Prisma.sql`"createdAt" <= ${new Date(params.endDate)}`);
    }

    if (params.status) {
      const normalizedStatus = params.status.toLowerCase();
      if (normalizedStatus === 'success') {
        conditions.push(Prisma.sql`COALESCE("statusCode", 0) < 400`);
      } else if (
        normalizedStatus === 'failed' ||
        normalizedStatus === 'error'
      ) {
        conditions.push(Prisma.sql`COALESCE("statusCode", 500) >= 400`);
      } else {
        conditions.push(
          Prisma.sql`CAST(COALESCE("statusCode", 0) AS TEXT) = ${params.status}`,
        );
      }
    }

    const whereClause = conditions.length
      ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
      : Prisma.empty;
    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;

    this.logger.debug('Searching audit log entries');

    return this.prisma.$queryRaw<AuditLogRecord[]>(Prisma.sql`
      SELECT *
      FROM "AuditLog"
      ${whereClause}
      ORDER BY "createdAt" DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `);
  }

  async getEntry(id: string) {
    const [entry] = await this.prisma.$queryRaw<AuditLogRecord[]>(Prisma.sql`
      SELECT *
      FROM "AuditLog"
      WHERE "id" = ${id}
      LIMIT 1
    `);

    if (!entry) {
      throw new NotFoundException(`Audit log entry ${id} not found`);
    }

    return entry;
  }

  async getStats() {
    const [actions, entityTypes, totals] = await Promise.all([
      this.prisma.$queryRaw<GroupedCountRow[]>(Prisma.sql`
        SELECT "action" AS "key", COUNT(*)::int AS "count"
        FROM "AuditLog"
        GROUP BY "action"
        ORDER BY "action" ASC
      `),
      this.prisma.$queryRaw<GroupedCountRow[]>(Prisma.sql`
        SELECT "entityType" AS "key", COUNT(*)::int AS "count"
        FROM "AuditLog"
        GROUP BY "entityType"
        ORDER BY "entityType" ASC
      `),
      this.prisma.$queryRaw<AuditTotalsRow[]>(Prisma.sql`
        SELECT
          COUNT(*)::int AS "total",
          COALESCE(SUM(CASE WHEN COALESCE("statusCode", 0) >= 400 THEN 1 ELSE 0 END), 0)::int AS "errors"
        FROM "AuditLog"
      `),
    ]);

    const total = totals[0]?.total ?? 0;
    const errors = totals[0]?.errors ?? 0;

    return {
      byAction: actions.map((row) => ({ action: row.key, count: row.count })),
      byEntityType: entityTypes.map((row) => ({
        entityType: row.key,
        count: row.count,
      })),
      errorRate: total === 0 ? 0 : Number((errors / total).toFixed(4)),
      total,
      errors,
    };
  }
}
