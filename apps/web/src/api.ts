// The REST calls the web client makes. Every non-GET sends JSON, as the REST guard requires.

export type FileName = "article" | "dump" | "brief";

export interface Snapshot {
  slug: string;
  stage: string;
  authorship: string;
  files: Record<FileName, { text: string; sha: string }>;
  commit: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.error ?? `HTTP ${status}`));
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin" };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  createArticle: (slug: string) => call<{ id: string; slug: string }>("POST", "/api/articles", { slug }),
  snapshot: (slug: string) => call<Snapshot>("GET", `/api/articles/${enc(slug)}`),
  save: (slug: string, file: FileName, text: string, base_sha: string, commit: boolean) =>
    call<{ sha: string; commit: string | null }>("PUT", `/api/articles/${enc(slug)}/${file}`, {
      text,
      base_sha,
      commit,
    }),
  stash: (slug: string, file: FileName, text: string) =>
    call<{ commit: string }>("POST", `/api/articles/${enc(slug)}/stash`, { file, text }),
};

/** SHA-256 hex of the UTF-8 bytes, the same hash the daemon uses for base_sha. */
export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
