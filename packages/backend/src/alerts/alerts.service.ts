import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { AlertLog } from '../database/entities/alert-log.entity';
import { AlertSeverity, AlertType } from '../database/enums';
import { GatewayService } from '../gateway/gateway.service';

export interface CreateAlertDto {
  alertType: AlertType;
  severity: AlertSeverity;
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
    @InjectRepository(AlertLog)
    private readonly alertLog: Repository<AlertLog>,
    private readonly gateway: GatewayService,
  ) {}

  async createAlert(dto: CreateAlertDto) {
    // Deduplicate: skip creation if an identical unresolved alert already
    // exists for the same alertType + relatedEntityId within the dedup window.
    const dedupSince = new Date(Date.now() - DEDUP_WINDOW_MS);
    const existing = await this.alertLog.findOne({
      where: {
        alertType: dto.alertType,
        isResolved: false,
        relatedEntityId: dto.relatedEntityId,
        createdAt: MoreThanOrEqual(dedupSince),
      },
      select: { id: true },
    });

    if (existing) {
      this.logger.debug(
        `Alert deduplicated (${dto.alertType} / ${dto.relatedEntityId ?? 'global'}): ${dto.title}`,
      );
      return existing;
    }

    const alert = await this.alertLog.save(
      this.alertLog.create({
        alertType: dto.alertType,
        severity: dto.severity,
        title: dto.title,
        message: dto.message,
        relatedEntityId: dto.relatedEntityId ?? null,
        relatedEntityType: dto.relatedEntityType ?? null,
      }),
    );
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
    return this.alertLog.find({
      where: {
        ...(params?.severity ? { severity: params.severity } : {}),
        ...(params?.isResolved !== undefined
          ? { isResolved: params.isResolved }
          : {}),
      },
      order: { createdAt: 'DESC' },
      take: params?.limit || 50,
    });
  }

  async resolveAlert(id: string, resolvedBy: string) {
    await this.alertLog.update(id, {
      isResolved: true,
      resolvedAt: new Date(),
      resolvedBy,
    });
    return this.alertLog.findOne({ where: { id } });
  }
}
