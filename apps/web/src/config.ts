// Where the daemon is. The web client is served by the daemon, so by default that is the page's own origin; a
// build can name another one with VITE_DAEMON_URL, and a browser (or a future Tauri shell pointed at the Mac
// mini) can keep one in localStorage as `sparring-daemon`. Every REST call and the WebSocket go through here.

const STORAGE_KEY = "sparring-daemon";

function stored(): string | undefined {
  try {
    return localStorage.getItem(STORAGE_KEY)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function pageOrigin(): string {
  return typeof location === "undefined" ? "http://127.0.0.1:7421" : location.origin;
}

/** The daemon's base URL, with no trailing slash: `https://sparring.tailnet.ts.net`. */
export function daemonBase(): string {
  const fromEnv = (import.meta.env.VITE_DAEMON_URL as string | undefined)?.trim();
  const raw = fromEnv || stored() || pageOrigin();
  try {
    return new URL(raw).origin;
  } catch {
    return pageOrigin();
  }
}

/** True when the daemon is not the page's own origin, so REST calls must send credentials cross-origin. */
export function crossOrigin(): boolean {
  return daemonBase() !== pageOrigin();
}

/** A REST path on the daemon: `/api/me` becomes `<base>/api/me`. */
export function apiUrl(path: string): string {
  return `${daemonBase()}${path}`;
}

/** The AHP WebSocket: ws or wss to match the daemon's scheme. */
export function ahpUrl(): string {
  const u = new URL(daemonBase());
  return `${u.protocol === "https:" ? "wss" : "ws"}://${u.host}/ahp`;
}

/** The daemon's host name, as the Articles foot shows it. */
export function daemonHost(): string {
  return new URL(daemonBase()).hostname;
}
