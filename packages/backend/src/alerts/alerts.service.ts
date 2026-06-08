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

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: GatewayService,
  ) {}

  async createAlert(dto: CreateAlertDto) {
    const alert = await this.prisma.alertLog.create({ data: dto });
    this.logger.warn(`[ALERT ${dto.severity}] ${dto.title}: ${dto.message}`);
    this.gateway.emitAlert({ type: dto.alertType, severity: dto.severity, message: dto.message });
    return alert;
  }

  async listAlerts(params?: { severity?: AlertSeverity; isResolved?: boolean; limit?: number }) {
    return this.prisma.alertLog.findMany({
      where: {
        ...(params?.severity ? { severity: params.severity } : {}),
        ...(params?.isResolved !== undefined ? { isResolved: params.isResolved } : {}),
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
