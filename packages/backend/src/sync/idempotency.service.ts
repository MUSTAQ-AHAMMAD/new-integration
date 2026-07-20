import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash } from 'crypto';
import { AuditLog } from '../database/entities/audit-log.entity';
import { AuditOperation, AuditStatus } from '../database/enums';

@Injectable()
export class IdempotencyService {
  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
  ) {}

  generateKey(
    externalId: string,
    operation: AuditOperation,
    additionalContext = '',
  ): string {
    return createHash('sha256')
      .update(`${externalId}:${operation}:${additionalContext}`)
      .digest('hex');
  }

  async isDuplicate(idempotencyKey: string): Promise<boolean> {
    const existing = await this.auditLogs.findOne({
      where: { idempotencyKey },
    });
    return (
      existing !== null &&
      (existing.status === AuditStatus.SUCCESS ||
        existing.status === AuditStatus.DUPLICATE)
    );
  }

  async recordOperation(params: {
    idempotencyKey: string;
    externalId: string;
    externalSystem: string;
    targetSystem: string;
    operation: AuditOperation;
    status: AuditStatus;
    requestPayload: object;
    responsePayload?: object;
    oracleResponseId?: string;
    errorMessage?: string;
    errorCode?: string;
    processingDurationMs: number;
  }): Promise<AuditLog> {
    const existing = await this.auditLogs.findOne({
      where: { idempotencyKey: params.idempotencyKey },
    });

    if (existing) {
      // Mirror Prisma's `attempts: { increment: 1 }` on update.
      existing.status = params.status;
      existing.responsePayload = params.responsePayload ?? null;
      existing.oracleResponseId = params.oracleResponseId ?? null;
      existing.errorMessage = params.errorMessage ?? null;
      existing.attempts = (existing.attempts ?? 0) + 1;
      return this.auditLogs.save(existing);
    }

    const created = this.auditLogs.create({
      idempotencyKey: params.idempotencyKey,
      externalId: params.externalId,
      externalSystem: params.externalSystem,
      targetSystem: params.targetSystem,
      operation: params.operation,
      status: params.status,
      requestPayload: params.requestPayload,
      responsePayload: params.responsePayload ?? null,
      oracleResponseId: params.oracleResponseId ?? null,
      errorMessage: params.errorMessage ?? null,
      errorCode: params.errorCode ?? null,
      processingDurationMs: params.processingDurationMs,
      syncDate: new Date(),
    });
    return this.auditLogs.save(created);
  }
}
