'use client';

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, type VendHqRegionCredential } from '@/lib/api';
import { toast } from 'sonner';
import { Globe, Package, PlayCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

function RegionCard({ cred }: { cred: VendHqRegionCredential }) {
  const backupMutation = useMutation({
    mutationFn: () => api.triggerVendHqBackupByRegion(cred.region),
    onSuccess: (res) => toast.success(`VendHQ backup triggered for ${res.region} (${res.triggered} credential(s))`),
    onError: (e: Error) => toast.error(`Backup failed: ${e.message}`),
  });

  const itemSyncMutation = useMutation({
    mutationFn: () => api.triggerItemSyncByRegion(cred.region),
    onSuccess: () => toast.success(`Item sync triggered for region ${cred.region}`),
    onError: (e: Error) => toast.error(`Item sync failed: ${e.message}`),
  });

  return (
    <Card className="border border-slate-200">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-100 text-indigo-600">
            <Globe className="h-4 w-4" />
          </div>
          <div>
            <CardTitle className="text-base">{cred.region}</CardTitle>
            <CardDescription className="text-xs">{cred.domainName}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => backupMutation.mutate()}
            disabled={backupMutation.isPending}
            className="gap-1.5"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${backupMutation.isPending ? 'animate-spin' : ''}`} />
            {backupMutation.isPending ? 'Running backup…' : 'Run Sales Backup'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => itemSyncMutation.mutate()}
            disabled={itemSyncMutation.isPending}
            className="gap-1.5"
          >
            <Package className={`h-3.5 w-3.5 ${itemSyncMutation.isPending ? 'animate-spin' : ''}`} />
            {itemSyncMutation.isPending ? 'Syncing items…' : 'Sync Items'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function RegionIntegrationPage() {
  const [allBackupPending, setAllBackupPending] = useState(false);
  const [allItemSyncPending, setAllItemSyncPending] = useState(false);

  const { data: regions, isLoading } = useQuery({
    queryKey: ['vendhq-regions'],
    queryFn: api.listVendHqRegions,
  });

  const handleTriggerAllBackup = async () => {
    setAllBackupPending(true);
    try {
      const result = await api.triggerVendHqBackupAll();
      toast.success(result.message);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to trigger backup');
    } finally {
      setAllBackupPending(false);
    }
  };

  const handleTriggerAllItemSync = async () => {
    setAllItemSyncPending(true);
    try {
      const result = await api.triggerItemSyncAll();
      toast.success(result.message);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to trigger item sync');
    } finally {
      setAllItemSyncPending(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Region Integration</h1>
        <p className="text-sm text-gray-500">
          Trigger VendHQ sales backup and item sync for individual regions or all regions at once.
        </p>
      </div>

      {/* Global triggers */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <PlayCircle className="h-5 w-5 text-indigo-600" />
            Global Triggers — All Regions
          </CardTitle>
          <CardDescription>Run integration jobs across all active regions simultaneously.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            <Button
              onClick={handleTriggerAllBackup}
              disabled={allBackupPending}
              className="gap-2"
            >
              <RefreshCw className={`h-4 w-4 ${allBackupPending ? 'animate-spin' : ''}`} />
              {allBackupPending ? 'Running…' : 'Run All Sales Backups'}
            </Button>
            <Button
              variant="outline"
              onClick={handleTriggerAllItemSync}
              disabled={allItemSyncPending}
              className="gap-2"
            >
              <Package className={`h-4 w-4 ${allItemSyncPending ? 'animate-spin' : ''}`} />
              {allItemSyncPending ? 'Syncing…' : 'Sync All Items'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Per-region triggers */}
      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Per-Region Triggers
        </h2>
        {isLoading ? (
          <div className="py-8 text-center text-sm text-gray-400">Loading regions…</div>
        ) : regions && regions.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {regions.map((cred) => (
              <RegionCard key={cred.id} cred={cred} />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-gray-300 py-10 text-center text-sm text-gray-400">
            No active VendHQ credentials found.
            <br />
            Add credentials in{' '}
            <a href="/admin/vendhq-credentials" className="text-indigo-600 hover:underline">
              Admin → VendHQ Credentials
            </a>
            .
          </div>
        )}
      </div>
    </div>
  );
}
