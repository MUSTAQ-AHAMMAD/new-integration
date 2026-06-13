'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';

function severityStyles(severity: string) {
  const map: Record<string, { dot: string; badge: string; bg: string }> = {
    CRITICAL: { dot: 'bg-red-500', badge: 'text-red-700 bg-red-100 ring-red-300', bg: 'bg-red-50/60 hover:bg-red-50' },
    ERROR: { dot: 'bg-red-400', badge: 'text-red-600 bg-red-50 ring-red-200', bg: 'bg-red-50/30 hover:bg-red-50/60' },
    WARNING: { dot: 'bg-amber-400', badge: 'text-amber-700 bg-amber-50 ring-amber-200', bg: 'hover:bg-amber-50/40' },
    INFO: { dot: 'bg-blue-400', badge: 'text-blue-700 bg-blue-50 ring-blue-200', bg: 'hover:bg-blue-50/30' },
  };
  return map[severity] ?? { dot: 'bg-slate-400', badge: 'text-slate-600 bg-slate-100 ring-slate-200', bg: 'hover:bg-slate-50' };
}

export function AlertsPanel() {
  const { data: alerts } = useQuery({
    queryKey: ['alerts-panel'],
    queryFn: () => api.listAlerts({ resolved: false }),
    refetchInterval: 15000,
  });

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="flex flex-row items-center justify-between pb-4">
        <CardTitle>Active Alerts</CardTitle>
        <Link
          href="/alerts"
          className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-800"
        >
          View all <ArrowRight className="h-3 w-3" />
        </Link>
      </CardHeader>
      <CardContent className="flex-1 px-4 pb-4">
        <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
          {alerts?.slice(0, 10).map((alert) => {
            const s = severityStyles(alert.severity);
            return (
              <div
                key={alert.id}
                className={cn('flex items-start gap-3 rounded-lg border border-transparent px-3 py-2.5 transition-colors', s.bg)}
              >
                <div className="mt-1 flex items-center gap-1.5 shrink-0">
                  <span className={cn('h-2 w-2 rounded-full', s.dot)} />
                  <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1', s.badge)}>
                    {alert.severity}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-semibold text-slate-800">{alert.title}</p>
                  <p className="truncate text-xs text-slate-400">{alert.message}</p>
                </div>
              </div>
            );
          })}
          {(!alerts || alerts.length === 0) && (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <CheckCircle2 className="mb-2 h-8 w-8 text-emerald-400" />
              <p className="text-sm font-medium text-emerald-600">All clear</p>
              <p className="text-xs text-slate-400">No active alerts</p>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
