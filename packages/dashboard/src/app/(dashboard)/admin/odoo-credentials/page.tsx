'use client';

import { GenericAdminTable } from '@/components/admin/generic-admin-table';
import { ADMIN_TABLE_CONFIGS } from '@/components/admin/table-configs';

const cfg = ADMIN_TABLE_CONFIGS['odoo-credentials'];

export default function OdooCredentialsPage() {
  return (
    <GenericAdminTable
      table="odoo-credentials"
      title={cfg.title}
      fields={cfg.fields}
      readOnly={cfg.readOnly}
    />
  );
}
