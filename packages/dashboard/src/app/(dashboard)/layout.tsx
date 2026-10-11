'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { useRealtimeUpdates } from '@/hooks/use-realtime-updates';
import { authStorage } from '@/lib/api';
import { RegionProvider } from '@/providers/region-provider';
import { AuthProvider, useAuth } from '@/providers/auth-provider';
import { Lock, Menu, X } from 'lucide-react';

function RealtimeUpdater() {
  useRealtimeUpdates();
  return null;
}

/**
 * Blocks a page the account is not granted. The API enforces this too — this
 * is so a pasted URL shows an explanation instead of a wall of failed requests.
 */
function AreaGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { canVisit, isLoading, profile } = useAuth();

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-sm text-slate-400">Loading…</div>
      </div>
    );
  }

  if (!canVisit(pathname)) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-md rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-50">
            <Lock className="h-6 w-6 text-amber-600" />
          </div>
          <h2 className="text-lg font-bold text-slate-900">
            You don&apos;t have access to this area
          </h2>
          <p className="mt-2 text-sm text-slate-500">
            {profile?.email ?? 'Your account'} is signed in as{' '}
            <span className="font-semibold">{profile?.role ?? 'unknown'}</span>.
            Ask an administrator to grant this area under User Management.
          </p>
          <Link
            href="/"
            className="mt-5 inline-flex rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
          >
            Back to dashboard
          </Link>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!authStorage.getToken()) {
      router.replace('/login');
    } else {
      setReady(true);
    }
  }, [router]);

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-100">
        <div className="text-sm text-slate-400">Loading…</div>
      </div>
    );
  }

  return (
    <AuthProvider>
      <RegionProvider>
        <div className="flex h-screen bg-slate-100">
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
            <main className="flex-1 overflow-y-auto p-4 sm:p-6">
              <AreaGate>{children}</AreaGate>
            </main>
          </div>
        </div>
      </RegionProvider>
    </AuthProvider>
  );
}
