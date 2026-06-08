'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { getSeverityColor } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function AlertsPanel() {
  const { data: alerts } = useQuery({
    queryKey: ['alerts-panel'],
    queryFn: () => api.listAlerts({ resolved: false }),
    refetchInterval: 15000,
  });

  return (
    <Card className="h-full">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Active Alerts</CardTitle>
        <Link href="/alerts" className="text-xs text-blue-600 hover:underline">
          View all
        </Link>
      </CardHeader>
      <CardContent>
        <div className="max-h-64 space-y-2 overflow-y-auto">
          {alerts?.slice(0, 10).map((alert) => (
            <div key={alert.id} className="flex items-start gap-2 rounded border p-2">
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-bold ${getSeverityColor(alert.severity)}`}>
                {alert.severity}
              </span>
              <div className="min-w-0">
                <p className="truncate text-xs font-medium">{alert.title}</p>
                <p className="truncate text-xs text-gray-400">{alert.message}</p>
              </div>
            </div>
          ))}
          {(!alerts || alerts.length === 0) && <div className="py-6 text-center text-sm text-green-500">✓ No active alerts</div>}
        </div>
      </CardContent>
    </Card>
  );
}
