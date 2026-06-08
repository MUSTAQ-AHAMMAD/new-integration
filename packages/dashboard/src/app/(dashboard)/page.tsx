import { OverviewCards } from '@/components/dashboard/overview-cards';
import { SyncJobsTable } from '@/components/dashboard/sync-jobs-table';
import { AlertsPanel } from '@/components/dashboard/alerts-panel';
import { SyncTrendChart } from '@/components/dashboard/sync-trend-chart';
import { HealthStatusGrid } from '@/components/dashboard/health-status-grid';
import { BranchOrdersChart } from '@/components/dashboard/branch-orders-chart';

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Integration Dashboard</h1>
        <p className="mt-1 text-sm text-gray-500">Odoo → Oracle Fusion sync monitoring</p>
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
