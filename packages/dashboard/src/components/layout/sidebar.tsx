'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { Activity, Bell, Building2, CreditCard, FileText, LayoutDashboard, Package, RefreshCw } from 'lucide-react';

const navItems = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/sync-jobs', label: 'Sync Jobs', icon: RefreshCw },
  { href: '/alerts', label: 'Alerts', icon: Bell },
  { href: '/stores', label: 'Stores', icon: Building2 },
  { href: '/payments', label: 'Payment Mappings', icon: CreditCard },
  { href: '/inventory', label: 'Inventory', icon: Package },
  { href: '/activity', label: 'Audit Log', icon: FileText },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden w-64 flex-col border-r border-gray-200 bg-white lg:flex">
      <div className="border-b p-6">
        <div className="flex items-center gap-2">
          <Activity className="h-6 w-6 text-blue-600" />
          <div>
            <h1 className="font-bold text-gray-900">Integration</h1>
            <p className="text-xs text-gray-400">Odoo → Oracle Fusion</p>
          </div>
        </div>
      </div>
      <nav className="flex-1 space-y-1 p-4">
        {navItems.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
              pathname === href ? 'bg-blue-50 font-medium text-blue-700' : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900',
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </Link>
        ))}
      </nav>
      <div className="border-t p-4 text-xs text-gray-400">v0.1.0 · Enterprise Integration</div>
    </aside>
  );
}
