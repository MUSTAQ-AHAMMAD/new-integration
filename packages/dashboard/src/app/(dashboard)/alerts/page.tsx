'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDate, getSeverityColor } from '@/lib/utils';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/error-state';

export default function AlertsPage() {
  const qc = useQueryClient();
  const { data: alerts, isLoading, isError } = useQuery({
    queryKey: ['alerts'],
    queryFn: () => api.listAlerts({ resolved: false }),
    refetchInterval: 10000,
  });

  const resolveMutation = useMutation({
    mutationFn: (id: string) => api.resolveAlert(id, 'DASHBOARD_USER'),
    onSuccess: () => {
      toast.success('Alert resolved');
      qc.invalidateQueries({ queryKey: ['alerts'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
        <div className="h-8 w-1 shrink-0 rounded-full bg-indigo-500" />
        <h1 className="text-xl font-bold text-slate-900">Alerts</h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Active Alerts ({alerts?.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-8 text-center text-gray-400">Loading...</div>
          ) : isError ? (
            <ErrorState />
          ) : (
            <div className="space-y-3">
              {alerts?.map((alert) => (
                <div key={alert.id} className="flex items-start justify-between rounded-lg border p-4 hover:bg-gray-50">
                  <div className="flex gap-3">
                    <span className={`inline-flex items-center rounded px-2 py-1 text-xs font-bold ${getSeverityColor(alert.severity)}`}>
                      {alert.severity}
                    </span>
                    <div>
                      <p className="font-medium text-gray-900">{alert.title}</p>
                      <p className="mt-0.5 text-sm text-gray-500">{alert.message}</p>
                      <p className="mt-1 text-xs text-gray-400">{formatDate(alert.createdAt)}</p>
                    </div>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => resolveMutation.mutate(alert.id)}>
                    Resolve
                  </Button>
                </div>
              ))}
              {(!alerts || alerts.length === 0) && <div className="py-8 text-center text-green-500">✓ No active alerts</div>}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
