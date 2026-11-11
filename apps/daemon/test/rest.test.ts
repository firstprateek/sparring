import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Articles, sha256 } from "../src/articles.ts";
import { type Db, openDb } from "../src/db.ts";
import { restHandler } from "../src/rest.ts";
import { migrate } from "../src/schema.ts";

let dir: string;
let db: Db;
let articles: Articles;
let api: (req: Request) => Promise<Response>;

const call = (method: string, path: string, body?: unknown) =>
  api(
    new Request(`http://127.0.0.1:7421${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? null : JSON.stringify(body),
    }),
  );
const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sparring-writing-"));
  db = await openDb(":memory:");
  migrate(db);
  articles = new Articles(db, dir, {
    gitName: "Test",
    gitEmail: "test@localhost",
    defaultProvider: "demo",
    commitEveryMs: 60_000,
  });
  await articles.init();
  api = restHandler(articles);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("articles", () => {
  it("creates the folder, the files, a commit and the row", async () => {
    const res = await call("POST", "/api/articles", { slug: "closed-laptop" });
    expect(res.status).toBe(201);
    expect(git("log", "--format=%s", "-1")).toBe("new article closed-laptop");
    expect(git("ls-files", "closed-laptop").split("\n").sort()).toEqual([
      "closed-laptop/article.md",
      "closed-laptop/brief.md",
      "closed-laptop/dump.md",
      "closed-laptop/meta.json",
    ]);
    expect(git("config", "--local", "user.name")).toBe("Test");
    expect((await call("POST", "/api/articles", { slug: "closed-laptop" })).status).toBe(409);
  });

  it("refuses a bad slug", async () => {
    for (const slug of ["Closed", "a--b", "index", "../x", "x".repeat(65)]) {
      const res = await call("POST", "/api/articles", { slug });
      expect(res.status).toBe(400);
    }
    expect((await call("POST", "/api/articles", { slug: "ok", provider: "gpt" })).status).toBe(400);
  });

  it("serves a snapshot", async () => {
    await call("POST", "/api/articles", { slug: "a" });
    const snap = (await (await call("GET", "/api/articles/a")).json()) as {
      files: Record<string, { text: string; sha: string }>;
      commit: string;
    };
    expect(snap.files.article).toEqual({ text: "", sha: sha256("") });
    expect(snap.commit).toBe(git("rev-parse", "HEAD"));
    expect((await call("GET", "/api/articles/nope")).status).toBe(404);
  });
});

describe("saving", () => {
  beforeEach(async () => {
    await call("POST", "/api/articles", { slug: "a" });
  });

  it("saves and commits on Cmd+S", async () => {
    const text = "One.\n\nTwo.\n";
    const res = await call("PUT", "/api/articles/a/article", { text, base_sha: sha256(""), commit: true });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { sha: string; commit: string };
    expect(out.sha).toBe(sha256(text));
    expect(out.commit).toBe(git("rev-parse", "HEAD"));
    expect(git("show", "HEAD:a/article.md")).toBe("One.\n\nTwo.");
    expect(readFileSync(join(dir, "a/article.md"), "utf8")).toBe(text);
  });

  it("answers 409 with the disk text when base_sha is stale, and writes nothing", async () => {
    writeFileSync(join(dir, "a/article.md"), "edited in vim\n");
    const res = await call("PUT", "/api/articles/a/article", { text: "mine\n", base_sha: sha256("") });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ disk_sha: sha256("edited in vim\n"), disk_text: "edited in vim\n" });
    expect(readFileSync(join(dir, "a/article.md"), "utf8")).toBe("edited in vim\n");
    const keep = await call("PUT", "/api/articles/a/article", {
      text: "mine\n",
      base_sha: sha256("edited in vim\n"),
    });
    expect(keep.status).toBe(200);
  });

  it("leaves an autosave inside the minute for later and commits the next one after it", async () => {
    const first = (await (
      await call("PUT", "/api/articles/a/dump", { text: "a dump\n", base_sha: sha256("") })
    ).json()) as { commit: string | null };
    expect(first.commit).toBeNull();
    expect(git("status", "--porcelain")).toBe("M a/dump.md");
    expect(await articles.commit("a", "autosave")).toMatch(/^[0-9a-f]{40}$/);
    expect(git("status", "--porcelain")).toBe("");
    expect(await articles.commit("a", "autosave")).toBeNull();
  });

  it("refuses an unknown file and a body that is not JSON", async () => {
    expect((await call("PUT", "/api/articles/a/notes", { text: "", base_sha: "" })).status).toBe(404);
    const res = await api(
      new Request("http://127.0.0.1:7421/api/articles/a/article", { method: "PUT", body: "text" }),
    );
    expect(res.status).toBe(415);
  });

  it("keeps the local text at the stash ref on take disk", async () => {
    const res = await call("POST", "/api/articles/a/stash", { file: "article", text: "my lost words\n" });
    expect(res.status).toBe(200);
    expect(git("show", "refs/sparring/stash/a:a/article.md")).toBe("my lost words");
    expect(git("status", "--porcelain")).toBe("");
  });
});
