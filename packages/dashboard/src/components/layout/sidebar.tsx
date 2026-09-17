'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/providers/auth-provider';
import {
  Activity,
  AlertTriangle,
  Archive,
  Ban,
  BarChart3,
  Bell,
  Bot,
  Building2,
  ChevronDown,
  ChevronRight,
  CreditCard,
  Database,
  Download,
  FileMinus,
  FileText,
  Globe,
  ShieldCheck,
  Heart,
  Key,
  LayoutDashboard,
  Package,
  Play,
  RefreshCw,
  Search,
  Send,
  Settings,
  Server,
  ShoppingCart,
  Store,
  UserCog,
  Wallet,
  Zap,
} from 'lucide-react';

interface NavItem {
  href: string;
  label: string;
  icon: React.ElementType;
  /** Visibility area from lib/areas.ts; omitted means always visible. */
  area?: string;
}

interface NavGroup {
  label: string;
  icon: React.ElementType;
  area?: string;
  items: NavItem[];
}

const topItems: NavItem[] = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard, area: 'dashboard' },
  { href: '/region-status', label: 'Region Status', icon: Globe, area: 'dashboard' },
  { href: '/integration-run', label: 'Integration Run', icon: Play, area: 'integration-run' },
  { href: '/reconciliation', label: 'Reconciliation', icon: ShieldCheck, area: 'reconciliation' },
  { href: '/region-integration', label: 'Region Integration', icon: Globe, area: 'integration-run' },
  { href: '/sync-jobs', label: 'Sync Jobs', icon: RefreshCw, area: 'sync-jobs' },
  { href: '/orders', label: 'Order Manager', icon: ShoppingCart, area: 'orders' },
  { href: '/odoo-to-oracle', label: 'Odoo → Oracle Pipeline', icon: Play, area: 'pipeline' },
  { href: '/fetch-orders', label: 'Fetch Orders', icon: Download, area: 'data-transfer' },
  { href: '/push-order', label: 'Push Single Order', icon: Send, area: 'data-transfer' },
  { href: '/push-store', label: 'Push Single Store', icon: Store, area: 'data-transfer' },
];

const operationalItems: NavItem[] = [
  { href: '/reports', label: 'Reports & Analytics', icon: BarChart3, area: 'reports' },
  { href: '/admin/ai-monitor', label: 'AI Monitor', icon: Bot, area: 'ai-monitor' },
  { href: '/stores', label: 'Store Config Admin', icon: Building2, area: 'stores' },
  { href: '/admin/sync-control', label: 'Sync Control', icon: RefreshCw, area: 'sync-control' },
  { href: '/skipped-orders', label: 'Skipped Orders', icon: AlertTriangle, area: 'exceptions' },
  { href: '/alerts', label: 'Alerts', icon: Bell, area: 'alerts' },
  { href: '/failed', label: 'Failed Transactions', icon: AlertTriangle, area: 'exceptions' },
  { href: '/payments', label: 'Payment Mappings', icon: CreditCard, area: 'payments' },
  { href: '/inventory', label: 'Inventory Warnings', icon: Package, area: 'inventory' },
  { href: '/audit', label: 'Audit Trail', icon: Search, area: 'audit' },
  { href: '/health', label: 'System Health', icon: Heart, area: 'health' },
  { href: '/settings', label: 'Settings', icon: Settings, area: 'settings' },
  { href: '/notifications', label: 'Notifications', icon: Bell, area: 'notifications' },
  { href: '/webhooks', label: 'Webhook Events', icon: Activity, area: 'webhooks' },
];

// Cancelled and refund orders never sync to Oracle as invoices — they live in
// their own section. Cancelled orders are skipped; refunds are pushed as credit
// memos (see /refunds).
const cancellationsItems: NavItem[] = [
  { href: '/cancelled-orders', label: 'Cancelled Orders', icon: Ban, area: 'refunds' },
  { href: '/refunds', label: 'Refunds & Credit Memos', icon: FileMinus, area: 'refunds' },
];

const adminGroups: NavGroup[] = [
  {
    label: 'Access Control',
    icon: UserCog,
    area: 'admin.users',
    items: [
      { href: '/admin/users', label: 'User Management', icon: UserCog, area: 'admin.users' },
    ],
  },
  {
    label: 'API Config',
    icon: Globe,
    area: 'admin.api-config',
    items: [
      { href: '/admin/api-endpoint-configs', label: 'API Endpoint Configs', icon: Globe, area: 'admin.api-config' },
    ],
  },
  {
    label: 'Credentials',
    icon: Key,
    area: 'admin.credentials',
    items: [
      { href: '/admin/fusion-credentials', label: 'Fusion Credentials', icon: Server, area: 'admin.credentials' },
      { href: '/admin/vendhq-credentials', label: 'VendHQ Credentials', icon: Key, area: 'admin.credentials' },
      { href: '/admin/odoo-credentials', label: 'Odoo Credentials', icon: Key, area: 'admin.credentials' },
      { href: '/admin/ibq-credentials', label: 'IBQ Credentials', icon: Key, area: 'admin.credentials' },
    ],
  },
  {
    label: 'Integration Config',
    icon: Settings,
    area: 'admin.integration-config',
    items: [
      { href: '/admin/outlet-config', label: 'Outlet Config', icon: Building2, area: 'admin.integration-config' },
      { href: '/admin/fusion-bu-map', label: 'BU Map', icon: Database, area: 'admin.integration-config' },
      { href: '/admin/fusion-receipt-methods', label: 'Receipt Methods', icon: CreditCard, area: 'admin.integration-config' },
      { href: '/admin/fusion-sales-metadata', label: 'Sales Metadata', icon: FileText, area: 'admin.integration-config' },
      { href: '/admin/service-provider-journal-meta', label: 'Journal Meta', icon: FileText, area: 'admin.integration-config' },
      { href: '/admin/sales-integration-status', label: 'Integration Status', icon: Activity, area: 'admin.integration-config' },
    ],
  },
  {
    label: 'VendHQ Masters',
    icon: Store,
    area: 'admin.vendhq-masters',
    items: [
      { href: '/admin/vendhq-outlets', label: 'Outlets', icon: Building2, area: 'admin.vendhq-masters' },
      { href: '/admin/vendhq-registers', label: 'Registers', icon: Server, area: 'admin.vendhq-masters' },
      { href: '/admin/register-accounts', label: 'Register Accounts', icon: Wallet, area: 'admin.vendhq-masters' },
      { href: '/admin/vendhq-service-providers', label: 'Service Providers', icon: Server, area: 'admin.vendhq-masters' },
      { href: '/admin/vendhq-tax-meta', label: 'Tax Meta', icon: Wallet, area: 'admin.vendhq-masters' },
      { href: '/admin/vendhq-discount-items', label: 'Discount Items', icon: Package, area: 'admin.vendhq-masters' },
      { href: '/admin/vendhq-item-meta', label: 'Item Meta', icon: Package, area: 'admin.vendhq-masters' },
    ],
  },
  {
    label: 'Fusion Transactions',
    icon: Database,
    area: 'admin.fusion-transactions',
    items: [
      { href: '/admin/fusion-invoice-headers', label: 'Invoice Headers', icon: FileText, area: 'admin.fusion-transactions' },
      { href: '/admin/fusion-invoice-lines', label: 'Invoice Lines', icon: FileText, area: 'admin.fusion-transactions' },
      { href: '/admin/fusion-standard-receipts', label: 'Standard Receipts', icon: Wallet, area: 'admin.fusion-transactions' },
      { href: '/admin/fusion-misc-receipts', label: 'Misc Receipts', icon: Wallet, area: 'admin.fusion-transactions' },
      { href: '/admin/fusion-apply-receipts', label: 'Apply Receipts', icon: Wallet, area: 'admin.fusion-transactions' },
      { href: '/admin/fusion-journal-headers', label: 'Journal Headers', icon: FileText, area: 'admin.fusion-transactions' },
      { href: '/admin/fusion-journal-lines', label: 'Journal Lines', icon: FileText, area: 'admin.fusion-transactions' },
      { href: '/admin/fusion-inv-txns', label: 'Inventory Txns', icon: Package, area: 'admin.fusion-transactions' },
    ],
  },
  {
    label: 'Backup Archive',
    icon: Archive,
    area: 'admin.backup-archive',
    items: [
      { href: '/admin/backup-vendhq', label: 'VendHQ Backup', icon: Archive, area: 'admin.backup-archive' },
      { href: '/admin/backup-odoo', label: 'Odoo Backup', icon: Archive, area: 'admin.backup-archive' },
      { href: '/admin/backup-ibq', label: 'IBQ Backup', icon: Archive, area: 'admin.backup-archive' },
      { href: '/admin/sale-sync-status', label: 'Sale Sync Status', icon: Activity, area: 'admin.backup-archive' },
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
  const { can, profile } = useAuth();

  const visible = (items: NavItem[]) => items.filter((i) => can(i.area));
  // A group disappears once every page inside it is hidden, rather than leaving
  // an empty accordion the user can open onto nothing.
  const visibleGroups = adminGroups
    .map((g) => ({ ...g, items: g.items.filter((i) => can(i.area)) }))
    .filter((g) => g.items.length > 0);

  const top = visible(topItems);
  const operational = visible(operationalItems);
  const cancellations = visible(cancellationsItems);

  const initial = (profile?.name || profile?.email || '?').charAt(0).toUpperCase();

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
        {top.map((item) => (
          <NavLink key={item.href} {...item} onNavigate={onNavigate} />
        ))}
        {operational.length > 0 && <SectionLabel label="Operations" />}
        {operational.map((item) => (
          <NavLink key={item.href} {...item} onNavigate={onNavigate} />
        ))}
        {cancellations.length > 0 && (
          <SectionLabel label="Cancellations & Refunds" />
        )}
        {cancellations.map((item) => (
          <NavLink key={item.href} {...item} onNavigate={onNavigate} />
        ))}
        {visibleGroups.length > 0 && <SectionLabel label="Admin Panel" />}
        <div className="space-y-0.5">
          {visibleGroups.map((group) => (
            <NavGroupSection key={group.label} group={group} onNavigate={onNavigate} />
          ))}
        </div>
      </nav>
      <div className="border-t border-slate-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-[10px] font-bold text-white">
            {initial}
          </div>
          <span className="truncate text-xs text-slate-400">
            {profile ? `${profile.name || profile.email} · ${profile.role}` : 'v0.1.0 · Enterprise'}
          </span>
        </div>
      </div>
    </aside>
  );
}
