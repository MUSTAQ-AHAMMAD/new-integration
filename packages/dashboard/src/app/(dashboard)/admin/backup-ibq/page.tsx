'use client';

import { GenericAdminTable } from '@/components/admin/generic-admin-table';
import { ADMIN_TABLE_CONFIGS } from '@/components/admin/table-configs';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export default function BackupIbqPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
        <div className="h-8 w-1 shrink-0 rounded-full bg-violet-500" />
        <div>
          <h1 className="text-xl font-bold text-slate-900">IBQ Backup Archive</h1>
          <p className="mt-0.5 text-sm text-slate-500">Raw backup data fetched from IBQ — orders, order lines, and payments.</p>
        </div>
      </div>

      <Tabs defaultValue="orders">
        <TabsList>
          <TabsTrigger value="orders">Orders</TabsTrigger>
          <TabsTrigger value="order-lines">Order Lines</TabsTrigger>
          <TabsTrigger value="payments">Payments</TabsTrigger>
        </TabsList>
        <TabsContent value="orders">
          <GenericAdminTable
            table="backup-ibq-orders"
            title={ADMIN_TABLE_CONFIGS['backup-ibq-orders'].title}
            fields={ADMIN_TABLE_CONFIGS['backup-ibq-orders'].fields}
            readOnly={ADMIN_TABLE_CONFIGS['backup-ibq-orders'].readOnly}
          />
        </TabsContent>
        <TabsContent value="order-lines">
          <GenericAdminTable
            table="backup-ibq-order-lines"
            title={ADMIN_TABLE_CONFIGS['backup-ibq-order-lines'].title}
            fields={ADMIN_TABLE_CONFIGS['backup-ibq-order-lines'].fields}
            readOnly={ADMIN_TABLE_CONFIGS['backup-ibq-order-lines'].readOnly}
          />
        </TabsContent>
        <TabsContent value="payments">
          <GenericAdminTable
            table="backup-ibq-order-payments"
            title={ADMIN_TABLE_CONFIGS['backup-ibq-order-payments'].title}
            fields={ADMIN_TABLE_CONFIGS['backup-ibq-order-payments'].fields}
            readOnly={ADMIN_TABLE_CONFIGS['backup-ibq-order-payments'].readOnly}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
