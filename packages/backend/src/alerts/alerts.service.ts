import { Injectable, Logger } from '@nestjs/common';
import { AlertSeverity } from '@prisma/client';
import { GatewayService } from '../gateway/gateway.service';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateAlertDto {
  alertType: import('@prisma/client').AlertType;
  severity: import('@prisma/client').AlertSeverity;
  title: string;
  message: string;
  relatedEntityId?: string;
  relatedEntityType?: string;
}

/**
 * An identical unresolved alert for the same entity will not be duplicated
 * within this window. This prevents alert storms when a processor error
 * fires on every queue retry within a short period.
 */
const DEDUP_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: GatewayService,
  ) {}

  async createAlert(dto: CreateAlertDto) {
    // Deduplicate: skip creation if an identical unresolved alert already
    // exists for the same alertType + relatedEntityId within the dedup window.
    const dedupSince = new Date(Date.now() - DEDUP_WINDOW_MS);
    const existing = await this.prisma.alertLog.findFirst({
      where: {
        alertType: dto.alertType,
        isResolved: false,
        ...(dto.relatedEntityId
          ? { relatedEntityId: dto.relatedEntityId }
          : {}),
        createdAt: { gte: dedupSince },
      },
      select: { id: true },
    });

    if (existing) {
      this.logger.debug(
        `Alert deduplicated (${dto.alertType} / ${dto.relatedEntityId ?? 'global'}): ${dto.title}`,
      );
      return existing;
    }

    const alert = await this.prisma.alertLog.create({ data: dto });
    this.logger.warn(`[ALERT ${dto.severity}] ${dto.title}: ${dto.message}`);
    this.gateway.emitAlert({
      type: dto.alertType,
      severity: dto.severity,
      message: dto.message,
    });
    return alert;
  }

  async listAlerts(params?: {
    severity?: AlertSeverity;
    isResolved?: boolean;
    limit?: number;
  }) {
    return this.prisma.alertLog.findMany({
      where: {
        ...(params?.severity ? { severity: params.severity } : {}),
        ...(params?.isResolved !== undefined
          ? { isResolved: params.isResolved }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: params?.limit || 50,
    });
  }

  async resolveAlert(id: string, resolvedBy: string) {
    return this.prisma.alertLog.update({
      where: { id },
      data: { isResolved: true, resolvedAt: new Date(), resolvedBy },
    });
  }
}
