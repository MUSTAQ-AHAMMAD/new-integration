'use client';

import { GenericAdminTable } from '@/components/admin/generic-admin-table';
import { ADMIN_TABLE_CONFIGS } from '@/components/admin/table-configs';

const cfg = ADMIN_TABLE_CONFIGS['api-endpoint-configs'];

export default function ApiEndpointConfigsPage() {
  return (
    <GenericAdminTable
      table="api-endpoint-configs"
      title={cfg.title}
      fields={cfg.fields}
    />
  );
}
