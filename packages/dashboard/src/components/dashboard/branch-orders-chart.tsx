'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip, Legend } from 'recharts';
import { GitBranch } from 'lucide-react';

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
    <div className="overflow-hidden rounded-2xl border border-white/60 bg-white shadow-md shadow-slate-200/60">
      {/* Coloured header band */}
      <div className="border-b border-slate-100 bg-gradient-to-r from-emerald-50 to-teal-50 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 shadow-md shadow-emerald-200">
            <GitBranch className="h-5 w-5 text-white" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-800">Orders by Branch</h3>
            <p className="text-xs text-slate-500">Distribution across locations</p>
          </div>
        </div>
      </div>

      <div className="p-6">
        {isLoading ? (
          <div className="h-64 animate-pulse rounded-xl bg-slate-100" />
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
                contentStyle={{
                  borderRadius: '12px',
                  border: '1px solid #e2e8f0',
                  fontSize: '12px',
                  boxShadow: '0 10px 25px -5px rgb(0 0 0 / 0.15)',
                  background: 'white',
                }}
              />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
            </PieChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-64 flex-col items-center justify-center gap-2">
            <GitBranch className="h-10 w-10 text-slate-200" />
            <p className="text-sm font-medium text-slate-400">No branch data available</p>
          </div>
        )}
      </div>
    </div>
  );
}

