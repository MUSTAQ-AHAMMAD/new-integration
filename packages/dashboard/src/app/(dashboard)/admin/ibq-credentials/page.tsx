'use client';

import { GenericAdminTable } from '@/components/admin/generic-admin-table';
import { ADMIN_TABLE_CONFIGS } from '@/components/admin/table-configs';

const cfg = ADMIN_TABLE_CONFIGS['ibq-credentials'];

export default function IbqCredentialsPage() {
  return (
    <GenericAdminTable
      table="ibq-credentials"
      title={cfg.title}
      fields={cfg.fields}
      readOnly={cfg.readOnly}
    />
  );
}
