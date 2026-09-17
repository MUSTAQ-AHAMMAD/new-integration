'use client';

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts';
import { Database, Globe, RefreshCw, Server, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { api, type Alert, type QueueStats } from '@/lib/api';
import { getApiBase } from '@/lib/runtime-config';
import { formatDate, getSeverityColor, getStatusColor } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/error-state';
import { Progress } from '@/components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface ServiceHealth {
  id: string;
  serviceName: string;
  status: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';
  responseTimeMs: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  failureReason?: string;
  consecutiveFailures: number;
  createdAt: string;
}

interface ServiceHealthRecord extends Omit<ServiceHealth, 'serviceName'> {
  serviceName: 'ODOO' | 'ORACLE' | 'REDIS' | 'DATABASE';
}

interface QueueStatsRecord extends QueueStats {
  orderSync: QueueStats['orderSync'] & { delayed?: number };
}

const apiBase = getApiBase();
const SERVICE_ORDER: Array<ServiceHealthRecord['serviceName']> = ['ODOO', 'ORACLE', 'REDIS', 'DATABASE'];
const SERVICE_COLORS: Record<ServiceHealthRecord['serviceName'], string> = {
  ODOO: '#2563eb',
  ORACLE: '#ef4444',
  REDIS: '#f59e0b',
  DATABASE: '#10b981',
};

async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(error.message || `API error: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

function getServiceIcon(serviceName: ServiceHealthRecord['serviceName']) {
  switch (serviceName) {
    case 'ODOO':
      return Globe;
    case 'ORACLE':
      return Server;
    case 'REDIS':
      return RefreshCw;
    case 'DATABASE':
      return Database;
    default:
      return TriangleAlert;
  }
}

export default function HealthPage() {
  const queryClient = useQueryClient();

  const { data: healthEntries, isLoading, isError } = useQuery({
    queryKey: ['service-health'],
    queryFn: () => apiRequest<ServiceHealthRecord[]>('/health/services'),
    refetchInterval: 15000,
  });

  const { data: queueStats } = useQuery({
    queryKey: ['queue-stats-health'],
    queryFn: () => api.getQueueStats() as Promise<QueueStatsRecord>,
    refetchInterval: 15000,
  });

  const { data: alerts } = useQuery({
    queryKey: ['active-alerts-health'],
    queryFn: () => api.listAlerts({ resolved: false }),
    refetchInterval: 15000,
  });

  const healthCheckMutation = useMutation({
    mutationFn: () => apiRequest('/health/check', { method: 'POST' }),
    onSuccess: () => {
      toast.success('Health check started');
      void queryClient.invalidateQueries({ queryKey: ['service-health'] });
      void queryClient.invalidateQueries({ queryKey: ['active-alerts-health'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const latestByService = useMemo(() => {
    const latestMap = new Map<ServiceHealthRecord['serviceName'], ServiceHealthRecord>();
    SERVICE_ORDER.forEach((serviceName) => {
      const matchingEntries = (healthEntries ?? [])
        .filter((entry) => entry.serviceName === serviceName)
        .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());

      latestMap.set(serviceName, matchingEntries[0] ?? {
        id: `${serviceName}-placeholder`,
        serviceName,
        status: 'DEGRADED',
        responseTimeMs: 0,
        lastSuccessAt: undefined,
        lastFailureAt: undefined,
        failureReason: 'No health samples yet',
        consecutiveFailures: 0,
        createdAt: new Date().toISOString(),
      });
    });
    return SERVICE_ORDER.map((serviceName) => latestMap.get(serviceName)!);
  }, [healthEntries]);

  const lastChecked = useMemo(() => {
    const timestamps = latestByService.map((entry) => entry.createdAt).filter(Boolean);
    return timestamps.length > 0 ? timestamps.sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] : undefined;
  }, [latestByService]);

  const chartData = useMemo(() => {
    const allEntries = (healthEntries ?? []).slice().sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
    if (allEntries.length === 0) {
      return latestByService.map((entry, index) => ({ time: `T-${latestByService.length - index}`, [entry.serviceName]: entry.responseTimeMs }));
    }

    const uniqueTimes = Array.from(new Set(allEntries.map((entry) => new Date(entry.createdAt).toISOString()))).slice(-6);
    const paddedTimes = uniqueTimes.length === 1 ? [new Date(new Date(uniqueTimes[0]).getTime() - 15 * 60 * 1000).toISOString(), uniqueTimes[0]] : uniqueTimes;

    return paddedTimes.map((time) => {
      const row: Record<string, string | number | undefined> = {
        time: new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit' }).format(new Date(time)),
      };

      latestByService.forEach((service) => {
        const matching = [...allEntries]
          .reverse()
          .find((entry) => entry.serviceName === service.serviceName && new Date(entry.createdAt).getTime() <= new Date(time).getTime());
        row[service.serviceName] = matching?.responseTimeMs ?? service.responseTimeMs;
      });

      return row;
    });
  }, [healthEntries, latestByService]);

  const queueMetrics = useMemo(() => {
    const orderSync = queueStats?.orderSync;
    if (!orderSync) return [];
    return [
      { label: 'Waiting', value: orderSync.waiting },
      { label: 'Active', value: orderSync.active },
      { label: 'Completed', value: orderSync.completed },
      { label: 'Failed', value: orderSync.failed },
    ];
  }, [queueStats]);

  const queueMax = Math.max(1, ...queueMetrics.map((metric) => metric.value));

  if (isLoading) {
    return <div className="py-16 text-center text-gray-500">Loading...</div>;
  }

  if (isError) {
    return <ErrorState />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <div className="h-8 w-1 shrink-0 rounded-full bg-indigo-500" />
          <div>
            <h1 className="text-xl font-bold text-slate-900">System Health</h1>
            <p className="mt-0.5 text-sm text-slate-500">Track service availability, queue depth, and unresolved platform alerts in one view.</p>
            <p className="mt-1 text-xs text-slate-400">Last checked: {lastChecked ? formatDate(lastChecked) : '—'}</p>
          </div>
        </div>
        <Button onClick={() => healthCheckMutation.mutate()} disabled={healthCheckMutation.isPending}>
          <RefreshCw className="h-4 w-4" /> Run Health Check
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {latestByService.map((service) => {
          const Icon = getServiceIcon(service.serviceName);
          const circuitStatus = service.status === 'UNHEALTHY' || service.consecutiveFailures >= 3 ? 'OPEN' : 'CLOSED';
          return (
            <Card key={service.serviceName}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Icon className="h-5 w-5 text-blue-600" />
                    <CardTitle>{service.serviceName}</CardTitle>
                  </div>
                  <Badge className={getStatusColor(service.status)}>{service.status}</Badge>
                </div>
                <CardDescription>{service.responseTimeMs} ms response time</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-gray-600">
                <div className="flex justify-between"><span>Last success</span><span>{service.lastSuccessAt ? formatDate(service.lastSuccessAt) : '—'}</span></div>
                <div className="flex justify-between"><span>Last failure</span><span>{service.lastFailureAt ? formatDate(service.lastFailureAt) : '—'}</span></div>
                <div className="flex justify-between"><span>Consecutive failures</span><span>{service.consecutiveFailures}</span></div>
                <div className="flex justify-between"><span>Circuit</span><span className={circuitStatus === 'OPEN' ? 'font-semibold text-red-600' : 'font-semibold text-green-600'}>{circuitStatus}</span></div>
                {service.failureReason && <p className="rounded-lg bg-gray-50 p-2 text-xs text-gray-500">{service.failureReason}</p>}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Latency Trend</CardTitle>
          <CardDescription>Recent service response time samples.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="time" />
                <YAxis />
                <ChartTooltip />
                {SERVICE_ORDER.map((service) => (
                  <Line key={service} type="monotone" dataKey={service} stroke={SERVICE_COLORS[service]} strokeWidth={2} dot={{ r: 3 }} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[1.3fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Worker Status</CardTitle>
            <CardDescription>Queue performance snapshot from the background sync workers.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Queue</TableHead>
                  <TableHead>Waiting</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead>Completed</TableHead>
                  <TableHead>Failed</TableHead>
                  <TableHead>Delayed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell className="font-medium">Order Sync</TableCell>
                  <TableCell>{queueStats?.orderSync.waiting ?? 0}</TableCell>
                  <TableCell>{queueStats?.orderSync.active ?? 0}</TableCell>
                  <TableCell>{queueStats?.orderSync.completed ?? 0}</TableCell>
                  <TableCell>{queueStats?.orderSync.failed ?? 0}</TableCell>
                  <TableCell>{queueStats?.orderSync.delayed ?? 0}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Queue Depth Gauge</CardTitle>
            <CardDescription>Relative depth across key queue states.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {queueMetrics.map((metric) => (
              <div key={metric.label} className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-600">{metric.label}</span>
                  <span className="font-medium text-gray-900">{metric.value}</span>
                </div>
                <Progress value={(metric.value / queueMax) * 100} />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent Error Logs</CardTitle>
          <CardDescription>Open alerts that still require action.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {(alerts ?? []).length === 0 ? (
            <div className="py-8 text-center text-gray-500">No active alerts.</div>
          ) : (
            (alerts ?? []).slice(0, 8).map((alert: Alert) => (
              <div key={alert.id} className="rounded-lg border border-gray-200 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <Badge className={getSeverityColor(alert.severity)}>{alert.severity}</Badge>
                      <h3 className="font-semibold text-gray-900">{alert.title}</h3>
                    </div>
                    <p className="mt-2 text-sm text-gray-600">{alert.message}</p>
                  </div>
                  <span className="whitespace-nowrap text-xs text-gray-400">{formatDate(alert.createdAt)}</span>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
