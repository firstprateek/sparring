// The Sparring daemon: one Bun process on 127.0.0.1. Step 1 serves the REST routes and the web build.
import { join } from "node:path";
import { Articles } from "./articles.ts";
import { loadConfig, sparringHome } from "./config.ts";
import { openDb } from "./db.ts";
import { restHandler } from "./rest.ts";
import { restGuard } from "./rest-guard.ts";
import { migrate } from "./schema.ts";
import { serveWebFrom } from "./web-static.ts";

const config = loadConfig();
const db = await openDb(join(sparringHome(), "sparring.db"));
migrate(db);
const articles = new Articles(db, config.writing_dir, {
  gitName: config.git_name,
  gitEmail: config.git_email,
  defaultProvider: config.default_provider,
});
await articles.init();

const rest = restGuard({ token: config.token, hosts: config.hosts }, restHandler(articles));
const web = serveWebFrom(join(import.meta.dir, "../../web/dist"));

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: config.port,
  fetch(req) {
    const path = new URL(req.url).pathname;
    return path.startsWith("/api/") ? rest(req) : web(req);
  },
});
console.log(`sparring on http://${server.hostname}:${server.port} · writing in ${config.writing_dir}`);

const stop = async () => {
  await articles.flush();
  server.stop();
  db.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
