// Runtime resolution of the backend API + WebSocket origin.
//
// The dashboard is a static browser bundle, so anything baked in at build time
// (NEXT_PUBLIC_API_URL) is frozen for every client. Hard-coding "localhost"
// there breaks the moment the app is opened from another machine — the browser
// resolves localhost to the *client's* box, not the server (ERR_CONNECTION_REFUSED).
//
// Instead we derive the backend host from the address the page was actually
// loaded from (window.location) at call time, so the app works from localhost,
// the server's LAN IP, or a hostname with no rebuild. An explicit
// NEXT_PUBLIC_API_URL / NEXT_PUBLIC_WS_URL still wins when set (e.g. a
// production reverse-proxy setup); leave them unset for the derive-from-host
// behaviour.

// Backend listens on this port (see docker-compose backend service).
const API_PORT = process.env.NEXT_PUBLIC_API_PORT || '3001';

/** `<protocol>//<host-the-page-was-served-from>:<API_PORT>`, or null during SSR. */
function browserBackendOrigin(): string | null {
  if (typeof window === 'undefined') return null;
  const { protocol, hostname } = window.location;
  return `${protocol}//${hostname}:${API_PORT}`;
}

/** Base URL for REST calls, e.g. `http://192.168.30.58:3001/api/v1`. */
export function getApiBase(): string {
  if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL;
  const origin = browserBackendOrigin();
  return origin ? `${origin}/api/v1` : 'http://localhost:3001/api/v1';
}

/** Origin for the Socket.IO connection, e.g. `http://192.168.30.58:3001`. */
export function getWsUrl(): string {
  if (process.env.NEXT_PUBLIC_WS_URL) return process.env.NEXT_PUBLIC_WS_URL;
  return browserBackendOrigin() ?? 'http://localhost:3001';
}
