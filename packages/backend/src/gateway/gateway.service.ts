import { Injectable } from '@nestjs/common';
import { IntegrationGateway } from './integration.gateway';

@Injectable()
export class GatewayService {
  constructor(private readonly gateway: IntegrationGateway) {}

  emitOrderStatus(data: { orderId: string; status: string }) {
    this.gateway.server?.emit('orderStatus', data);
  }

  emitSyncJobUpdate(data: {
    jobId: string;
    status: string;
    progress?: number;
  }) {
    this.gateway.server?.emit('syncJobUpdate', data);
  }

  emitAlert(data: { type: string; severity: string; message: string }) {
    this.gateway.server?.emit('alert', data);
  }

  emitHealthUpdate(data: { service: string; status: string }) {
    this.gateway.server?.emit('healthUpdate', data);
  }
}
