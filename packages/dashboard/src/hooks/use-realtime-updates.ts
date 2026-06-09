'use client';

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getSocket } from '@/lib/websocket';

/**
 * Connects to the backend WebSocket and invalidates React Query caches when
 * real-time events arrive.  Import this hook once at the dashboard layout level.
 */
export function useRealtimeUpdates() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const socket = getSocket();

    const handleOrderStatus = () => {
      void queryClient.invalidateQueries({ queryKey: ['sync-jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard-overview'] });
      void queryClient.invalidateQueries({ queryKey: ['failed-transactions'] });
    };

    const handleSyncJobUpdate = () => {
      void queryClient.invalidateQueries({ queryKey: ['sync-jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard-overview'] });
      void queryClient.invalidateQueries({ queryKey: ['queue-stats'] });
    };

    const handleAlert = () => {
      void queryClient.invalidateQueries({ queryKey: ['alerts'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard-overview'] });
    };

    const handleHealthUpdate = () => {
      void queryClient.invalidateQueries({ queryKey: ['health'] });
    };

    socket.on('orderStatus', handleOrderStatus);
    socket.on('syncJobUpdate', handleSyncJobUpdate);
    socket.on('alert', handleAlert);
    socket.on('healthUpdate', handleHealthUpdate);

    return () => {
      socket.off('orderStatus', handleOrderStatus);
      socket.off('syncJobUpdate', handleSyncJobUpdate);
      socket.off('alert', handleAlert);
      socket.off('healthUpdate', handleHealthUpdate);
    };
  }, [queryClient]);
}
