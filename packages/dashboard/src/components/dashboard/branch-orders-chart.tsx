'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip, Legend } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#f97316', '#ec4899'];

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
      <CardHeader className="pb-4">
        <CardTitle>Orders by Branch</CardTitle>
        <p className="text-xs text-slate-500">Distribution across locations</p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="h-64 animate-pulse rounded-lg bg-slate-100" />
        ) : chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie
                data={chartData}
                cx="50%"
                cy="45%"
                outerRadius={85}
                innerRadius={40}
                paddingAngle={3}
                dataKey="value"
              >
                {chartData.map((entry, index) => (
                  <Cell key={entry.name} fill={COLORS[index % COLORS.length]} stroke="transparent" />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{ borderRadius: '8px', border: '1px solid #e2e8f0', fontSize: '12px', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
              />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
            </PieChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-64 items-center justify-center text-sm text-slate-400">No branch data available</div>
        )}
      </CardContent>
    </Card>
  );
}
