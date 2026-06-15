import { OverviewCards } from '@/components/dashboard/overview-cards';
import { SyncJobsTable } from '@/components/dashboard/sync-jobs-table';
import { AlertsPanel } from '@/components/dashboard/alerts-panel';
import { SyncTrendChart } from '@/components/dashboard/sync-trend-chart';
import { HealthStatusGrid } from '@/components/dashboard/health-status-grid';
import { BranchOrdersChart } from '@/components/dashboard/branch-orders-chart';
import { Activity } from 'lucide-react';

export default function DashboardPage() {
  return (
    <div className="space-y-8">
      {/* Page heading */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 p-8 shadow-xl shadow-indigo-900/20">
        {/* Decorative orbs */}
        <div className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full bg-indigo-500/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-16 left-32 h-64 w-64 rounded-full bg-purple-500/10 blur-3xl" />

        <div className="relative flex items-center justify-between">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3 py-1">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-400" />
              <span className="text-xs font-semibold text-indigo-300">Live Monitoring</span>
            </div>
            <h1 className="bg-gradient-to-r from-white via-slate-200 to-slate-400 bg-clip-text text-3xl font-black tracking-tight text-transparent">
              Integration Dashboard
            </h1>
            <p className="mt-2 flex items-center gap-2 text-sm text-slate-400">
              <Activity className="h-3.5 w-3.5 text-indigo-400" />
              Real-time monitoring · Odoo → Oracle Fusion
            </p>
          </div>
          <div className="hidden sm:flex items-center gap-3">
            <div className="flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-2">
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
              <span className="text-xs font-bold text-emerald-400">LIVE</span>
            </div>
          </div>
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

