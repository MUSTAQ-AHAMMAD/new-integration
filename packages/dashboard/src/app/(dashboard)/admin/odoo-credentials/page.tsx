'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { GenericAdminTable } from '@/components/admin/generic-admin-table';
import { ADMIN_TABLE_CONFIGS } from '@/components/admin/table-configs';
import { toast } from 'sonner';
import { FlaskConical, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const cfg = ADMIN_TABLE_CONFIGS['odoo-credentials'];

interface ProbeResult {
  ok: boolean;
  url: string;
  status: number | null;
  parsedCount: number;
  bodySnippet: string;
  error: string | null;
}

function TestConnectionDialog({
  credentialId,
  region,
  open,
  onClose,
}: {
  credentialId: string;
  region: string;
  open: boolean;
  onClose: () => void;
}) {
  const probeMutation = useMutation({
    mutationFn: () => api.probeOdooCredential(credentialId),
    onError: (e: Error) => toast.error(`Probe failed: ${e.message}`),
  });

  const result: ProbeResult | undefined = probeMutation.data;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Test Odoo Connection — {region}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-slate-500">
            Sends a limit=1 request to the configured endpoint and shows you the raw result.
            Use this to verify the API Path and Base URL are correct.
          </p>

          <Button
            onClick={() => probeMutation.mutate()}
            disabled={probeMutation.isPending}
            className="w-full gap-2"
          >
            {probeMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FlaskConical className="h-4 w-4" />
            )}
            {probeMutation.isPending ? 'Testing…' : 'Run Test'}
          </Button>

          {result && (
            <div className="rounded-lg border p-4 space-y-3">
              <div className="flex items-center gap-2">
                {result.ok ? (
                  <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0" />
                ) : (
                  <XCircle className="h-5 w-5 text-red-500 shrink-0" />
                )}
                <span className={`font-semibold text-sm ${result.ok ? 'text-green-700' : 'text-red-700'}`}>
                  {result.ok ? 'Connection succeeded' : 'Connection failed'}
                </span>
              </div>

              <div className="text-xs space-y-1 text-slate-600">
                <div><span className="font-medium">URL called:</span> <span className="font-mono break-all">{result.url}</span></div>
                <div><span className="font-medium">HTTP status:</span> {result.status ?? 'N/A'}</div>
                {result.ok && <div><span className="font-medium">Orders parsed:</span> {result.parsedCount}</div>}
              </div>

              {result.error && (
                <div className="rounded bg-red-50 border border-red-200 p-3">
                  <p className="text-xs font-semibold text-red-700 mb-1">Error</p>
                  <p className="text-xs text-red-600 font-mono whitespace-pre-wrap">{result.error}</p>
                </div>
              )}

              {result.bodySnippet && (
                <div className="rounded bg-slate-50 border border-slate-200 p-3">
                  <p className="text-xs font-semibold text-slate-600 mb-1">Response body (first 500 chars)</p>
                  <pre className="text-xs text-slate-700 whitespace-pre-wrap overflow-auto max-h-40 font-mono">{result.bodySnippet}</pre>
                </div>
              )}

              {result.ok && result.parsedCount === 0 && (
                <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded p-2">
                  ⚠ Connection succeeded but 0 orders were parsed. The response format may be unrecognised — check the body snippet above.
                </p>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function OdooCredentialsPage() {
  const [probeTarget, setProbeTarget] = useState<{ id: string; region: string } | null>(null);
  const qc = useQueryClient();
  const { data: credentials = [] } = useQuery({
    queryKey: ['odoo-credentials'],
    queryFn: () => api.listOdooCredentials(),
  });

  return (
    <div className="space-y-6">
      <GenericAdminTable
        table="odoo-credentials"
        title={cfg.title}
        fields={cfg.fields}
        readOnly={cfg.readOnly}
      />

      {credentials.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 px-5 py-3">
            <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
              <FlaskConical className="h-4 w-4 text-indigo-500" />
              Test Connections
            </h2>
            <p className="mt-0.5 text-xs text-slate-400">
              Use these buttons to verify each credential can reach its Odoo endpoint before running a backup.
            </p>
          </div>
          <div className="divide-y divide-slate-100">
            {credentials.map((cred) => (
              <div key={cred.id} className="flex items-center justify-between px-5 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800">{cred.region}</p>
                  <p className="text-xs text-slate-400 truncate">{cred.baseUrl}{cred.apiPath ?? ' (auto-detect)'}</p>
                  {!cred.active && <span className="text-xs text-amber-600">[inactive]</span>}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0 gap-1.5 text-xs"
                  onClick={() => { qc.invalidateQueries({ queryKey: ['odoo-credentials'] }); setProbeTarget({ id: cred.id, region: cred.region }); }}
                >
                  <FlaskConical className="h-3.5 w-3.5" />
                  Test
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {probeTarget && (
        <TestConnectionDialog
          credentialId={probeTarget.id}
          region={probeTarget.region}
          open={!!probeTarget}
          onClose={() => setProbeTarget(null)}
        />
      )}
    </div>
  );
}
