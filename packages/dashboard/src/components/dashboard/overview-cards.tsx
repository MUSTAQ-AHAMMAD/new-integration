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
  gradientFrom: string;
  gradientTo: string;
  iconBg: string;
  iconClass: string;
  subtitle?: string;
  href?: string;
  pulse?: boolean;
}

function StatCard({ title, value, icon: Icon, gradientFrom, gradientTo, iconBg, iconClass, subtitle, href, pulse }: StatCardProps) {
  const content = (
    <div className="group relative overflow-hidden rounded-2xl border border-white/60 bg-white shadow-md shadow-slate-200/60 transition-all duration-300 hover:-translate-y-1 hover:shadow-xl hover:shadow-slate-300/50">
      {/* Coloured top accent bar */}
      <div className={cn('absolute inset-x-0 top-0 h-1 rounded-t-2xl bg-gradient-to-r', gradientFrom, gradientTo)} />

      {/* Subtle gradient background wash */}
      <div className={cn('absolute inset-0 opacity-[0.04] bg-gradient-to-br', gradientFrom, gradientTo)} />

      <div className="relative p-6">
        <div className="flex items-start justify-between">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-bold uppercase tracking-widest text-slate-400">{title}</p>
            <p className="mt-3 text-4xl font-black tabular-nums leading-none text-slate-900">{value}</p>
            {subtitle && (
              <p className="mt-2 flex items-center gap-1 text-xs font-medium text-slate-400">{subtitle}</p>
            )}
          </div>
          <div className={cn('relative ml-4 flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl shadow-lg', iconBg)}>
            {pulse && (
              <span className="absolute inset-0 animate-ping rounded-2xl opacity-30 bg-current" />
            )}
            <Icon className={cn('relative h-7 w-7', iconClass)} />
          </div>
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
      <div className="grid grid-cols-2 gap-5 md:grid-cols-4">
        {Array.from({ length: 8 }).map((_, index) => (
          <div key={index} className="h-36 animate-pulse rounded-2xl border border-slate-200 bg-white" />
        ))}
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-center text-sm text-red-600">
        Failed to load overview stats. Check that the backend is reachable.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-5 md:grid-cols-4">
      <StatCard
        title="Total Orders"
        value={data.totalOrders}
        icon={Store}
        gradientFrom="from-blue-500"
        gradientTo="to-blue-600"
        iconBg="bg-gradient-to-br from-blue-500 to-blue-600"
        iconClass="text-white"
      />
      <StatCard
        title="Synced"
        value={data.syncedOrders}
        icon={CheckCircle}
        gradientFrom="from-emerald-500"
        gradientTo="to-teal-500"
        iconBg="bg-gradient-to-br from-emerald-500 to-teal-500"
        iconClass="text-white"
        subtitle="Sent to Oracle"
      />
      <StatCard
        title="Failed"
        value={data.failedOrders}
        icon={XCircle}
        gradientFrom={data.failedOrders > 0 ? 'from-red-500' : 'from-slate-400'}
        gradientTo={data.failedOrders > 0 ? 'to-rose-600' : 'to-slate-500'}
        iconBg={data.failedOrders > 0 ? 'bg-gradient-to-br from-red-500 to-rose-600' : 'bg-gradient-to-br from-slate-400 to-slate-500'}
        iconClass="text-white"
        href="/failed-transactions"
      />
      <StatCard
        title="Pending"
        value={data.pendingOrders}
        icon={Clock}
        gradientFrom="from-amber-400"
        gradientTo="to-orange-500"
        iconBg="bg-gradient-to-br from-amber-400 to-orange-500"
        iconClass="text-white"
      />
      <StatCard
        title="Processing"
        value={data.processingOrders}
        icon={Loader2}
        gradientFrom="from-sky-500"
        gradientTo="to-blue-500"
        iconBg="bg-gradient-to-br from-sky-500 to-blue-500"
        iconClass="text-white"
        pulse={data.processingOrders > 0}
      />
      <StatCard
        title="Sync Rate"
        value={`${data.syncRate}%`}
        icon={TrendingUp}
        gradientFrom="from-violet-500"
        gradientTo="to-purple-600"
        iconBg="bg-gradient-to-br from-violet-500 to-purple-600"
        iconClass="text-white"
      />
      <StatCard
        title="Alerts"
        value={data.unresolvedAlerts}
        icon={AlertTriangle}
        gradientFrom={data.unresolvedAlerts > 0 ? 'from-red-500' : 'from-slate-400'}
        gradientTo={data.unresolvedAlerts > 0 ? 'to-rose-600' : 'to-slate-500'}
        iconBg={data.unresolvedAlerts > 0 ? 'bg-gradient-to-br from-red-500 to-rose-600' : 'bg-gradient-to-br from-slate-400 to-slate-500'}
        iconClass="text-white"
        href="/alerts"
      />
      <StatCard
        title="Active Stores"
        value={data.storeCount}
        icon={Store}
        gradientFrom="from-indigo-500"
        gradientTo="to-purple-500"
        iconBg="bg-gradient-to-br from-indigo-500 to-purple-500"
        iconClass="text-white"
        href="/stores"
      />
    </div>
  );
}

