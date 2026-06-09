import { Injectable } from '@nestjs/common';
import { AuditOperation, AuditStatus } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

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
    const existing = await this.prisma.auditLog.findUnique({
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
  }) {
    return this.prisma.auditLog.upsert({
      where: { idempotencyKey: params.idempotencyKey },
      create: { ...params, syncDate: new Date() },
      update: {
        status: params.status,
        responsePayload: params.responsePayload,
        oracleResponseId: params.oracleResponseId,
        errorMessage: params.errorMessage,
        attempts: { increment: 1 },
      },
    });
  }
}
