'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useRegion } from '@/providers/region-provider';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PageHeader } from '@/components/ui/page-header';
import { ErrorState } from '@/components/ui/error-state';
import { Play, Pause, RefreshCw, CheckCircle, XCircle, Clock, Globe } from 'lucide-react';

interface SyncControl {
  id: string;
  serviceName: string;
  displayName: string;
  description: string | null;
  region: string | null;
  enabled: boolean;
  isRunning: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  runCount: number;
  errorCount: number;
  createdAt: string;
  updatedAt: string;
}

async function fetchSyncControls(region?: string | null): Promise<SyncControl[]> {
  const query = region ? `?region=${encodeURIComponent(region)}` : '';
  const response = await fetch(`/api/v1/admin/sync-control${query}`);
  if (!response.ok) throw new Error('Failed to fetch sync controls');
  return response.json();
}

async function toggleService(serviceName: string, region?: string | null) {
  const query = region ? `?region=${encodeURIComponent(region)}` : '';
  const response = await fetch(`/api/v1/admin/sync-control/${serviceName}/toggle${query}`, {
    method: 'POST',
  });
  if (!response.ok) throw new Error('Failed to toggle sync service');
  return response.json();
}

function formatDateTime(date: string | null): string {
  if (!date) return 'Never';
  return new Date(date).toLocaleString();
}

function formatRelativeTime(date: string | null): string {
  if (!date) return 'Never';
  const now = new Date();
  const then = new Date(date);
  const diffMs = now.getTime() - then.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

export default function SyncControlPage() {
  const queryClient = useQueryClient();
  const { selectedRegion } = useRegion();
  const [toggleInProgress, setToggleInProgress] = useState<string | null>(null);

  const { data: controls, isLoading, error } = useQuery<SyncControl[]>({
    queryKey: ['sync-controls', selectedRegion],
    queryFn: () => fetchSyncControls(selectedRegion),
    refetchInterval: 5000,
  });

  const toggleMutation = useMutation({
    mutationFn: ({ serviceName, region }: { serviceName: string; region?: string | null }) => 
      toggleService(serviceName, region),
    onMutate: ({ serviceName }) => {
      setToggleInProgress(serviceName);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sync-controls', selectedRegion] });
    },
    onSettled: () => {
      setToggleInProgress(null);
    },
  });

  const handleToggle = (serviceName: string, region?: string | null) => {
    toggleMutation.mutate({ serviceName, region });
  };

  if (error) {
    return <ErrorState message="Failed to load sync controls" />;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sync Control Center"
        subtitle={selectedRegion 
          ? `Monitor and control background sync operations for region: ${selectedRegion}` 
          : "Monitor and control all background sync operations across all regions"}
      />

      {selectedRegion && (
        <div className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-700">
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4" />
            <span>Filtered to region: <strong>{selectedRegion}</strong></span>
            <span className="text-xs text-indigo-600">
              (Use the region selector in the header to view all regions)
            </span>
          </div>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Services</CardTitle>
            <RefreshCw className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{controls?.length || 0}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Enabled</CardTitle>
            <CheckCircle className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {controls?.filter((c) => c.enabled).length || 0}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Running Now</CardTitle>
            <Clock className="h-4 w-4 text-blue-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">
              {controls?.filter((c) => c.isRunning).length || 0}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Errors</CardTitle>
            <XCircle className="h-4 w-4 text-red-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">
              {controls?.reduce((sum, c) => sum + c.errorCount, 0) || 0}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Sync Services</CardTitle>
          <CardDescription>
            Control and monitor background sync operations
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Service</TableHead>
                  <TableHead>Region</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last Run</TableHead>
                  <TableHead>Last Status</TableHead>
                  <TableHead className="text-right">Stats</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {controls?.map((control) => (
                  <TableRow key={control.id}>
                    <TableCell>
                      <div>
                        <div className="font-medium">{control.displayName}</div>
                        <div className="text-sm text-muted-foreground">
                          {control.description}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {control.region ? (
                        <Badge variant="outline" className="font-mono">
                          {control.region}
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-xs">
                          Global
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {control.enabled ? (
                          <Badge className="bg-green-600 hover:bg-green-700">
                            Enabled
                          </Badge>
                        ) : (
                          <Badge variant="secondary">Disabled</Badge>
                        )}
                        {control.isRunning && (
                          <Badge variant="outline" className="animate-pulse">
                            <Clock className="mr-1 h-3 w-3" />
                            Running
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div>
                        <div className="text-sm">
                          {formatRelativeTime(control.lastRunAt)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {formatDateTime(control.lastRunAt)}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {control.lastStatus === 'success' ? (
                        <Badge variant="outline" className="border-green-600 text-green-600">
                          <CheckCircle className="mr-1 h-3 w-3" />
                          Success
                        </Badge>
                      ) : control.lastStatus === 'error' ? (
                        <Badge variant="outline" className="border-red-600 text-red-600">
                          <XCircle className="mr-1 h-3 w-3" />
                          Error
                        </Badge>
                      ) : (
                        <Badge variant="outline">N/A</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="text-sm">
                        <div>Runs: {control.runCount}</div>
                        <div className="text-muted-foreground">
                          Errors: {control.errorCount}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant={control.enabled ? 'destructive' : 'default'}
                        onClick={() => handleToggle(control.serviceName, control.region)}
                        disabled={toggleInProgress === control.serviceName}
                      >
                        {control.enabled ? (
                          <>
                            <Pause className="mr-1 h-4 w-4" />
                            Disable
                          </>
                        ) : (
                          <>
                            <Play className="mr-1 h-4 w-4" />
                            Enable
                          </>
                        )}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
