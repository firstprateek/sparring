// The /api/* routes: the inbox, create an article (with its AHP session and chat, from an idea or not), read its
// snapshot, save its files, stash on `take disk`, act on a letter line, mark notes seen, check pasted text
// against the coach's words (`pastes`). The REST guard (login, Host, Origin) wraps
// this in main.ts. `authorship` is the one call that flips an article between coached and drafted; the coach
// does it, since the draft turn is its to start. `shelf` is the page from before the draft.
import type { CorpusEntry } from "@sparring/protocol/overlap";
import { type Articles, FILES, type FileName, HttpError, sessionUri } from "./articles.ts";

/** What the routes need from the coach. */
export interface Flipper {
  flip(slug: string, to: "coached" | "drafted"): Promise<Record<string, unknown>>;
  /** Everything the coach said in an article, and the writer's own words to hold against it. */
  corpus?(slug: string): Promise<{ entries: CorpusEntry[]; own: string[] }>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

async function body(req: Request): Promise<Record<string, unknown>> {
  if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) {
    throw new HttpError(415, { error: "send application/json" });
  }
  try {
    const b = await req.json();
    if (b && typeof b === "object" && !Array.isArray(b)) return b as Record<string, unknown>;
  } catch {}
  throw new HttpError(400, { error: "body is not a JSON object" });
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string") throw new HttpError(400, { error: `${name} must be a string` });
  return v;
};

const fileOf = (name: string): FileName => {
  if (!(FILES as readonly string[]).includes(name)) throw new HttpError(404, { error: "no such file" });
  return name as FileName;
};

export function restHandler(articles: Articles, coach?: Flipper) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); // ["api", ...]
    const m = req.method;
    try {
      if (parts[1] === "inbox" && parts.length === 2) {
        if (m === "GET") return json(await articles.inbox());
        if (m === "POST") {
          const b = await body(req);
          return json(await articles.addIdea(str(b.text, "text")), 201);
        }
      }
      if (parts[1] === "articles") {
        if (parts.length === 2 && m === "POST") {
          const b = await body(req);
          const provider = b.provider === undefined ? undefined : str(b.provider, "provider");
          if (provider !== undefined && provider !== "claude" && provider !== "demo") {
            throw new HttpError(400, { error: "provider is claude or demo" });
          }
          const inboxId =
            b.inboxId === undefined || b.inboxId === null ? undefined : str(b.inboxId, "inboxId");
          // An inbox idea becomes the dump: looked up first, taken out of inbox.md once the article exists.
          const idea = inboxId === undefined ? undefined : await articles.idea(inboxId);
          if (inboxId !== undefined && !idea) throw new HttpError(404, { error: "no such idea in inbox.md" });
          const row = await articles.create(
            str(b.slug, "slug"),
            provider,
            undefined,
            idea ? { dump: `${idea.text}\n` } : {},
          );
          const warnings: string[] = [];
          if (idea) {
            await articles.takeIdea(idea.id).catch((e: unknown) => {
              warnings.push(`the idea is still in inbox.md · ${e instanceof Error ? e.message : e}`);
            });
          }
          const sessionError = articles.sessionErrors.get(row.slug);
          if (sessionError) warnings.push(`the coach session did not start · ${sessionError}`);
          return json(
            {
              id: row.id,
              slug: row.slug,
              commit: articles.row(row.slug).last_commit,
              session: sessionUri(row.id),
              chat: articles.row(row.slug).chat,
              ...(warnings.length > 0 ? { warnings } : {}),
            },
            201,
          );
        }
        const slug = parts[2];
        if (slug !== undefined) {
          if (parts.length === 3 && m === "GET") return json(await articles.snapshot(slug));
          if (parts.length === 4 && m === "PUT" && parts[3] !== "stash") {
            const file = fileOf(parts[3] as string);
            const b = await body(req);
            const res = await articles.save(
              slug,
              file,
              str(b.text, "text"),
              str(b.base_sha, "base_sha"),
              b.commit === true,
            );
            return json(res);
          }
          if (parts.length === 5 && parts[3] === "letter" && m === "POST") {
            const b = await body(req);
            const id = parts[4] as string;
            const line = articles.letterLine(slug, id);
            if (!line) throw new HttpError(404, { error: "no such letter line" });
            if (b.action === "dismiss") {
              articles.dropLetter(slug, id);
              return json({ ok: true });
            }
            if (b.action === "restore") {
              if (line.kind !== "quarantine")
                throw new HttpError(409, { error: "only a quarantine line restores" });
              const res = await articles.restoreQuarantine(slug);
              articles.dropLetter(slug, id);
              return json(res);
            }
            throw new HttpError(400, { error: "action is dismiss or restore" });
          }
          if (parts.length === 5 && parts[3] === "comments" && parts[4] === "seen" && m === "POST") {
            const b = await body(req);
            const ids = Array.isArray(b.ids) ? b.ids.filter((x): x is string => typeof x === "string") : null;
            if (!ids) throw new HttpError(400, { error: "ids must be a list of note ids" });
            articles.markSeen(slug, ids.slice(0, 200));
            return json({ ok: true });
          }
          if (parts.length === 4 && parts[3] === "session" && m === "POST") {
            articles.row(slug);
            try {
              await articles.ensureSession(slug);
              articles.sessionErrors.delete(slug);
            } catch (e) {
              throw new HttpError(500, {
                error: `the coach session did not start · ${e instanceof Error ? e.message : e}`,
              });
            }
            return json({ ok: true });
          }
          if (parts.length === 4 && parts[3] === "authorship" && m === "POST") {
            const b = await body(req);
            articles.row(slug);
            if (b.to !== "coached" && b.to !== "drafted")
              throw new HttpError(400, { error: "to is coached or drafted" });
            if (b.confirm !== true) throw new HttpError(400, { error: "confirm must be true" });
            if (!coach) throw new HttpError(503, { error: "no coach is attached" });
            return json(await coach.flip(slug, b.to));
          }
          if (parts.length === 4 && parts[3] === "pastes" && m === "POST") {
            const b = await body(req);
            const text = str(b.text, "text");
            const row = articles.row(slug);
            // With no coach attached there is no chat: the notes and the brief questions are the corpus.
            const corpus = coach?.corpus
              ? await coach.corpus(slug)
              : { entries: articles.coachWritten(row), own: [await articles.read(slug, "dump")] };
            const res = articles.recordPaste(slug, text, corpus);
            return json({
              spans: res.spans.map(({ text, words, source }) => ({ text, words, source })),
              pastes: res.pastes.map(({ text, source }) => ({ text, source })),
            });
          }
          if (parts.length === 4 && parts[3] === "shelf" && m === "GET")
            return json(await articles.shelf(slug));
          if (parts.length === 4 && parts[3] === "stash" && m === "POST") {
            const b = await body(req);
            const commit = await articles.stash(slug, fileOf(str(b.file, "file")), str(b.text, "text"));
            return json({ ref: `refs/sparring/stash/${slug}`, commit });
          }
        }
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      if (e instanceof HttpError) return json(e.body, e.status);
      console.error(e);
      return json({ error: "internal error" }, 500);
    }
  };
}
