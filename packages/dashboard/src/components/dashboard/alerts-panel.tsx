'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { ArrowRight, Bell, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';

function severityStyles(severity: string) {
  const map: Record<string, { dot: string; badge: string; bg: string; border: string }> = {
    CRITICAL: { dot: 'bg-red-500', badge: 'text-red-700 bg-red-100 ring-red-300', bg: 'bg-red-50/70', border: 'border-l-red-500' },
    ERROR: { dot: 'bg-red-400', badge: 'text-red-600 bg-red-50 ring-red-200', bg: 'bg-red-50/40', border: 'border-l-red-400' },
    WARNING: { dot: 'bg-amber-400', badge: 'text-amber-700 bg-amber-50 ring-amber-200', bg: 'bg-amber-50/40', border: 'border-l-amber-400' },
    INFO: { dot: 'bg-blue-400', badge: 'text-blue-700 bg-blue-50 ring-blue-200', bg: 'bg-blue-50/30', border: 'border-l-blue-400' },
  };
  return map[severity] ?? { dot: 'bg-slate-400', badge: 'text-slate-600 bg-slate-100 ring-slate-200', bg: 'bg-slate-50', border: 'border-l-slate-400' };
}

export function AlertsPanel() {
  const { data: alerts } = useQuery({
    queryKey: ['alerts-panel'],
    queryFn: () => api.listAlerts({ resolved: false }),
    refetchInterval: 15000,
  });

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-white/60 bg-white shadow-md shadow-slate-200/60">
      {/* Header band */}
      <div className="border-b border-slate-100 bg-gradient-to-r from-red-50 to-rose-50 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-red-500 to-rose-600 shadow-md shadow-red-200">
              <Bell className="h-5 w-5 text-white" />
            </div>
            <h3 className="text-sm font-bold text-slate-800">Active Alerts</h3>
          </div>
          <Link
            href="/alerts"
            className="flex items-center gap-1.5 rounded-lg bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-600 transition-colors hover:bg-red-100"
          >
            View all <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="space-y-2">
          {alerts?.slice(0, 10).map((alert) => {
            const s = severityStyles(alert.severity);
            return (
              <div
                key={alert.id}
                className={cn(
                  'flex items-start gap-3 rounded-xl border border-transparent border-l-2 px-3 py-2.5 transition-all hover:shadow-sm',
                  s.bg,
                  s.border,
                )}
              >
                <div className="mt-0.5 shrink-0">
                  <span className={cn('h-2 w-2 rounded-full block mt-1', s.dot)} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1', s.badge)}>
                      {alert.severity}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-xs font-semibold text-slate-800">{alert.title}</p>
                  <p className="truncate text-xs text-slate-400">{alert.message}</p>
                </div>
              </div>
            );
          })}
          {(!alerts || alerts.length === 0) && (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50">
                <CheckCircle2 className="h-8 w-8 text-emerald-400" />
              </div>
              <p className="text-sm font-bold text-emerald-600">All clear!</p>
              <p className="mt-1 text-xs text-slate-400">No active alerts</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

