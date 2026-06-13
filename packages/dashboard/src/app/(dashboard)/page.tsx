import { OverviewCards } from '@/components/dashboard/overview-cards';
import { SyncJobsTable } from '@/components/dashboard/sync-jobs-table';
import { AlertsPanel } from '@/components/dashboard/alerts-panel';
import { SyncTrendChart } from '@/components/dashboard/sync-trend-chart';
import { HealthStatusGrid } from '@/components/dashboard/health-status-grid';
import { BranchOrdersChart } from '@/components/dashboard/branch-orders-chart';

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      {/* Page heading */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Integration Dashboard
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Real-time monitoring · Odoo → Oracle Fusion
          </p>
        </div>
        <div className="hidden items-center gap-2 sm:flex">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700 ring-1 ring-indigo-200">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-500" />
            Live
          </span>
        </div>
      </div>

      <OverviewCards />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SyncTrendChart />
        <BranchOrdersChart />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SyncJobsTable />
        </div>
        <div>
          <AlertsPanel />
        </div>
      </div>

      <HealthStatusGrid />
    </div>
  );
}
