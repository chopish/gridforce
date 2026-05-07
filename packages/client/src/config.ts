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
