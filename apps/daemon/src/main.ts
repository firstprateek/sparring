// The Sparring daemon: one Bun process on 127.0.0.1. `/ahp` passes the transport guard and upgrades to the AHP
// WebSocket, `/api/*` passes the REST guard, everything else is the web client's build.
import { join } from "node:path";
import { AhpHost } from "./ahp/host.ts";
import { AhpTransport, type WsData } from "./ahp/transport.ts";
import { Articles } from "./articles.ts";
import { same } from "./auth.ts";
import { claudeLaunch, claudePaths, ensureSettings } from "./claude.ts";
import { Coach } from "./coach.ts";
import { loadConfig, sparringHome } from "./config.ts";
import { openDb } from "./db.ts";
import { demoLaunch } from "./demo-agent.ts";
import { spendCode } from "./login-codes.ts";
import { listenMcp } from "./mcp-socket.ts";
import { restHandler } from "./rest.ts";
import { restGuard } from "./rest-guard.ts";
import { migrate } from "./schema.ts";
import { Tools } from "./tools.ts";
import { serveWebFrom } from "./web-static.ts";

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

const config = loadConfig();
const db = await openDb(join(sparringHome(), "sparring.db"));
migrate(db);
const articles = new Articles(db, config.writing_dir, {
  gitName: config.git_name,
  gitEmail: config.git_email,
  defaultProvider: config.default_provider,
});
await articles.init();

const home = sparringHome();
// The guard's settings: written on first run; a file that differs is reported here and stops every spawn.
try {
  ensureSettings(home);
} catch (e) {
  log(`claude: ${e instanceof Error ? e.message : e}`);
}
const tools = new Tools(articles);
const sock = join(home, "daemon.sock");
const coach = new Coach({
  articles,
  tools,
  launches: {
    demo: demoLaunch({ delayMs: 30, tools: (secret, tool, args) => tools.call(secret, tool, args) }),
    claude: claudeLaunch({
      home,
      ...(config.claude_oauth_token ? { token: config.claude_oauth_token } : {}),
    }),
  },
  mcp: { sock },
  runDir: claudePaths(home).runDir,
  version: "0.3.0",
  log,
});
const host = new AhpHost({
  db,
  backend: coach,
  log,
  limits: { maxConnections: 8 },
  verifyToken: (t) => same(t, config.token),
});
await coach.start();
coach.startSweep();
const mcp = await listenMcp(sock, tools, log);
// Pings every 25 s, a client silent for 90 s is closed (the host's idleCloseMs), Bun's own idle timeout is 60 s.
const transport = new AhpTransport(host, {
  token: config.token,
  hosts: config.hosts,
  keepaliveMs: 25_000,
  idleTimeoutSec: 60,
});
transport.start();

const rest = restGuard(
  { token: config.token, hosts: config.hosts, spendCode: (code) => spendCode(home, code) },
  restHandler(articles, coach),
);
const web = serveWebFrom(join(import.meta.dir, "../../web/dist"));

const server = Bun.serve<WsData>({
  hostname: "127.0.0.1",
  port: config.port,
  idleTimeout: 60,
  // Never Bun's development error page: it prints source excerpts and absolute paths.
  development: false,
  error(err) {
    log(`request failed: ${err.stack ?? err.message}`);
    return Response.json({ error: "internal error" }, { status: 500 });
  },
  fetch(req, server) {
    if (transport.matches(req)) {
      const g = transport.guard(req);
      if ("refusal" in g) return g.refusal;
      if (server.upgrade(req, { data: g.data })) return undefined;
      return new Response("websocket upgrade failed", { status: 400 });
    }
    const path = new URL(req.url).pathname;
    return path.startsWith("/api/") ? rest(req) : web(req);
  },
  websocket: transport.websocket,
});
log(`sparring on http://${server.hostname}:${server.port} · writing in ${config.writing_dir}`);

// SIGTERM (launchd) and SIGINT: commit what waits for its minute, send the meta that waits, let the coaches go,
// close the sockets, then the database; a second signal leaves at once.
let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) process.exit(1);
  stopping = true;
  log(`${signal}: stopping`);
  const hard = setTimeout(() => {
    log("shutdown took too long: leaving");
    process.exit(1);
  }, 12_000);
  try {
    server.stop();
    transport.stop();
    await articles.flush();
    await coach.shutdown();
    await mcp.close();
    host.close();
    await new Promise((r) => setTimeout(r, 50)); // let the runs the close ended write their last lines
    db.close();
  } catch (err) {
    log(`shutdown: ${err instanceof Error ? err.message : err}`);
  }
  clearTimeout(hard);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
