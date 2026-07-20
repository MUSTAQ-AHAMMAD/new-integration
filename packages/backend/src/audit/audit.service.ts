import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog } from '../database/entities/audit-log.entity';
import { AuditStatus } from '../database/enums';

export interface AuditSearchParams {
  /** Free-text match against the external (source) id. */
  orderId?: string;
  /** Maps to the external system that produced the operation. */
  entityType?: string;
  /** Maps to the audited operation (e.g. CREATE_INVOICE). */
  action?: string;
  startDate?: string;
  endDate?: string;
  /** 'success' | 'failed' | 'error' | an exact AuditStatus value. */
  status?: string;
  limit?: number;
  offset?: number;
}

interface GroupedCountRow {
  key: string;
  count: number;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly audit: Repository<AuditLog>,
  ) {}

  async search(params: AuditSearchParams) {
    const qb = this.audit.createQueryBuilder('a');

    if (params.orderId) {
      qb.andWhere('UPPER(a.externalId) LIKE UPPER(:orderId)', {
        orderId: `%${params.orderId}%`,
      });
    }
    if (params.entityType) {
      qb.andWhere('a.externalSystem = :entityType', {
        entityType: params.entityType,
      });
    }
    if (params.action) {
      qb.andWhere('a.operation = :action', { action: params.action });
    }
    if (params.startDate) {
      qb.andWhere('a.createdAt >= :startDate', {
        startDate: new Date(params.startDate),
      });
    }
    if (params.endDate) {
      qb.andWhere('a.createdAt <= :endDate', {
        endDate: new Date(params.endDate),
      });
    }
    if (params.status) {
      const normalized = params.status.toLowerCase();
      if (normalized === 'success') {
        qb.andWhere('a.status = :status', { status: AuditStatus.SUCCESS });
      } else if (normalized === 'failed' || normalized === 'error') {
        qb.andWhere('a.status = :status', { status: AuditStatus.FAILED });
      } else {
        qb.andWhere('a.status = :status', { status: params.status });
      }
    }

    this.logger.debug('Searching audit log entries');

    return qb
      .orderBy('a.createdAt', 'DESC')
      .take(params.limit ?? 50)
      .skip(params.offset ?? 0)
      .getMany();
  }

  async getEntry(id: string) {
    const entry = await this.audit.findOne({ where: { id } });
    if (!entry) {
      throw new NotFoundException(`Audit log entry ${id} not found`);
    }
    return entry;
  }

  async getStats() {
    const [actions, entityTypes, total, errors] = await Promise.all([
      this.audit
        .createQueryBuilder('a')
        .select('a.operation', 'key')
        .addSelect('COUNT(*)', 'count')
        .groupBy('a.operation')
        .orderBy('a.operation', 'ASC')
        .getRawMany<GroupedCountRow>(),
      this.audit
        .createQueryBuilder('a')
        .select('a.externalSystem', 'key')
        .addSelect('COUNT(*)', 'count')
        .groupBy('a.externalSystem')
        .orderBy('a.externalSystem', 'ASC')
        .getRawMany<GroupedCountRow>(),
      this.audit.count(),
      this.audit.count({ where: { status: AuditStatus.FAILED } }),
    ]);

    return {
      byAction: actions.map((row) => ({
        action: row.key,
        count: Number(row.count),
      })),
      byEntityType: entityTypes.map((row) => ({
        entityType: row.key,
        count: Number(row.count),
      })),
      errorRate: total === 0 ? 0 : Number((errors / total).toFixed(4)),
      total,
      errors,
    };
  }
}
