'use client';

import { useState } from 'react';
import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { useRealtimeUpdates } from '@/hooks/use-realtime-updates';
import { Menu, X } from 'lucide-react';

function RealtimeUpdater() {
  useRealtimeUpdates();
  return null;
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <div className="flex h-screen bg-slate-50">
      <RealtimeUpdater />

      {/* Desktop sidebar */}
      <Sidebar />

      {/* Mobile sidebar overlay */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setMobileNavOpen(false)}
          />
          <div className="relative z-50 flex h-full w-64 flex-col bg-slate-900 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 px-4 py-4">
              <span className="text-sm font-bold text-white">Navigation</span>
              <button
                onClick={() => setMobileNavOpen(false)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <Sidebar mobile onNavigate={() => setMobileNavOpen(false)} />
          </div>
        </div>
      )}

      <div className="flex flex-1 flex-col overflow-hidden">
        <Header
          mobileMenuButton={
            <button
              onClick={() => setMobileNavOpen(true)}
              className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700 lg:hidden"
              aria-label="Open navigation"
            >
              <Menu className="h-5 w-5" />
            </button>
          }
        />
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
