'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Bell, RefreshCw, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function Header({ mobileMenuButton }: { mobileMenuButton?: React.ReactNode }) {
  const qc = useQueryClient();
  const { data: overview } = useQuery({
    queryKey: ['dashboard-overview'],
    queryFn: api.getOverview,
    refetchInterval: 30000,
  });

  return (
    <header className="relative flex h-14 items-center justify-between border-b border-slate-200 bg-white px-4 sm:px-6">
      {/* Gradient top accent line */}
      <div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500" />

      <div className="flex items-center gap-3">
        {mobileMenuButton}
        {overview && (
          <div className="hidden items-center gap-2 sm:flex">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Sync {overview.syncRate}%
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700 ring-1 ring-blue-200">
              <Zap className="h-3 w-3" />
              {overview.activeJobs} active
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        {(overview?.unresolvedAlerts ?? 0) > 0 && (
          <div className="relative">
            <button className="flex h-8 w-8 items-center justify-center rounded-full bg-red-50 text-red-600 ring-1 ring-red-200 transition-colors hover:bg-red-100">
              <Bell className="h-4 w-4" />
            </button>
            <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[9px] font-bold text-white">
              {overview?.unresolvedAlerts}
            </span>
          </div>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => qc.invalidateQueries()}
          className="h-8 gap-1.5 border-slate-200 text-slate-600 hover:border-indigo-300 hover:text-indigo-600"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Refresh</span>
        </Button>
      </div>
    </header>
  );
}
