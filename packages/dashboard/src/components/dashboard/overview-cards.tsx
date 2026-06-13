'use client';

import type { ComponentType } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { AlertTriangle, CheckCircle, Clock, Loader2, Store, TrendingUp, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface StatCardProps {
  title: string;
  value: string | number;
  icon: ComponentType<{ className?: string }>;
  iconClass: string;
  bgClass: string;
  borderClass?: string;
  subtitle?: string;
  href?: string;
}

function StatCard({ title, value, icon: Icon, iconClass, bgClass, borderClass, subtitle, href }: StatCardProps) {
  const content = (
    <div
      className={cn(
        'group relative overflow-hidden rounded-xl border bg-white p-5 shadow-sm ring-1 ring-slate-950/[0.03] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md',
        borderClass ?? 'border-slate-200',
      )}
    >
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold uppercase tracking-widest text-slate-500">{title}</p>
          <p className="mt-2 text-3xl font-bold tabular-nums text-slate-900">{value}</p>
          {subtitle && <p className="mt-1 text-xs text-slate-400">{subtitle}</p>}
        </div>
        <div className={cn('ml-3 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl', bgClass)}>
          <Icon className={cn('h-5 w-5', iconClass)} />
        </div>
      </div>
    </div>
  );

  if (href) {
    return <Link href={href} className="block">{content}</Link>;
  }
  return content;
}

export function OverviewCards() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['dashboard-overview'],
    queryFn: api.getOverview,
    refetchInterval: 15000,
  });

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-8">
        {Array.from({ length: 8 }).map((_, index) => (
          <div key={index} className="h-28 animate-pulse rounded-xl border border-slate-200 bg-white" />
        ))}
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-center text-sm text-red-600">
        Failed to load overview stats. Check that the backend is reachable.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-8">
      <StatCard
        title="Total Orders"
        value={data.totalOrders}
        icon={Store}
        bgClass="bg-blue-100"
        iconClass="text-blue-600"
      />
      <StatCard
        title="Synced"
        value={data.syncedOrders}
        icon={CheckCircle}
        bgClass="bg-emerald-100"
        iconClass="text-emerald-600"
        borderClass="border-emerald-200"
        subtitle="Sent to Oracle"
      />
      <StatCard
        title="Failed"
        value={data.failedOrders}
        icon={XCircle}
        bgClass={data.failedOrders > 0 ? 'bg-red-100' : 'bg-slate-100'}
        iconClass={data.failedOrders > 0 ? 'text-red-600' : 'text-slate-400'}
        borderClass={data.failedOrders > 0 ? 'border-red-200' : 'border-slate-200'}
        href="/failed-transactions"
      />
      <StatCard
        title="Pending"
        value={data.pendingOrders}
        icon={Clock}
        bgClass="bg-amber-100"
        iconClass="text-amber-600"
      />
      <StatCard
        title="Processing"
        value={data.processingOrders}
        icon={Loader2}
        bgClass="bg-blue-100"
        iconClass="text-blue-500"
      />
      <StatCard
        title="Sync Rate"
        value={`${data.syncRate}%`}
        icon={TrendingUp}
        bgClass="bg-violet-100"
        iconClass="text-violet-600"
        borderClass={data.syncRate >= 95 ? 'border-violet-200' : 'border-slate-200'}
      />
      <StatCard
        title="Alerts"
        value={data.unresolvedAlerts}
        icon={AlertTriangle}
        bgClass={data.unresolvedAlerts > 0 ? 'bg-red-100' : 'bg-slate-100'}
        iconClass={data.unresolvedAlerts > 0 ? 'text-red-600' : 'text-slate-400'}
        borderClass={data.unresolvedAlerts > 0 ? 'border-red-200' : 'border-slate-200'}
        href="/alerts"
      />
      <StatCard
        title="Active Stores"
        value={data.storeCount}
        icon={Store}
        bgClass="bg-indigo-100"
        iconClass="text-indigo-600"
        href="/stores"
      />
    </div>
  );
}
