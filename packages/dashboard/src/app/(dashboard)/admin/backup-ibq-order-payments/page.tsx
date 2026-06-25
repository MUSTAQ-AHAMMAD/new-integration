'use client';

import { GenericAdminTable } from '@/components/admin/generic-admin-table';
import { ADMIN_TABLE_CONFIGS } from '@/components/admin/table-configs';

const cfg = ADMIN_TABLE_CONFIGS['backup-ibq-order-payments'];

export default function BackupIbqOrderPaymentsPage() {
  return (
    <GenericAdminTable
      table="backup-ibq-order-payments"
      title={cfg.title}
      fields={cfg.fields}
      readOnly={cfg.readOnly}
    />
  );
}
