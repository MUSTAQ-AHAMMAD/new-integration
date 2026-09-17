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
}
