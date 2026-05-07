// Build-time + runtime config. Vite injects import.meta.env.* at build time;
// we also fall back to window-relative defaults so a deployed bundle Just Works.

const wsScheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
const apiScheme = window.location.protocol === 'https:' ? 'https' : 'http';

const overrideHttp = (import.meta.env.VITE_SERVER_HTTP as string | undefined)?.replace(/\/$/, '');
const overrideWs = (import.meta.env.VITE_SERVER_WS as string | undefined)?.replace(/\/$/, '');

// In dev (Vite on :5173), reach the server directly on :8080.
// In production (served by nginx on the same origin), use same-origin so /api
// and /ws are proxied. nginx config handles the upgrade for /ws.
const isDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const defaultHttp = isDev
  ? `${apiScheme}://${window.location.hostname}:8080`
  : window.location.origin;
const defaultWs = isDev
  ? `${wsScheme}://${window.location.hostname}:8080`
  : `${wsScheme}://${window.location.host}`;

export const SERVER_HTTP = overrideHttp ?? defaultHttp;
export const SERVER_WS = overrideWs ?? defaultWs;

// Tick offset: client predicts this many ticks ahead of the latest known server tick.
// Higher value = more buffer for latency, but more rollback when server corrects.
export const TICK_LEAD = 2;
