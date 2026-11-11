// The coach rig: a writing repo in a temp folder, an in-memory database, the host, the coach with the scripted
// coach (or any launch), and the REST handler. Shared by the coach tests.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect } from "vitest";
import type { Launch } from "../src/ahp/agent-process.ts";
import { AhpHost } from "../src/ahp/host.ts";
import { Articles } from "../src/articles.ts";
import { Coach } from "../src/coach.ts";
import { type Db, openDb } from "../src/db.ts";
import { demoLaunch } from "../src/demo-agent.ts";
import { restHandler } from "../src/rest.ts";
import { migrate } from "../src/schema.ts";
import { Tools } from "../src/tools.ts";
import { type Any, type TestClient, turnStarted } from "./ahp/support.ts";

export const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

export async function rig(
  o: {
    launch?: Launch;
    claude?: Launch;
    db?: Db;
    dir?: string;
    turnLimitMs?: number;
    idleMs?: number;
    runDir?: string;
  } = {},
) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "sparring-coach-"));
  if (!o.dir) dirs.push(dir);
  const db = o.db ?? (await openDb(":memory:"));
  migrate(db);
  const articles = new Articles(db, dir, {
    gitName: "Test",
    gitEmail: "test@localhost",
    defaultProvider: "demo",
    commitEveryMs: 60_000,
  });
  await articles.init();
  let launches = 0;
  const tools = new Tools(articles);
  const demo = o.launch ?? demoLaunch({ delayMs: 0, tools: (s, t, a) => tools.call(s, t, a) });
  const counted =
    (l: Launch): Launch =>
    (r) => {
      launches++;
      return l(r);
    };
  const coach = new Coach({
    articles,
    tools,
    launches: { demo: counted(demo), ...(o.claude ? { claude: counted(o.claude) } : {}) },
    mcp: { sock: "/tmp/sparring-test.sock" },
    metaDebounceMs: 20,
    ...(o.turnLimitMs ? { turnLimitMs: o.turnLimitMs } : {}),
    ...(o.idleMs !== undefined ? { idleMs: o.idleMs } : {}),
    ...(o.runDir ? { runDir: o.runDir } : {}),
  });
  const host = new AhpHost({ db, backend: coach, limits: { snapshotMinBytes: 0, snapshotMinMs: 0 } });
  await coach.start();
  const api = restHandler(articles);
  const call = async (method: string, path: string, body?: unknown): Promise<Any> => {
    const res = await api(
      new Request(`http://127.0.0.1:7421${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? null : JSON.stringify(body),
      }),
    );
    return { status: res.status, body: await res.json() };
  };
  /** POST /api/articles; answers the article's session and chat. */
  const article = async (slug: string, provider?: string) => {
    const res = await call("POST", "/api/articles", { slug, ...(provider ? { provider } : {}) });
    expect(res.status).toBe(201);
    return res.body as { id: string; slug: string; commit: string; session: string; chat: string };
  };
  /** Types a line into the article's chat as the owner and waits for the turn to end. */
  const say = async (c: TestClient, chat: string, text: string, turnId?: string) => {
    c.dispatch(chat, turnStarted(text, turnId));
    await host.idle();
  };
  return { dir, db, articles, tools, coach, host, call, article, say, launches: () => launches };
}

export const meta = (host: AhpHost, session: string): Any =>
  (host.sessionState(session)?._meta as Any)?.sparring;
