'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Bell, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function Header({ mobileMenuButton }: { mobileMenuButton?: React.ReactNode }) {
  const qc = useQueryClient();
  const { data: overview } = useQuery({
    queryKey: ['dashboard-overview'],
    queryFn: api.getOverview,
    refetchInterval: 30000,
  });

  return (
    <header className="flex h-16 items-center justify-between border-b border-gray-200 bg-white px-4 sm:px-6">
      <div className="flex items-center gap-3">
        {mobileMenuButton}
        {overview && (
          <div className="hidden items-center gap-4 text-sm sm:flex">
            <span className="text-gray-500">
              Sync Rate: <strong className="text-green-600">{overview.syncRate}%</strong>
            </span>
            <span className="text-gray-300">|</span>
            <span className="text-gray-500">
              Active Jobs: <strong>{overview.activeJobs}</strong>
            </span>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        {(overview?.unresolvedAlerts ?? 0) > 0 && (
          <div className="flex items-center gap-1 rounded-full bg-red-50 px-3 py-1 text-sm text-red-600">
            <Bell className="h-3.5 w-3.5" />
            {overview?.unresolvedAlerts} alert{overview?.unresolvedAlerts !== 1 ? 's' : ''}
          </div>
        )}
        <Button variant="outline" size="sm" onClick={() => qc.invalidateQueries()}>
          <RefreshCw className="mr-1 h-3.5 w-3.5" /> Refresh
        </Button>
      </div>
    </header>
  );
}
