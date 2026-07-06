'use client';

import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useRegion } from '@/providers/region-provider';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PageHeader } from '@/components/ui/page-header';
import { RefreshCw, Save, Landmark } from 'lucide-react';
import {
  api,
  type AccountOption,
  type RegisterAccountsPreview,
  type RegisterProposal,
} from '@/lib/api';

type Edit = { bankAccountId: number | null; cashAccountId: number | null };

export default function RegisterAccountsPage() {
  const { selectedRegion } = useRegion();
  const [preview, setPreview] = useState<RegisterAccountsPreview | null>(null);
  const [edits, setEdits] = useState<Record<string, Edit>>({});

  const previewMut = useMutation({
    mutationFn: () => api.registerAccountsPreview(selectedRegion ?? undefined),
    onSuccess: (data) => {
      setPreview(data);
      const seed: Record<string, Edit> = {};
      for (const p of data.proposals) {
        seed[p.registerId] = {
          bankAccountId: p.proposedBankAccountId ?? p.currentBankAccountId,
          cashAccountId: p.proposedCashAccountId ?? p.currentCashAccountId,
        };
      }
      setEdits(seed);
      toast.success(
        `Loaded ${data.summary.registers} registers, ${data.summary.oracleAccounts} Oracle accounts`,
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const applyMut = useMutation({
    mutationFn: () => {
      const assignments = Object.entries(edits)
        .filter(([, e]) => e.bankAccountId != null || e.cashAccountId != null)
        .map(([registerId, e]) => ({
          registerId,
          bankAccountId: e.bankAccountId,
          cashAccountId: e.cashAccountId,
        }));
      return api.registerAccountsApply(assignments);
    },
    onSuccess: (r) => toast.success(`Updated ${r.updated} registers`),
    onError: (e: Error) => toast.error(e.message),
  });

  const bankOptions = useMemo(
    () => (preview?.accounts ?? []).filter((a) => !a.isCash),
    [preview],
  );
  const cashOptions = useMemo(
    () => (preview?.accounts ?? []).filter((a) => a.isCash),
    [preview],
  );

  const setEdit = (id: string, patch: Partial<Edit>) =>
    setEdits((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Register Bank/Cash Accounts"
        subtitle="Match each VendHQ register to its current Oracle Fusion bank & cash account (the remittance account used on receipts) and write the IDs back."
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Landmark className="h-5 w-5" /> Refresh from Oracle
          </CardTitle>
          <CardDescription>
            Fetches AR-usable accounts from Oracle Fusion and proposes a match
            for each register. Review the proposals, adjust where needed, then
            apply.{' '}
            {selectedRegion
              ? `Region filter: ${selectedRegion}.`
              : 'All regions.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          <Button
            onClick={() => previewMut.mutate()}
            disabled={previewMut.isPending}
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${previewMut.isPending ? 'animate-spin' : ''}`}
            />
            {previewMut.isPending ? 'Loading…' : 'Fetch & Preview'}
          </Button>
          {preview && (
            <Button
              variant="default"
              onClick={() => applyMut.mutate()}
              disabled={applyMut.isPending}
            >
              <Save className="mr-2 h-4 w-4" />
              {applyMut.isPending ? 'Applying…' : 'Apply Changes'}
            </Button>
          )}
        </CardContent>
      </Card>

      {preview && (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <SummaryCard label="Registers" value={preview.summary.registers} />
            <SummaryCard
              label="Oracle Accounts"
              value={preview.summary.oracleAccounts}
            />
            <SummaryCard
              label="Auto-matched"
              value={preview.summary.autoMatched}
            />
            <SummaryCard
              label="Unmatched"
              value={preview.summary.unmatched}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Register → Account mapping</CardTitle>
              <CardDescription>
                Bank account = card receipts; Cash account = cash receipts.
                Green score = confident auto-match.
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Register</TableHead>
                    <TableHead>Region</TableHead>
                    <TableHead>Bank account (card)</TableHead>
                    <TableHead>Cash account (cash)</TableHead>
                    <TableHead>Match</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.proposals.map((p) => (
                    <RegisterRow
                      key={p.registerId}
                      p={p}
                      edit={edits[p.registerId]}
                      bankOptions={bankOptions}
                      cashOptions={cashOptions}
                      onBank={(v) => setEdit(p.registerId, { bankAccountId: v })}
                      onCash={(v) => setEdit(p.registerId, { cashAccountId: v })}
                    />
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-2xl font-bold">{value}</div>
        <div className="text-sm text-muted-foreground">{label}</div>
      </CardContent>
    </Card>
  );
}

function AccountSelect({
  value,
  options,
  onChange,
}: {
  value: number | null;
  options: AccountOption[];
  onChange: (v: number | null) => void;
}) {
  return (
    <select
      className="w-full max-w-[280px] rounded-md border border-input bg-background px-2 py-1 text-sm"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
    >
      <option value="">— none —</option>
      {options.map((a) => (
        <option key={a.bankAccountId} value={a.bankAccountId}>
          {a.name}
          {a.currency ? ` (${a.currency})` : ''}
        </option>
      ))}
    </select>
  );
}

function RegisterRow({
  p,
  edit,
  bankOptions,
  cashOptions,
  onBank,
  onCash,
}: {
  p: RegisterProposal;
  edit: Edit | undefined;
  bankOptions: AccountOption[];
  cashOptions: AccountOption[];
  onBank: (v: number | null) => void;
  onCash: (v: number | null) => void;
}) {
  const pct = Math.round((p.score ?? 0) * 100);
  return (
    <TableRow>
      <TableCell className="font-medium">{p.registerName}</TableCell>
      <TableCell>{p.region}</TableCell>
      <TableCell>
        <AccountSelect
          value={edit?.bankAccountId ?? null}
          options={bankOptions}
          onChange={onBank}
        />
      </TableCell>
      <TableCell>
        <AccountSelect
          value={edit?.cashAccountId ?? null}
          options={cashOptions}
          onChange={onCash}
        />
      </TableCell>
      <TableCell>
        {pct > 0 ? (
          <Badge variant={pct >= 50 ? 'default' : 'secondary'}>{pct}%</Badge>
        ) : (
          <Badge variant="outline">manual</Badge>
        )}
      </TableCell>
    </TableRow>
  );
}
