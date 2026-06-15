'use client';

import { GenericAdminTable } from '@/components/admin/generic-admin-table';
import { ADMIN_TABLE_CONFIGS } from '@/components/admin/table-configs';

const cfg = ADMIN_TABLE_CONFIGS['backup-sales'];

export default function BackupVendHQSalesPage() {
  return (
    <GenericAdminTable
      table="backup-sales"
      title={cfg.title}
      fields={cfg.fields}
      readOnly={cfg.readOnly}
    />
  );
}
