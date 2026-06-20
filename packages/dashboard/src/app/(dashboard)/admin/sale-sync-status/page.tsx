'use client';

import { GenericAdminTable } from '@/components/admin/generic-admin-table';
import { ADMIN_TABLE_CONFIGS } from '@/components/admin/table-configs';

const cfg = ADMIN_TABLE_CONFIGS['sale-sync-status'];

export default function SaleSyncStatusPage() {
  return (
    <GenericAdminTable
      table="sale-sync-status"
      title={cfg.title}
      fields={cfg.fields}
      readOnly={cfg.readOnly}
    />
  );
}
