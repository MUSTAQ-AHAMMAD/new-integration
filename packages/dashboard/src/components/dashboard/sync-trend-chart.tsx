'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function SyncTrendChart() {
  const { data, isLoading } = useQuery({
    queryKey: ['sync-trend'],
    queryFn: () => api.getSyncTrend(7),
    refetchInterval: 60000,
  });

  const chartData = data?.map((item) => ({
    status: item.status,
    count: item._count.id,
  })) || [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sync Status Distribution (7 days)</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="h-64 animate-pulse rounded bg-gray-50" />
        ) : (
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="status" tick={{ fontSize: 12 }} />
              <YAxis />
              <Tooltip />
              <Bar dataKey="count" fill="#3b82f6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
