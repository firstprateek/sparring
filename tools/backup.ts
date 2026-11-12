// The backup, from a terminal on the daemon's machine.
//
//   pnpm backup           back up now and print the result
//   pnpm backup status    print the last backup's line, without running one
//
// It asks the running daemon (`POST /api/backup`), so the run goes through the daemon's own git queue. When no
// daemon answers it runs the same backup itself, on the database and the writing repo directly. The line it
// prints is the one the Articles screen shows. It exits 1 when the line is a red one.
import { join } from "node:path";
import { Backup, readBackupState } from "../apps/daemon/src/backup.ts";
import { loadConfig, sparringHome } from "../apps/daemon/src/config.ts";
import { openDb } from "../apps/daemon/src/db.ts";
import { GitQueue } from "../apps/daemon/src/git.ts";
import { type BackupState, backupLine } from "../packages/protocol/src/backup.ts";

/** The last backup's line with no daemon asked: for `pnpm service status`. */
export function backupStatusLine(home = sparringHome(), now = Date.now()): string {
  return backupLine(readBackupState(home), now).text;
}

/** Asks the daemon. Null when nothing answers on its port. */
async function ask(method: "GET" | "POST"): Promise<BackupState | null> {
  const { port, token } = loadConfig();
  const at = `127.0.0.1:${port}`;
  let res: Response;
  try {
    res = await fetch(`http://${at}/api/backup`, {
      method,
      headers: {
        host: at,
        origin: `http://${at}`,
        authorization: `Bearer ${token}`,
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: "{}" } : {}),
      signal: AbortSignal.timeout(method === "POST" ? 60_000 : 5000),
    });
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") throw new Error("the daemon did not answer in time");
    return null;
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`the daemon answered ${res.status} · ${data.error ?? "no reason given"}`);
  return data as unknown as BackupState;
}

/** The same backup with no daemon: its own connection to the database and its own queue on the writing repo. */
async function direct(): Promise<BackupState> {
  const home = sparringHome();
  const config = loadConfig(home);
  const db = await openDb(join(home, "sparring.db"));
  try {
    return await new Backup({ db, git: new GitQueue(config.writing_dir), home }).run();
  } finally {
    db.close();
  }
}

function print(s: BackupState, via: string): never {
  const line = backupLine(s, Date.now());
  console.log(line.text);
  const parts = [via, `remote ${s.remote ?? "not set"}`];
  if (s.commit) parts.push(`main ${s.commit.slice(0, 7)}`);
  if (s.nextAt) parts.push(`next ${new Date(s.nextAt).toLocaleString()}`);
  console.log(parts.join(" · "));
  process.exit(line.bad ? 1 : 0);
}

if (import.meta.main) {
  const cmd = process.argv[2];
  try {
    if (cmd === "status") {
      const s = await ask("GET");
      print(
        s ?? readBackupState(sparringHome()),
        s ? "from the daemon" : "no daemon answers · from backup.json",
      );
    } else if (cmd === undefined) {
      let s = await ask("POST");
      const via = s ? "run by the daemon" : "no daemon answers · run here";
      s ??= await direct();
      // A slow push is answered as `running`: ask until it is over.
      while (s.running) {
        await Bun.sleep(2000);
        s = (await ask("GET")) ?? readBackupState(sparringHome());
      }
      print(s, via);
    } else {
      console.error("usage: pnpm backup | pnpm backup status");
      process.exit(2);
    }
  } catch (e) {
    console.error(`backup failed · ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
