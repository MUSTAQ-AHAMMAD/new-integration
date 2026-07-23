'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { BarChart2 } from 'lucide-react';

export function SyncTrendChart() {
  const { data, isLoading } = useQuery({
    queryKey: ['sync-trend'],
    queryFn: () => api.getSyncTrend(7),
    refetchInterval: 60000,
  });

  const chartData = data?.map((item) => ({
    status: item.status,
    count: item.count,
  })) || [];

  return (
    <div className="overflow-hidden rounded-2xl border border-white/60 bg-white shadow-md shadow-slate-200/60">
      {/* Coloured header band */}
      <div className="border-b border-slate-100 bg-gradient-to-r from-indigo-50 to-purple-50 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 shadow-md shadow-indigo-200">
            <BarChart2 className="h-4.5 w-4.5 text-white h-5 w-5" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-800">Sync Status Distribution</h3>
            <p className="text-xs text-slate-500">Last 7 days</p>
          </div>
        </div>
      </div>

      <div className="p-6">
        {isLoading ? (
          <div className="h-64 animate-pulse rounded-xl bg-slate-100" />
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={chartData} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
              <defs>
                <linearGradient id="barGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#6366f1" />
                  <stop offset="100%" stopColor="#8b5cf6" />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
              <XAxis dataKey="status" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={{
                  borderRadius: '12px',
                  border: '1px solid #e2e8f0',
                  fontSize: '12px',
                  boxShadow: '0 10px 25px -5px rgb(0 0 0 / 0.15)',
                  background: 'white',
                }}
                cursor={{ fill: '#f8fafc', radius: 4 }}
              />
              <Bar dataKey="count" fill="url(#barGradient)" radius={[8, 8, 0, 0]} maxBarSize={60} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

