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
  Download,
  FileText,
  Globe,
  Heart,
  Key,
  LayoutDashboard,
  Package,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Settings,
  Server,
  ShoppingCart,
  Store,
  Wallet,
  Zap,
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
  { href: '/region-integration', label: 'Region Integration', icon: Globe },
  { href: '/sync-jobs', label: 'Sync Jobs', icon: RefreshCw },
  { href: '/orders', label: 'Order Manager', icon: ShoppingCart },
  { href: '/odoo-to-oracle', label: 'Odoo → Oracle Pipeline', icon: Play },
  { href: '/fetch-odoo', label: 'Fetch from Odoo', icon: Download },
  { href: '/push-order', label: 'Push Single Order', icon: Send },
  { href: '/push-store', label: 'Push Single Store', icon: Store },
];

const operationalItems: NavItem[] = [
  { href: '/stores', label: 'Store Config Admin', icon: Building2 },
  { href: '/alerts', label: 'Alerts', icon: Bell },
  { href: '/failed', label: 'Failed Transactions', icon: AlertTriangle },
  { href: '/payments', label: 'Payment Mappings', icon: CreditCard },
  { href: '/refunds', label: 'Refund Reconciliation', icon: RotateCcw },
  { href: '/inventory', label: 'Inventory Warnings', icon: Package },
  { href: '/audit', label: 'Audit Trail', icon: Search },
  { href: '/health', label: 'System Health', icon: Heart },
  { href: '/settings', label: 'Settings', icon: Settings },
  { href: '/notifications', label: 'Notifications', icon: Bell },
  { href: '/webhooks', label: 'Webhook Events', icon: Activity },
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
      { href: '/admin/sale-sync-status', label: 'Sale Sync Status', icon: Activity },
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
        'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150',
        isActive
          ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-900/40'
          : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100',
      )}
    >
      <Icon className={cn('h-4 w-4 shrink-0 transition-colors', isActive ? 'text-white' : 'text-slate-500 group-hover:text-slate-300')} />
      {label}
    </Link>
  );
}

function SectionLabel({ label }: { label: string }) {
  return (
    <p className="px-3 pb-1 pt-3 text-xs font-bold uppercase tracking-widest text-slate-400">
      {label}
    </p>
  );
}

function NavGroupSection({ group, onNavigate }: { group: NavGroup; onNavigate?: () => void }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(true);
  const isActive = group.items.some((i) => pathname === i.href);
  void isActive;
  const Icon = group.icon;

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200"
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
        <div className="ml-2 mt-0.5 space-y-0.5 border-l border-slate-700/60 pl-2">
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
    <aside className={mobile ? 'flex flex-1 flex-col overflow-y-auto bg-slate-900' : 'hidden w-64 flex-col bg-slate-900 lg:flex'}>
      {!mobile && (
        <div className="flex items-center gap-3 border-b border-slate-800 px-5 py-5">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 shadow-lg shadow-indigo-900/60">
            <Zap className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-sm font-black text-white">Integration Hub</h1>
            <p className="text-[11px] text-slate-400">Odoo → Oracle Fusion</p>
          </div>
        </div>
      )}
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-4">
        {topItems.map((item) => (
          <NavLink key={item.href} {...item} onNavigate={onNavigate} />
        ))}
        <SectionLabel label="Operations" />
        {operationalItems.map((item) => (
          <NavLink key={item.href} {...item} onNavigate={onNavigate} />
        ))}
        <SectionLabel label="Admin Panel" />
        <div className="space-y-0.5">
          {adminGroups.map((group) => (
            <NavGroupSection key={group.label} group={group} onNavigate={onNavigate} />
          ))}
        </div>
      </nav>
      <div className="border-t border-slate-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-600 text-[10px] font-bold text-white">
            E
          </div>
          <span className="text-xs text-slate-400">v0.1.0 · Enterprise</span>
        </div>
      </div>
    </aside>
  );
}
