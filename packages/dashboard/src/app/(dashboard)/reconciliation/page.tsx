'use client';

import { ShieldCheck } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { OdooOracleTab } from '@/components/reconciliation/odoo-oracle-tab';
import { OdooSourceTab } from '@/components/reconciliation/odoo-source-tab';

/**
 * Reconciliation has two halves that answer different questions, so they are
 * separate tabs rather than one long page:
 *   1. Odoo ↔ Oracle — did what we booked in Odoo actually reach Oracle intact?
 *   2. Odoo source   — did what Odoo's API returned land in our tables intact?
 * The second is the precondition for trusting the first, which is why the
 * mismatch finder leads.
 */
export default function ReconciliationPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Reconciliation"
        subtitle="Put Odoo next to Oracle and find what disagrees."
        icon={ShieldCheck}
      />

      <Tabs defaultValue="odoo-oracle">
        <TabsList>
          <TabsTrigger value="odoo-oracle">Odoo ↔ Oracle</TabsTrigger>
          <TabsTrigger value="odoo-source">Odoo source integrity</TabsTrigger>
        </TabsList>

        <TabsContent value="odoo-oracle" className="mt-4">
          <OdooOracleTab />
        </TabsContent>
        <TabsContent value="odoo-source" className="mt-4">
          <OdooSourceTab />
        </TabsContent>
      </Tabs>
    </div>
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Search className="h-5 w-5 text-indigo-600" /> Verify one stored order
        </CardTitle>
        <CardDescription>Compare an order&apos;s raw Odoo payload with the parsed rows stored for it.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Input
            value={orderId}
            onChange={(e) => setOrderId(e.target.value)}
            placeholder="Odoo order id (e.g. 12345)"
            className="h-9 w-64"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && orderId.trim()) analyze.mutate(orderId.trim());
            }}
          />
          <Button disabled={!orderId.trim() || analyze.isPending} onClick={() => analyze.mutate(orderId.trim())}>
            Analyze
          </Button>
        </div>
        {analyze.isError && <p className="text-sm text-red-600">Could not analyze that order — check the id exists in the backup.</p>}
        {analysis &&
          (analysis.error ? (
            <p className="text-sm text-amber-600">{analysis.error}</p>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              {kv('Line items (API payload)', analysis.lineItems)}
              {kv('Payments (API payload)', analysis.payments)}
              {kv('Stored counts', analysis.actualCounts)}
            </div>
          ))}
      </CardContent>
    </Card>
  );
}
