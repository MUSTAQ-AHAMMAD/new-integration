'use client';

import { GenericAdminTable } from '@/components/admin/generic-admin-table';
import { ADMIN_TABLE_CONFIGS } from '@/components/admin/table-configs';

const cfg = ADMIN_TABLE_CONFIGS['backup-ibq-orders'];

export default function BackupIbqOrdersPage() {
  return (
    <GenericAdminTable
      table="backup-ibq-orders"
      title={cfg.title}
      fields={cfg.fields}
      readOnly={cfg.readOnly}
    />
  );
}
