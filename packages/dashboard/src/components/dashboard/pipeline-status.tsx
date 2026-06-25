'use client';

import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, CheckCircle2, Clock, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';

export function PipelineStatus() {
  const { data: queueStats } = useQuery({
    queryKey: ['queue-stats'],
    queryFn: api.getQueueStats,
    refetchInterval: 5000,
  });

  const { data: jobs } = useQuery({
    queryKey: ['sync-jobs-recent'],
    queryFn: () => api.listSyncJobs(),
    refetchInterval: 5000,
  });

  const recentPipelineJobs = jobs?.filter((j) => j.createdBy === 'DASHBOARD_PIPELINE').slice(0, 3) || [];
  const lastPipelineJob = recentPipelineJobs[0];

  // Calculate pipeline health
  const pending = queueStats?.orderSync.waiting || 0;
  const processing = queueStats?.orderSync.active || 0;
  const failed = queueStats?.orderSync.failed || 0;

  let healthStatus: 'healthy' | 'warning' | 'error' = 'healthy';
  let healthMessage = 'Pipeline running normally';
  let healthIcon = <CheckCircle2 className="h-5 w-5 text-green-600" />;

  if (failed > 100) {
    healthStatus = 'error';
    healthMessage = `High failure rate: ${failed} failed orders`;
    healthIcon = <AlertTriangle className="h-5 w-5 text-red-600" />;
  } else if (pending > 1000) {
    healthStatus = 'warning';
    healthMessage = `Large backlog: ${pending} pending orders`;
    healthIcon = <AlertTriangle className="h-5 w-5 text-yellow-600" />;
  } else if (processing > 0) {
    healthStatus = 'healthy';
    healthMessage = `Processing ${processing} orders`;
    healthIcon = <Loader2 className="h-5 w-5 animate-spin text-blue-600" />;
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-white/60 bg-white shadow-md shadow-slate-200/60">
      {/* Header band */}
      <div className="border-b border-slate-100 bg-gradient-to-r from-indigo-50 to-purple-50 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 shadow-md shadow-indigo-200">
            <Activity className="h-5 w-5 text-white" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-800">Automatic Pipeline Status</h3>
            <p className="text-xs text-slate-500">Every 5 minutes • Syncs Odoo → Oracle</p>
          </div>
        </div>
      </div>

      <div className="p-6">
        {/* Health Status */}
        <div className="mb-6 flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50 p-4">
          <div className="flex items-center gap-3">
            {healthIcon}
            <div>
              <div className="text-sm font-semibold text-slate-800">Pipeline Health</div>
              <div className="text-xs text-slate-500">{healthMessage}</div>
            </div>
          </div>
          <div
            className={`rounded-full px-3 py-1 text-xs font-bold ${
              healthStatus === 'healthy'
                ? 'bg-green-100 text-green-700'
                : healthStatus === 'warning'
                  ? 'bg-yellow-100 text-yellow-700'
                  : 'bg-red-100 text-red-700'
            }`}
          >
            {healthStatus.toUpperCase()}
          </div>
        </div>

        {/* Queue Stats */}
        <div className="mb-6 grid grid-cols-4 gap-3">
          <div className="rounded-lg border border-slate-100 bg-white p-3 text-center">
            <div className="text-2xl font-bold text-yellow-600">{pending}</div>
            <div className="text-xs text-slate-500">Pending</div>
          </div>
          <div className="rounded-lg border border-slate-100 bg-white p-3 text-center">
            <div className="text-2xl font-bold text-blue-600">{processing}</div>
            <div className="text-xs text-slate-500">Processing</div>
          </div>
          <div className="rounded-lg border border-slate-100 bg-white p-3 text-center">
            <div className="text-2xl font-bold text-red-600">{failed}</div>
            <div className="text-xs text-slate-500">Failed</div>
          </div>
          <div className="rounded-lg border border-slate-100 bg-white p-3 text-center">
            <div className="text-2xl font-bold text-green-600">{queueStats?.orderSync.completed || 0}</div>
            <div className="text-xs text-slate-500">Completed</div>
          </div>
        </div>

        {/* Last Pipeline Run */}
        {lastPipelineJob && (
          <div className="rounded-lg border border-slate-100 bg-slate-50 p-4">
            <div className="mb-2 flex items-center gap-2">
              <Clock className="h-4 w-4 text-slate-400" />
              <div className="text-xs font-semibold text-slate-600">Last Automatic Run</div>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-slate-800">
                  {lastPipelineJob.processedRecords}/{lastPipelineJob.totalRecords} orders
                </div>
                <div className="text-xs text-slate-500">
                  {new Date(lastPipelineJob.createdAt).toLocaleString()}
                </div>
              </div>
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${
                  lastPipelineJob.status === 'COMPLETED'
                    ? 'bg-green-100 text-green-700'
                    : lastPipelineJob.status === 'PARTIAL'
                      ? 'bg-yellow-100 text-yellow-700'
                      : lastPipelineJob.status === 'PROCESSING'
                        ? 'bg-blue-100 text-blue-700'
                        : 'bg-slate-100 text-slate-600'
                }`}
              >
                {lastPipelineJob.status}
              </span>
            </div>
          </div>
        )}

        {!lastPipelineJob && (
          <div className="rounded-lg border border-slate-100 bg-slate-50 p-4 text-center text-sm text-slate-500">
            No automatic pipeline runs yet. Waiting for pending orders...
          </div>
        )}
      </div>
    </div>
  );
}
