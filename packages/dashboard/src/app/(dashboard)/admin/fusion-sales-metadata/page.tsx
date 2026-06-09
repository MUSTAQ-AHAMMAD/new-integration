'use client';

import { GenericAdminTable } from '@/components/admin/generic-admin-table';
import { ADMIN_TABLE_CONFIGS } from '@/components/admin/table-configs';

const cfg = ADMIN_TABLE_CONFIGS['fusion-sales-metadata'];

export default function FusionSalesMetadataPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{cfg.title}</h1>
        <p className="text-sm text-gray-500">
          {cfg.readOnly ? 'Read-only archive table' : 'Full CRUD admin management'}
        </p>
      </div>
      <GenericAdminTable
        table="fusion-sales-metadata"
        title={cfg.title}
        fields={cfg.fields}
        readOnly={cfg.readOnly}
      />
    </div>
  );
}
