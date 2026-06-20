'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

const REGION_KEY = 'integration_hub_region';

interface RegionContextValue {
  /** Currently selected region, or null for "All Regions" */
  selectedRegion: string | null;
  setSelectedRegion: (region: string | null) => void;
}

const RegionContext = createContext<RegionContextValue>({
  selectedRegion: null,
  setSelectedRegion: () => undefined,
});

export function RegionProvider({ children }: { children: ReactNode }) {
  const [selectedRegion, setSelectedRegionState] = useState<string | null>(
    null,
  );

  // Hydrate from localStorage after mount
  useEffect(() => {
    const stored =
      typeof window !== 'undefined' ? localStorage.getItem(REGION_KEY) : null;
    if (stored) setSelectedRegionState(stored);
  }, []);

  const setSelectedRegion = (region: string | null) => {
    setSelectedRegionState(region);
    if (typeof window !== 'undefined') {
      if (region) {
        localStorage.setItem(REGION_KEY, region);
      } else {
        localStorage.removeItem(REGION_KEY);
      }
    }
  };

  return (
    <RegionContext.Provider value={{ selectedRegion, setSelectedRegion }}>
      {children}
    </RegionContext.Provider>
  );
}

/** Returns the currently selected region (null = All Regions). */
export function useRegion() {
  return useContext(RegionContext);
}
