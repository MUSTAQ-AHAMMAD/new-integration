'use client';

import { GenericAdminTable } from '@/components/admin/generic-admin-table';
import { ADMIN_TABLE_CONFIGS } from '@/components/admin/table-configs';

const cfg = ADMIN_TABLE_CONFIGS['backup-odoo-order-payments'];

export default function BackupOdooOrderPaymentsPage() {
  return (
    <GenericAdminTable
      table="backup-odoo-order-payments"
      title={cfg.title}
      fields={cfg.fields}
      readOnly={cfg.readOnly}
    />
  );
}
