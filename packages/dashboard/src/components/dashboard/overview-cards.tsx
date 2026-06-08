'use client';

import type { ComponentType } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { AlertTriangle, CheckCircle, Clock, Store, TrendingUp, XCircle } from 'lucide-react';

interface StatCardProps {
  title: string;
  value: string | number;
  icon: ComponentType<{ className?: string }>;
  color: string;
  subtitle?: string;
}

function StatCard({ title, value, icon: Icon, color, subtitle }: StatCardProps) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-500">{title}</p>
          <p className="mt-1 text-3xl font-bold text-gray-900">{value}</p>
          {subtitle && <p className="mt-1 text-xs text-gray-400">{subtitle}</p>}
        </div>
        <div className={`rounded-xl p-3 ${color}`}>
          <Icon className="h-6 w-6" />
        </div>
      </div>
    </div>
  );
}

export function OverviewCards() {
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard-overview'],
    queryFn: api.getOverview,
    refetchInterval: 15000,
  });

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="h-28 animate-pulse rounded-xl border border-gray-200 bg-white p-6" />
        ))}
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
      <StatCard title="Total Orders" value={data.totalOrders} icon={Store} color="bg-blue-50 text-blue-600" />
      <StatCard title="Synced" value={data.syncedOrders} icon={CheckCircle} color="bg-green-50 text-green-600" subtitle="Successfully sent to Oracle" />
      <StatCard title="Failed" value={data.failedOrders} icon={XCircle} color="bg-red-50 text-red-600" />
      <StatCard title="Pending" value={data.pendingOrders} icon={Clock} color="bg-yellow-50 text-yellow-600" />
      <StatCard title="Sync Rate" value={`${data.syncRate}%`} icon={TrendingUp} color="bg-purple-50 text-purple-600" />
      <StatCard
        title="Alerts"
        value={data.unresolvedAlerts}
        icon={AlertTriangle}
        color={data.unresolvedAlerts > 0 ? 'bg-red-50 text-red-600' : 'bg-gray-50 text-gray-400'}
      />
    </div>
  );
}
