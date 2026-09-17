'use client';

import { io, Socket } from 'socket.io-client';
import { getWsUrl } from './runtime-config';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    const baseUrl = getWsUrl();
    socket = io(`${baseUrl}/events`, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
    });
  }

  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
