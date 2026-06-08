'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { getStatusColor } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function HealthStatusGrid() {
  const { data: checks } = useQuery({
    queryKey: ['health-status'],
    queryFn: api.getHealthStatus,
    refetchInterval: 30000,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Service Health</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          {checks?.map((check) => (
            <div key={check.id} className="flex flex-col items-center rounded-lg border p-3">
              <div
                className={`mb-2 h-3 w-3 rounded-full ${
                  check.status === 'HEALTHY' ? 'bg-green-500' : check.status === 'DEGRADED' ? 'bg-yellow-500' : 'bg-red-500'
                }`}
              />
              <p className="text-xs font-medium text-gray-700">{check.serviceName}</p>
              <span className={`mt-1 rounded px-1.5 py-0.5 text-xs ${getStatusColor(check.status)}`}>{check.status}</span>
              <p className="mt-0.5 text-xs text-gray-400">{check.responseTimeMs}ms</p>
            </div>
          ))}
          {(!checks || checks.length === 0) && (
            <div className="col-span-6 py-4 text-center text-sm text-gray-400">No health data available</div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
