// Default to dev server on localhost. Override via Vite env (VITE_SERVER_WS).
// In production behind nginx, set VITE_SERVER_WS to wss://<host>/ws.
const envUrl = (import.meta as ImportMeta & { env?: { VITE_SERVER_WS?: string } }).env
  ?.VITE_SERVER_WS;

function defaultUrl(): string {
  if (typeof window === 'undefined') return 'ws://localhost:8080/ws';
  if (window.location.protocol === 'https:') {
    return `wss://${window.location.host}/ws`;
  }
  return 'ws://localhost:8080/ws';
}

export const SERVER_WS = envUrl ?? defaultUrl();

// HTTP base derived from the WS URL: ws→http, wss→https, drop the /ws suffix,
// add /api. Lobby endpoints sit at /api/* alongside the WS endpoint, behind
// the same nginx proxy block in production.
function deriveHttpBase(ws: string): string {
  const httpScheme = ws.startsWith('wss://')
    ? 'https://'
    : ws.startsWith('ws://')
      ? 'http://'
      : 'http://';
  const rest = ws.replace(/^wss?:\/\//, '').replace(/\/ws$/, '');
  return `${httpScheme}${rest}/api`;
}

export const SERVER_HTTP = deriveHttpBase(SERVER_WS);
