'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Activity } from 'lucide-react';
import { cn } from '@/lib/utils';

function statusConfig(status: string) {
  const map: Record<string, { dot: string; pulse: string; badge: string; label: string; bg: string; border: string }> = {
    HEALTHY: {
      dot: 'bg-emerald-500',
      pulse: 'bg-emerald-500',
      badge: 'text-emerald-700 bg-emerald-100 ring-emerald-200',
      label: 'Healthy',
      bg: 'bg-gradient-to-b from-emerald-50 to-white',
      border: 'border-emerald-200',
    },
    DEGRADED: {
      dot: 'bg-amber-400',
      pulse: 'bg-amber-400',
      badge: 'text-amber-700 bg-amber-100 ring-amber-200',
      label: 'Degraded',
      bg: 'bg-gradient-to-b from-amber-50 to-white',
      border: 'border-amber-200',
    },
    UNHEALTHY: {
      dot: 'bg-red-500',
      pulse: 'bg-red-500',
      badge: 'text-red-700 bg-red-100 ring-red-200',
      label: 'Unhealthy',
      bg: 'bg-gradient-to-b from-red-50 to-white',
      border: 'border-red-200',
    },
  };
  return map[status] ?? {
    dot: 'bg-slate-400',
    pulse: 'bg-slate-400',
    badge: 'text-slate-600 bg-slate-100 ring-slate-200',
    label: status,
    bg: 'bg-gradient-to-b from-slate-50 to-white',
    border: 'border-slate-200',
  };
}

export function HealthStatusGrid() {
  const { data: checks } = useQuery({
    queryKey: ['health-status'],
    queryFn: api.getHealthStatus,
    refetchInterval: 30000,
  });

  return (
    <div className="overflow-hidden rounded-2xl border border-white/60 bg-white shadow-md shadow-slate-200/60">
      {/* Header band */}
      <div className="border-b border-slate-100 bg-gradient-to-r from-slate-50 to-slate-100 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-slate-700 to-slate-900 shadow-md shadow-slate-300">
            <Activity className="h-5 w-5 text-white" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-800">Service Health</h3>
            <p className="text-xs text-slate-500">Real-time service status</p>
          </div>
        </div>
      </div>

      <div className="p-6">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
          {checks?.map((check) => {
            const cfg = statusConfig(check.status);
            return (
              <div
                key={check.id}
                className={cn(
                  'flex flex-col items-center gap-2.5 rounded-2xl border px-3 py-5 transition-all hover:-translate-y-0.5 hover:shadow-md',
                  cfg.bg,
                  cfg.border,
                )}
              >
                {/* Pulsing dot */}
                <div className="relative flex h-5 w-5 items-center justify-center">
                  {check.status === 'HEALTHY' && (
                    <span className={cn('absolute inline-flex h-5 w-5 animate-ping rounded-full opacity-25', cfg.pulse)} />
                  )}
                  <span className={cn('relative h-3.5 w-3.5 rounded-full shadow-sm', cfg.dot)} />
                </div>
                <p className="text-center text-xs font-bold text-slate-700">{check.serviceName}</p>
                <span className={cn('rounded-full px-2.5 py-0.5 text-[10px] font-bold ring-1', cfg.badge)}>
                  {cfg.label}
                </span>
                <p className="rounded-lg bg-white/70 px-2 py-0.5 text-[11px] font-mono tabular-nums text-slate-500 shadow-sm">
                  {check.responseTimeMs} ms
                </p>
              </div>
            );
          })}
          {(!checks || checks.length === 0) && (
            <div className="col-span-6 flex flex-col items-center py-8 text-center">
              <Activity className="mb-2 h-8 w-8 text-slate-200" />
              <p className="text-sm font-medium text-slate-400">No health data available</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

