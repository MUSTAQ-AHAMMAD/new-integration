import type { UserRole } from './roles.decorator';

/**
 * The visibility catalogue: every part of the dashboard an account can be
 * granted or denied. Areas are coarser than routes on purpose — an admin
 * granting "Credentials" should not have to tick four near-identical pages,
 * and adding a fifth credential screen later should not silently lock out
 * everyone who was already granted the group.
 *
 * `routes` is the prefix list the dashboard uses to filter navigation and to
 * guard direct URL entry; the backend uses `key` in \@RequireArea().
 */
export interface AreaDefinition {
  key: string;
  label: string;
  /** Sidebar section this area belongs to; used to group the admin UI. */
  group: string;
  description: string;
  routes: string[];
}

export const AREAS: AreaDefinition[] = [
  {
    key: 'dashboard',
    label: 'Dashboard & Region Status',
    group: 'Overview',
    description: 'Landing overview, live activity and per-region status.',
    routes: ['/', '/region-status', '/activity'],
  },
  {
    key: 'integration-run',
    label: 'Integration Run',
    group: 'Overview',
    description: 'Trigger and watch region integration runs.',
    routes: ['/integration-run', '/region-integration'],
  },
  {
    key: 'reconciliation',
    label: 'Reconciliation',
    group: 'Overview',
    description: 'Compare Odoo source data against what was pushed to Oracle.',
    routes: ['/reconciliation'],
  },
  {
    key: 'sync-jobs',
    label: 'Sync Jobs',
    group: 'Operations',
    description: 'Create, cancel and retry sync jobs.',
    routes: ['/sync-jobs'],
  },
  {
    key: 'orders',
    label: 'Order Manager',
    group: 'Operations',
    description: 'Browse and inspect individual orders.',
    routes: ['/orders'],
  },
  {
    key: 'pipeline',
    label: 'Odoo → Oracle Pipeline',
    group: 'Operations',
    description: 'Pipeline stage view and queue depth.',
    routes: ['/odoo-to-oracle'],
  },
  {
    key: 'data-transfer',
    label: 'Fetch & Push',
    group: 'Operations',
    description:
      'Manual fetch from Odoo/IBQ and manual push of a single order or store.',
    routes: [
      '/fetch-orders',
      '/fetch-odoo',
      '/fetch-ibq',
      '/push-order',
      '/push-store',
    ],
  },
  {
    key: 'reports',
    label: 'Reports & Analytics',
    group: 'Operations',
    description: 'Management reporting dashboards and exports.',
    routes: ['/reports'],
  },
  {
    key: 'ai-monitor',
    label: 'AI Monitor',
    group: 'Operations',
    description: 'AI-assisted anomaly monitoring.',
    routes: ['/admin/ai-monitor'],
  },
  {
    key: 'stores',
    label: 'Store Config Admin',
    group: 'Operations',
    description: 'Per-store configuration and validation.',
    routes: ['/stores'],
  },
  {
    key: 'sync-control',
    label: 'Sync Control',
    group: 'Operations',
    description: 'Pause, resume and throttle the sync pipeline.',
    routes: ['/admin/sync-control'],
  },
  {
    key: 'exceptions',
    label: 'Skipped & Failed',
    group: 'Operations',
    description: 'Skipped orders and the failed-transaction dead-letter queue.',
    routes: ['/skipped-orders', '/failed', '/failed-transactions'],
  },
  {
    key: 'alerts',
    label: 'Alerts',
    group: 'Operations',
    description: 'Raised alerts and their resolution.',
    routes: ['/alerts'],
  },
  {
    key: 'payments',
    label: 'Payment Mappings',
    group: 'Operations',
    description: 'Odoo → Oracle payment method mapping.',
    routes: ['/payments'],
  },
  {
    key: 'inventory',
    label: 'Inventory Warnings',
    group: 'Operations',
    description: 'Negative-inventory warnings raised during sync.',
    routes: ['/inventory'],
  },
  {
    key: 'audit',
    label: 'Audit Trail',
    group: 'Operations',
    description: 'Every request/response exchanged with Oracle.',
    routes: ['/audit'],
  },
  {
    key: 'health',
    label: 'System Health',
    group: 'Operations',
    description: 'Dependency health checks and uptime.',
    routes: ['/health'],
  },
  {
    key: 'settings',
    label: 'Settings',
    group: 'Operations',
    description: 'Global application settings.',
    routes: ['/settings'],
  },
  {
    key: 'notifications',
    label: 'Notifications',
    group: 'Operations',
    description: 'Notification recipients and delivery log.',
    routes: ['/notifications'],
  },
  {
    key: 'webhooks',
    label: 'Webhook Events',
    group: 'Operations',
    description: 'Inbound webhook event log.',
    routes: ['/webhooks'],
  },
  {
    key: 'refunds',
    label: 'Cancellations & Refunds',
    group: 'Cancellations & Refunds',
    description: 'Cancelled orders and refund credit memos.',
    routes: ['/cancelled-orders', '/refunds'],
  },
  {
    key: 'admin.api-config',
    label: 'API Endpoint Configs',
    group: 'Admin Panel',
    description: 'Per-region Oracle/Odoo endpoint configuration.',
    routes: ['/admin/api-endpoint-configs'],
  },
  {
    key: 'admin.credentials',
    label: 'Credentials',
    group: 'Admin Panel',
    description: 'Fusion, VendHQ, Odoo and IBQ credentials.',
    routes: [
      '/admin/fusion-credentials',
      '/admin/vendhq-credentials',
      '/admin/odoo-credentials',
      '/admin/ibq-credentials',
    ],
  },
  {
    key: 'admin.integration-config',
    label: 'Integration Config',
    group: 'Admin Panel',
    description: 'Outlet config, BU map, receipt methods and metadata.',
    routes: [
      '/admin/outlet-config',
      '/admin/fusion-bu-map',
      '/admin/fusion-receipt-methods',
      '/admin/fusion-sales-metadata',
      '/admin/service-provider-journal-meta',
      '/admin/sales-integration-status',
    ],
  },
  {
    key: 'admin.vendhq-masters',
    label: 'VendHQ Masters',
    group: 'Admin Panel',
    description: 'Outlets, registers, service providers and item metadata.',
    routes: [
      '/admin/vendhq-outlets',
      '/admin/vendhq-registers',
      '/admin/register-accounts',
      '/admin/vendhq-service-providers',
      '/admin/vendhq-tax-meta',
      '/admin/vendhq-discount-items',
      '/admin/vendhq-item-meta',
    ],
  },
  {
    key: 'admin.fusion-transactions',
    label: 'Fusion Transactions',
    group: 'Admin Panel',
    description: 'Invoice, receipt, journal and inventory rows sent to Oracle.',
    routes: [
      '/admin/fusion-invoice-headers',
      '/admin/fusion-invoice-lines',
      '/admin/fusion-standard-receipts',
      '/admin/fusion-misc-receipts',
      '/admin/fusion-apply-receipts',
      '/admin/fusion-journal-headers',
      '/admin/fusion-journal-lines',
      '/admin/fusion-inv-txns',
    ],
  },
  {
    key: 'admin.backup-archive',
    label: 'Backup Archive',
    group: 'Admin Panel',
    description: 'Raw VendHQ / Odoo / IBQ backup tables and sale sync status.',
    routes: [
      '/admin/backup-vendhq',
      '/admin/backup-odoo',
      '/admin/backup-ibq',
      '/admin/backup-sales',
      '/admin/backup-line-items',
      '/admin/backup-payments',
      '/admin/backup-promotions',
      '/admin/backup-odoo-orders',
      '/admin/backup-odoo-order-lines',
      '/admin/backup-odoo-order-payments',
      '/admin/backup-ibq-orders',
      '/admin/backup-ibq-order-lines',
      '/admin/backup-ibq-order-payments',
      '/admin/sale-sync-status',
    ],
  },
  {
    key: 'admin.users',
    label: 'User Management',
    group: 'Admin Panel',
    description: 'Create accounts, assign roles and control area visibility.',
    routes: ['/admin/users'],
  },
];

export const ALL_AREA_KEYS: string[] = AREAS.map((a) => a.key);

const OPERATOR_AREAS: string[] = ALL_AREA_KEYS.filter(
  (k) =>
    ![
      'settings',
      'admin.api-config',
      'admin.credentials',
      'admin.users',
    ].includes(k),
);

const VIEWER_AREAS: string[] = [
  'dashboard',
  'reconciliation',
  'sync-jobs',
  'orders',
  'reports',
  'exceptions',
  'alerts',
  'audit',
  'health',
  'refunds',
];

/**
 * What each role sees when no per-user override is set. ADMIN is computed from
 * the catalogue rather than listed, so a newly added area is visible to admins
 * immediately instead of being invisible until someone updates a constant.
 */
export const ROLE_DEFAULT_AREAS: Record<UserRole, string[]> = {
  ADMIN: ALL_AREA_KEYS,
  OPERATOR: OPERATOR_AREAS,
  VIEWER: VIEWER_AREAS,
};

export function isKnownArea(key: string): boolean {
  return ALL_AREA_KEYS.includes(key);
}

/**
 * Resolve what an account may actually see.
 *
 * An override never widens past the role: an OPERATOR handed `admin.users` in
 * an override still cannot see it, because the role is the ceiling and the
 * override only narrows within it. Admins are the exception — they are the
 * ceiling — so an override on an ADMIN is applied verbatim, which is how you
 * build a "billing admin" who only sees credentials.
 */
export function resolveAreas(
  role: string,
  overrides: string[] | null | undefined,
): string[] {
  const roleAreas =
    ROLE_DEFAULT_AREAS[role as UserRole] ?? ROLE_DEFAULT_AREAS.VIEWER;
  if (!overrides || overrides.length === 0) return [...roleAreas];

  const requested = overrides.filter(isKnownArea);
  if (requested.length === 0) return [...roleAreas];
  if (role === 'ADMIN') return requested;
  return requested.filter((k) => roleAreas.includes(k));
}
