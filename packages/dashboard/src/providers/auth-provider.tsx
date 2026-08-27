'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type AuthProfile } from '@/lib/api';
import { areaForPath } from '@/lib/areas';

interface AuthContextValue {
  profile: AuthProfile | null;
  isLoading: boolean;
  /** True when the account may see this area. */
  can: (area: string | null | undefined) => boolean;
  /** True when the account may open this dashboard path. */
  canVisit: (pathname: string) => boolean;
  isAdmin: boolean;
}

const AuthContext = createContext<AuthContextValue>({
  profile: null,
  isLoading: true,
  can: () => false,
  canVisit: () => false,
  isAdmin: false,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  // /auth/me is re-read rather than decoded from the token so that a
  // permission change by an admin takes effect on the next refetch instead of
  // waiting for the user's 8-hour token to expire.
  const { data, isLoading } = useQuery({
    queryKey: ['auth-me'],
    queryFn: () => api.getMe(),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });

  const value = useMemo<AuthContextValue>(() => {
    const profile = data ?? null;
    const granted = new Set(profile?.areas ?? []);

    const can = (area: string | null | undefined) => {
      // A page with no catalogue entry is not restricted — a new screen should
      // not become invisible just because nobody added it to the catalogue.
      if (!area) return true;
      // Until the profile arrives we allow, and the layout holds rendering on
      // isLoading; denying here would flash "access denied" on every reload.
      if (!profile) return true;
      return granted.has(area);
    };

    return {
      profile,
      isLoading,
      can,
      canVisit: (pathname: string) => can(areaForPath(pathname)),
      isAdmin: profile?.role === 'ADMIN',
    };
  }, [data, isLoading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
