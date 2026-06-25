'use client';

import { GenericAdminTable } from '@/components/admin/generic-admin-table';
import { ADMIN_TABLE_CONFIGS } from '@/components/admin/table-configs';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export default function BackupVendHQPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
        <div className="h-8 w-1 shrink-0 rounded-full bg-orange-500" />
        <div>
          <h1 className="text-xl font-bold text-slate-900">VendHQ Backup Archive</h1>
          <p className="mt-0.5 text-sm text-slate-500">Raw backup data from VendHQ — sales, line items, payments, and promotions.</p>
        </div>
      </div>

      <Tabs defaultValue="sales">
        <TabsList>
          <TabsTrigger value="sales">Sales</TabsTrigger>
          <TabsTrigger value="line-items">Line Items</TabsTrigger>
          <TabsTrigger value="payments">Payments</TabsTrigger>
          <TabsTrigger value="promotions">Promotions</TabsTrigger>
        </TabsList>
        <TabsContent value="sales">
          <GenericAdminTable
            table="backup-sales"
            title={ADMIN_TABLE_CONFIGS['backup-sales'].title}
            fields={ADMIN_TABLE_CONFIGS['backup-sales'].fields}
            readOnly={ADMIN_TABLE_CONFIGS['backup-sales'].readOnly}
          />
        </TabsContent>
        <TabsContent value="line-items">
          <GenericAdminTable
            table="backup-line-items"
            title={ADMIN_TABLE_CONFIGS['backup-line-items'].title}
            fields={ADMIN_TABLE_CONFIGS['backup-line-items'].fields}
            readOnly={ADMIN_TABLE_CONFIGS['backup-line-items'].readOnly}
          />
        </TabsContent>
        <TabsContent value="payments">
          <GenericAdminTable
            table="backup-payments"
            title={ADMIN_TABLE_CONFIGS['backup-payments'].title}
            fields={ADMIN_TABLE_CONFIGS['backup-payments'].fields}
            readOnly={ADMIN_TABLE_CONFIGS['backup-payments'].readOnly}
          />
        </TabsContent>
        <TabsContent value="promotions">
          <GenericAdminTable
            table="backup-promotions"
            title={ADMIN_TABLE_CONFIGS['backup-promotions'].title}
            fields={ADMIN_TABLE_CONFIGS['backup-promotions'].fields}
            readOnly={ADMIN_TABLE_CONFIGS['backup-promotions'].readOnly}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
