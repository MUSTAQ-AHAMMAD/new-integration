'use client';

import { GenericAdminTable } from '@/components/admin/generic-admin-table';
import { ADMIN_TABLE_CONFIGS } from '@/components/admin/table-configs';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export default function BackupOdooPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
        <div className="h-8 w-1 shrink-0 rounded-full bg-indigo-500" />
        <div>
          <h1 className="text-xl font-bold text-slate-900">Odoo Backup Archive</h1>
          <p className="mt-0.5 text-sm text-slate-500">Raw backup data fetched from Odoo — orders, order lines, and payments.</p>
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
            table="backup-odoo-orders"
            title={ADMIN_TABLE_CONFIGS['backup-odoo-orders'].title}
            fields={ADMIN_TABLE_CONFIGS['backup-odoo-orders'].fields}
            readOnly={ADMIN_TABLE_CONFIGS['backup-odoo-orders'].readOnly}
          />
        </TabsContent>
        <TabsContent value="order-lines">
          <GenericAdminTable
            table="backup-odoo-order-lines"
            title={ADMIN_TABLE_CONFIGS['backup-odoo-order-lines'].title}
            fields={ADMIN_TABLE_CONFIGS['backup-odoo-order-lines'].fields}
            readOnly={ADMIN_TABLE_CONFIGS['backup-odoo-order-lines'].readOnly}
          />
        </TabsContent>
        <TabsContent value="payments">
          <GenericAdminTable
            table="backup-odoo-order-payments"
            title={ADMIN_TABLE_CONFIGS['backup-odoo-order-payments'].title}
            fields={ADMIN_TABLE_CONFIGS['backup-odoo-order-payments'].fields}
            readOnly={ADMIN_TABLE_CONFIGS['backup-odoo-order-payments'].readOnly}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
