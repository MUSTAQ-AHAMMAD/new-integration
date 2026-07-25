'use client';

import { useEffect, useState } from 'react';
import { getSocket } from '@/lib/websocket';

export interface LiveEvent {
  id: number;
  at: number;
  type: 'order' | 'job' | 'integration' | 'alert' | 'health';
  message: string;
}

const s = (v: unknown) => (v == null ? '' : String(v));
const short = (v: unknown) => (v ? String(v).slice(0, 8) : '');

/**
 * Subscribes to the backend websocket and keeps a rolling buffer of the most
 * recent live events WITH their payloads (progress, phase, counters) — which
 * the cache-invalidation hook throws away. Powers the Live Activity feed.
 */
export function useLiveActivity(max = 40): LiveEvent[] {
  const [events, setEvents] = useState<LiveEvent[]>([]);

  useEffect(() => {
    const socket = getSocket();
    let seq = 0;
    const push = (type: LiveEvent['type'], message: string) =>
      setEvents((prev) =>
        [{ id: ++seq, at: Date.now(), type, message }, ...prev].slice(0, max),
      );

    const onOrder = (p: Record<string, unknown> = {}) =>
      push(
        'order',
        `Order ${s(p.odooOrderId) || s(p.orderId) || s(p.orderNumber)} → ${
          s(p.status) || 'update'
        }`.trim(),
      );
    const onJob = (p: Record<string, unknown> = {}) =>
      push(
        'job',
        `Job ${short(p.jobId)} ${s(p.status)}${
          p.progress != null ? ` · ${s(p.progress)}%` : ''
        }`.trim(),
      );
    const onIntegration = (p: Record<string, unknown> = {}) =>
      push(
        'integration',
        `${p.phase ? `[${s(p.phase)}] ` : ''}${s(p.message) || s(p.status)}`.trim(),
      );
    const onAlert = (p: Record<string, unknown> = {}) =>
      push('alert', s(p.title) || s(p.message) || 'New alert');
    const onHealth = (p: Record<string, unknown> = {}) =>
      push('health', `${s(p.service) || 'service'} ${s(p.status) || 'update'}`);

    socket.on('orderStatus', onOrder);
    socket.on('syncJobUpdate', onJob);
    socket.on('integrationRun', onIntegration);
    socket.on('alert', onAlert);
    socket.on('healthUpdate', onHealth);
    return () => {
      socket.off('orderStatus', onOrder);
      socket.off('syncJobUpdate', onJob);
      socket.off('integrationRun', onIntegration);
      socket.off('alert', onAlert);
      socket.off('healthUpdate', onHealth);
    };
  }, [max]);

  return events;
}
