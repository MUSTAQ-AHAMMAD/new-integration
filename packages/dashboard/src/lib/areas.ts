/**
 * Route → area map, mirroring `packages/backend/src/auth/areas.ts`.
 *
 * The backend owns the catalogue (it decides what a role grants and enforces
 * it on the API); this file only needs to know which area a URL belongs to so
 * navigation can be filtered and a pasted URL can be blocked before the page
 * fires a request that would 403 anyway. Keep the keys in step with the
 * backend — `pnpm --filter backend test` covers the backend half.
 */

export const AREA_ROUTES: Record<string, string[]> = {
  dashboard: ['/', '/region-status', '/activity'],
  'integration-run': ['/integration-run', '/region-integration'],
  reconciliation: ['/reconciliation'],
  'sync-jobs': ['/sync-jobs'],
  orders: ['/orders'],
  pipeline: ['/odoo-to-oracle'],
  'data-transfer': [
    '/fetch-orders',
    '/fetch-odoo',
    '/fetch-ibq',
    '/push-order',
    '/push-store',
  ],
  reports: ['/reports'],
  'ai-monitor': ['/admin/ai-monitor'],
  stores: ['/stores'],
  'sync-control': ['/admin/sync-control'],
  exceptions: ['/skipped-orders', '/failed', '/failed-transactions'],
  alerts: ['/alerts'],
  payments: ['/payments'],
  inventory: ['/inventory'],
  audit: ['/audit'],
  health: ['/health'],
  settings: ['/settings'],
  notifications: ['/notifications'],
  webhooks: ['/webhooks'],
  refunds: ['/cancelled-orders', '/refunds'],
  'admin.api-config': ['/admin/api-endpoint-configs'],
  'admin.credentials': [
    '/admin/fusion-credentials',
    '/admin/vendhq-credentials',
    '/admin/odoo-credentials',
    '/admin/ibq-credentials',
  ],
  'admin.integration-config': [
    '/admin/outlet-config',
    '/admin/fusion-bu-map',
    '/admin/fusion-receipt-methods',
    '/admin/fusion-sales-metadata',
    '/admin/service-provider-journal-meta',
    '/admin/sales-integration-status',
  ],
  'admin.vendhq-masters': [
    '/admin/vendhq-outlets',
    '/admin/vendhq-registers',
    '/admin/register-accounts',
    '/admin/vendhq-service-providers',
    '/admin/vendhq-tax-meta',
    '/admin/vendhq-discount-items',
    '/admin/vendhq-item-meta',
  ],
  'admin.fusion-transactions': [
    '/admin/fusion-invoice-headers',
    '/admin/fusion-invoice-lines',
    '/admin/fusion-standard-receipts',
    '/admin/fusion-misc-receipts',
    '/admin/fusion-apply-receipts',
    '/admin/fusion-journal-headers',
    '/admin/fusion-journal-lines',
    '/admin/fusion-inv-txns',
  ],
  'admin.backup-archive': [
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
  'admin.users': ['/admin/users'],
};

/** Longest route first, so `/admin/backup-odoo-orders` never resolves as `/admin/backup-odoo`. */
const ROUTE_INDEX: { route: string; area: string }[] = Object.entries(AREA_ROUTES)
  .flatMap(([area, routes]) => routes.map((route) => ({ route, area })))
  .sort((a, b) => b.route.length - a.route.length);

/**
 * Which area a path belongs to, or null when it maps to nothing (a page added
 * without a catalogue entry stays reachable rather than silently disappearing).
 */
export function areaForPath(pathname: string): string | null {
  if (pathname === '/') return 'dashboard';
  const match = ROUTE_INDEX.find(
    ({ route }) =>
      route !== '/' && (pathname === route || pathname.startsWith(`${route}/`)),
  );
  return match?.area ?? null;
}
