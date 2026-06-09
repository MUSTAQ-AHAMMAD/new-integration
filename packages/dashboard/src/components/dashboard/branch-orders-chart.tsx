'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];

export function BranchOrdersChart() {
  const { data, isLoading } = useQuery({
    queryKey: ['orders-by-branch'],
    queryFn: api.getOrdersByBranch,
    refetchInterval: 60000,
  });

  const branchTotals = data?.reduce<Record<string, number>>((accumulator, item) => {
    accumulator[item.branchCode] = (accumulator[item.branchCode] || 0) + item._count.id;
    return accumulator;
  }, {}) ?? {};

  const chartData = Object.entries(branchTotals).map(([name, value]) => ({ name, value }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Orders by Branch</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="h-64 animate-pulse rounded bg-gray-50" />
        ) : chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie
                data={chartData}
                cx="50%"
                cy="50%"
                outerRadius={80}
                dataKey="value"
                label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}
              >
                {chartData.map((entry, index) => (
                  <Cell key={entry.name} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-64 items-center justify-center text-gray-400">No branch data available</div>
        )}
      </CardContent>
    </Card>
  );
}
