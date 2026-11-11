// The socket state in words: `connected`, `reconnecting… 4s` (seconds since it went down), `connecting…`.
import type { ConnectionInfo } from "./ahp/connection.ts";

let downSince: number | undefined;

/** Words for the connection, and whether it is up. Call it every second while it is down so the count moves. */
export function connectionWords(info: ConnectionInfo, now = Date.now()): string {
  if (info.status === "open") {
    downSince = undefined;
    return "connected";
  }
  if (info.status === "failed") return info.error ?? "failed";
  if (info.status === "stopped" || info.status === "idle") return "not connected";
  if (!info.everOpen && info.attempt === 0) return "connecting…";
  downSince ??= now;
  return `reconnecting… ${Math.max(0, Math.round((now - downSince) / 1000))}s`;
}
