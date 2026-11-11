// The /api/* routes: create an article (with its AHP session and chat), read its snapshot, save its files, stash
// on `take disk`. The REST guard (login, Host, Origin) wraps this in main.ts.
import { type Articles, FILES, type FileName, HttpError, sessionUri } from "./articles.ts";

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

export function restHandler(articles: Articles) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); // ["api", ...]
    const m = req.method;
    try {
      if (parts[1] === "articles") {
        if (parts.length === 2 && m === "POST") {
          const b = await body(req);
          const provider = b.provider === undefined ? undefined : str(b.provider, "provider");
          if (provider !== undefined && provider !== "claude" && provider !== "demo") {
            throw new HttpError(400, { error: "provider is claude or demo" });
          }
          const row = await articles.create(str(b.slug, "slug"), provider);
          return json(
            {
              id: row.id,
              slug: row.slug,
              commit: row.last_commit,
              session: sessionUri(row.id),
              chat: row.chat,
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
