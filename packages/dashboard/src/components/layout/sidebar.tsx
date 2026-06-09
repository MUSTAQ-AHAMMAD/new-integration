'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import {
  Activity,
  AlertTriangle,
  Archive,
  Bell,
  Building2,
  ChevronDown,
  ChevronRight,
  CreditCard,
  Database,
  FileText,
  Heart,
  Key,
  LayoutDashboard,
  Package,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Settings,
  Server,
  ShoppingCart,
  Store,
  Wallet,
} from 'lucide-react';

interface NavItem {
  href: string;
  label: string;
  icon: React.ElementType;
}

interface NavGroup {
  label: string;
  icon: React.ElementType;
  items: NavItem[];
}

const topItems: NavItem[] = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/sync-jobs', label: 'Sync Jobs', icon: RefreshCw },
  { href: '/orders', label: 'Order Manager', icon: ShoppingCart },
  { href: '/push-order', label: 'Push Single Order', icon: Send },
  { href: '/push-store', label: 'Push Single Store', icon: Store },
];

const operationalItems: NavItem[] = [
  { href: '/stores', label: 'Store Config Admin', icon: Building2 },
  { href: '/alerts', label: 'Alerts', icon: Bell },
  { href: '/failed', label: 'Failed Transactions', icon: AlertTriangle },
  { href: '/failed-transactions', label: 'Failed (Legacy)', icon: AlertTriangle },
  { href: '/payments', label: 'Payment Mappings', icon: CreditCard },
  { href: '/refunds', label: 'Refund Reconciliation', icon: RotateCcw },
  { href: '/inventory', label: 'Inventory Warnings', icon: Package },
  { href: '/audit', label: 'Audit Trail', icon: Search },
  { href: '/health', label: 'System Health', icon: Heart },
  { href: '/settings', label: 'Settings', icon: Settings },
  { href: '/notifications', label: 'Notifications', icon: Bell },
  { href: '/webhooks', label: 'Webhook Events', icon: Activity },
  { href: '/activity', label: 'Audit Log (Legacy)', icon: FileText },
];

const adminGroups: NavGroup[] = [
  {
    label: 'Credentials',
    icon: Key,
    items: [
      { href: '/admin/fusion-credentials', label: 'Fusion Credentials', icon: Server },
      { href: '/admin/vendhq-credentials', label: 'VendHQ Credentials', icon: Key },
    ],
  },
  {
    label: 'Integration Config',
    icon: Settings,
    items: [
      { href: '/admin/outlet-config', label: 'Outlet Config', icon: Building2 },
      { href: '/admin/fusion-bu-map', label: 'BU Map', icon: Database },
      { href: '/admin/fusion-receipt-methods', label: 'Receipt Methods', icon: CreditCard },
      { href: '/admin/fusion-sales-metadata', label: 'Sales Metadata', icon: FileText },
      { href: '/admin/service-provider-journal-meta', label: 'Journal Meta', icon: FileText },
      { href: '/admin/sales-integration-status', label: 'Integration Status', icon: Activity },
    ],
  },
  {
    label: 'VendHQ Masters',
    icon: Store,
    items: [
      { href: '/admin/vendhq-outlets', label: 'Outlets', icon: Building2 },
      { href: '/admin/vendhq-registers', label: 'Registers', icon: Server },
      { href: '/admin/vendhq-service-providers', label: 'Service Providers', icon: Server },
      { href: '/admin/vendhq-tax-meta', label: 'Tax Meta', icon: Wallet },
      { href: '/admin/vendhq-discount-items', label: 'Discount Items', icon: Package },
      { href: '/admin/vendhq-item-meta', label: 'Item Meta', icon: Package },
    ],
  },
  {
    label: 'Fusion Transactions',
    icon: Database,
    items: [
      { href: '/admin/fusion-invoice-headers', label: 'Invoice Headers', icon: FileText },
      { href: '/admin/fusion-invoice-lines', label: 'Invoice Lines', icon: FileText },
      { href: '/admin/fusion-standard-receipts', label: 'Standard Receipts', icon: Wallet },
      { href: '/admin/fusion-misc-receipts', label: 'Misc Receipts', icon: Wallet },
      { href: '/admin/fusion-apply-receipts', label: 'Apply Receipts', icon: Wallet },
      { href: '/admin/fusion-journal-headers', label: 'Journal Headers', icon: FileText },
      { href: '/admin/fusion-journal-lines', label: 'Journal Lines', icon: FileText },
      { href: '/admin/fusion-inv-txns', label: 'Inventory Txns', icon: Package },
    ],
  },
  {
    label: 'Backup Archive',
    icon: Archive,
    items: [
      { href: '/admin/backup-sales', label: 'Sales Backup', icon: Archive },
      { href: '/admin/backup-line-items', label: 'Line Items Backup', icon: Archive },
      { href: '/admin/backup-payments', label: 'Payments Backup', icon: Archive },
      { href: '/admin/backup-promotions', label: 'Promotions Backup', icon: Archive },
    ],
  },
];

function NavLink({ href, label, icon: Icon, onNavigate }: NavItem & { onNavigate?: () => void }) {
  const pathname = usePathname();
  const isActive = pathname === href;
  return (
    <Link
      href={href}
      onClick={onNavigate}
      className={cn(
        'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
        isActive
          ? 'bg-blue-50 font-medium text-blue-700'
          : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900',
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {label}
    </Link>
  );
}

function NavGroupSection({ group, onNavigate }: { group: NavGroup; onNavigate?: () => void }) {
  const pathname = usePathname();
  const hasActive = group.items.some((i) => pathname === i.href);
  const [open, setOpen] = useState(hasActive);
  const Icon = group.icon;

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs font-semibold uppercase tracking-wider text-gray-400 hover:bg-gray-50"
      >
        <span className="flex items-center gap-2">
          <Icon className="h-3.5 w-3.5" />
          {group.label}
        </span>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
      </button>
      {open && (
        <div className="ml-2 mt-0.5 space-y-0.5 border-l border-gray-100 pl-2">
          {group.items.map((item) => (
            <NavLink key={item.href} {...item} onNavigate={onNavigate} />
          ))}
        </div>
      )}
    </div>
  );
}

export function Sidebar({ mobile = false, onNavigate }: { mobile?: boolean; onNavigate?: () => void }) {
  return (
    <aside className={mobile ? 'flex flex-1 flex-col overflow-y-auto' : 'hidden w-64 flex-col border-r border-gray-200 bg-white lg:flex'}>
      {!mobile && (
        <div className="border-b p-6">
          <div className="flex items-center gap-2">
            <Activity className="h-6 w-6 text-blue-600" />
            <div>
              <h1 className="font-bold text-gray-900">Integration</h1>
              <p className="text-xs text-gray-400">Odoo → Oracle Fusion</p>
            </div>
          </div>
        </div>
      )}
      <nav className="flex-1 space-y-1 overflow-y-auto p-4">
        {topItems.map((item) => (
          <NavLink key={item.href} {...item} onNavigate={onNavigate} />
        ))}
        <div className="my-2 border-t border-gray-100" />
        {operationalItems.map((item) => (
          <NavLink key={item.href} {...item} onNavigate={onNavigate} />
        ))}
        <div className="my-2 border-t border-gray-100" />
        <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-gray-400">
          Admin Panel
        </p>
        {adminGroups.map((group) => (
          <NavGroupSection key={group.label} group={group} onNavigate={onNavigate} />
        ))}
      </nav>
      <div className="border-t p-4 text-xs text-gray-400">v0.1.0 · Enterprise Integration</div>
    </aside>
  );
}
