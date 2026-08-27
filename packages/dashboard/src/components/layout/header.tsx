'use client';

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { api, authStorage } from '@/lib/api';
import { useRegion } from '@/providers/region-provider';
import { useAuth } from '@/providers/auth-provider';
import { ChangePasswordDialog } from '@/components/layout/change-password-dialog';
import { Bell, ChevronDown, Globe, KeyRound, LogOut, RefreshCw, User, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function Header({ mobileMenuButton }: { mobileMenuButton?: React.ReactNode }) {
  const qc = useQueryClient();
  const router = useRouter();
  const { selectedRegion, setSelectedRegion } = useRegion();
  const { profile } = useAuth();
  const [passwordOpen, setPasswordOpen] = useState(false);

  // An account created (or reset) with a temporary password must change it
  // before doing anything else, so the dialog opens itself and cannot be
  // dismissed until the change succeeds.
  useEffect(() => {
    if (profile?.mustChangePassword) setPasswordOpen(true);
  }, [profile?.mustChangePassword]);

  const { data: overview } = useQuery({
    queryKey: ['dashboard-overview', selectedRegion],
    queryFn: () => api.getOverview(selectedRegion ?? undefined),
    refetchInterval: 30000,
  });

  const { data: regions } = useQuery({
    queryKey: ['vendhq-regions'],
    queryFn: api.listVendHqRegions,
    staleTime: 5 * 60 * 1000,
  });

  const handleLogout = () => {
    authStorage.clearToken();
    router.replace('/login');
  };

  return (
    <header className="relative flex h-14 items-center justify-between border-b border-slate-200 bg-white px-4 sm:px-6">
      {/* Gradient top accent line */}
      <div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500" />

      <div className="flex items-center gap-3">
        {mobileMenuButton}
        {overview && (
          <div className="hidden items-center gap-2 sm:flex">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Sync {overview.syncRate}%
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700 ring-1 ring-blue-200">
              <Zap className="h-3 w-3" />
              {overview.activeJobs} active
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        {/* Country / Region switcher */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 border-slate-200 text-slate-600 hover:border-indigo-300 hover:text-indigo-600"
            >
              <Globe className="h-3.5 w-3.5" />
              <span className="hidden sm:inline max-w-[100px] truncate">
                {selectedRegion ?? 'All Regions'}
              </span>
              <ChevronDown className="h-3 w-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel>Location</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                setSelectedRegion(null);
                void qc.invalidateQueries({ queryKey: ['dashboard-overview', selectedRegion] });
              }}
              className={!selectedRegion ? 'bg-indigo-50 text-indigo-700 font-semibold' : ''}
            >
              All Regions
            </DropdownMenuItem>
            {regions?.map((r) => (
              <DropdownMenuItem
                key={r.id}
                onClick={() => {
                  setSelectedRegion(r.region);
                  void qc.invalidateQueries({ queryKey: ['dashboard-overview', r.region] });
                }}
                className={
                  selectedRegion === r.region
                    ? 'bg-indigo-50 text-indigo-700 font-semibold'
                    : ''
                }
              >
                {r.region}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {(overview?.unresolvedAlerts ?? 0) > 0 && (
          <div className="relative">
            <button className="flex h-8 w-8 items-center justify-center rounded-full bg-red-50 text-red-600 ring-1 ring-red-200 transition-colors hover:bg-red-100">
              <Bell className="h-4 w-4" />
            </button>
            <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[9px] font-bold text-white">
              {overview?.unresolvedAlerts}
            </span>
          </div>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => qc.invalidateQueries()}
          className="h-8 gap-1.5 border-slate-200 text-slate-600 hover:border-indigo-300 hover:text-indigo-600"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Refresh</span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 border-slate-200 text-slate-600 hover:border-indigo-300 hover:text-indigo-600"
            >
              <User className="h-3.5 w-3.5" />
              <span className="hidden max-w-[140px] truncate sm:inline">
                {profile?.name || profile?.email || 'Account'}
              </span>
              <ChevronDown className="h-3 w-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>
              <div className="truncate text-sm font-semibold text-slate-800">
                {profile?.name || profile?.email || 'Signed in'}
              </div>
              <div className="truncate text-xs font-normal text-slate-500">
                {profile?.email}
                {profile?.role ? ` · ${profile.role}` : ''}
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setPasswordOpen(true)}>
              <KeyRound className="mr-2 h-3.5 w-3.5" />
              Change password
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={handleLogout}
              className="text-red-600 focus:text-red-600"
            >
              <LogOut className="mr-2 h-3.5 w-3.5" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <ChangePasswordDialog
        open={passwordOpen}
        onOpenChange={setPasswordOpen}
        forced={profile?.mustChangePassword ?? false}
      />
    </header>
  );
}
