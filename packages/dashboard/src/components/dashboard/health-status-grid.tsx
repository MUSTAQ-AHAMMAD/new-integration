'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

function statusConfig(status: string) {
  const map: Record<string, { dot: string; pulse: string; badge: string; label: string }> = {
    HEALTHY: {
      dot: 'bg-emerald-500',
      pulse: 'bg-emerald-500',
      badge: 'text-emerald-700 bg-emerald-50 ring-emerald-200',
      label: 'Healthy',
    },
    DEGRADED: {
      dot: 'bg-amber-400',
      pulse: 'bg-amber-400',
      badge: 'text-amber-700 bg-amber-50 ring-amber-200',
      label: 'Degraded',
    },
    UNHEALTHY: {
      dot: 'bg-red-500',
      pulse: 'bg-red-500',
      badge: 'text-red-700 bg-red-50 ring-red-200',
      label: 'Unhealthy',
    },
  };
  return map[status] ?? { dot: 'bg-slate-400', pulse: 'bg-slate-400', badge: 'text-slate-600 bg-slate-100 ring-slate-200', label: status };
}

export function HealthStatusGrid() {
  const { data: checks } = useQuery({
    queryKey: ['health-status'],
    queryFn: api.getHealthStatus,
    refetchInterval: 30000,
  });

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle>Service Health</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          {checks?.map((check) => {
            const cfg = statusConfig(check.status);
            return (
              <div
                key={check.id}
                className="flex flex-col items-center gap-2 rounded-xl border border-slate-200 bg-slate-50/50 px-3 py-4 transition-shadow hover:shadow-sm"
              >
                {/* Pulsing dot */}
                <div className="relative flex h-4 w-4 items-center justify-center">
                  {check.status === 'HEALTHY' && (
                    <span className={cn('absolute inline-flex h-4 w-4 animate-ping rounded-full opacity-30', cfg.pulse)} />
                  )}
                  <span className={cn('relative h-3 w-3 rounded-full', cfg.dot)} />
                </div>
                <p className="text-center text-xs font-semibold text-slate-700">{check.serviceName}</p>
                <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-bold ring-1', cfg.badge)}>
                  {cfg.label}
                </span>
                <p className="text-[11px] tabular-nums text-slate-400">{check.responseTimeMs} ms</p>
              </div>
            );
          })}
          {(!checks || checks.length === 0) && (
            <div className="col-span-6 py-4 text-center text-sm text-slate-400">No health data available</div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
