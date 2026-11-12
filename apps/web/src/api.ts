// The REST calls the web client makes. Every non-GET sends JSON, as the REST guard requires. Every call goes to
// the daemon named in config.ts and carries the login cookie; a 401 tells the login form to show.
import type { Note } from "@sparring/protocol/notes";
import { apiUrl, crossOrigin } from "./config.ts";

export type FileName = "article" | "dump" | "brief";

/** One `note_brief` entry: the topic it covers and the writer's words it quotes. */
export interface BriefNote {
  topic: string;
  quote: string;
  question?: string;
}

export interface Snapshot {
  slug: string;
  stage: string;
  authorship: string;
  files: Record<FileName, { text: string; sha: string }>;
  commit: string;
  briefNotes?: BriefNote[];
  /** The coach's notes on the article, in the order they were left. */
  comments?: Note[];
}

/** One line of `~/writing/inbox.md`. */
export interface Idea {
  id: string;
  date: string;
  text: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.error ?? `HTTP ${status}`));
  }
}

const unauthorized = new Set<() => void>();

/** Called when a call other than the login itself answers 401. Returns the release. */
export function onUnauthorized(fn: () => void): () => void {
  unauthorized.add(fn);
  return () => unauthorized.delete(fn);
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: crossOrigin() ? "include" : "same-origin" };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(apiUrl(path), init);
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    if (res.status === 401 && path !== "/api/login") for (const fn of [...unauthorized]) fn();
    throw new ApiError(res.status, data);
  }
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  me: () => call<{ ok: true }>("GET", "/api/me"),
  login: (token: string) => call<{ ok: true }>("POST", "/api/login", { token }),
  createArticle: (slug: string, inboxId?: string) =>
    call<{ id: string; slug: string; warnings?: string[] }>(
      "POST",
      "/api/articles",
      inboxId ? { slug, inboxId } : { slug },
    ),
  startSession: (slug: string) => call<{ ok: true }>("POST", `/api/articles/${enc(slug)}/session`, {}),
  inbox: () => call<Idea[]>("GET", "/api/inbox"),
  addIdea: (text: string) => call<unknown>("POST", "/api/inbox", { text }),
  letter: (slug: string, id: string, action: "dismiss" | "restore") =>
    call<unknown>("POST", `/api/articles/${enc(slug)}/letter/${enc(id)}`, { action }),
  seen: (slug: string, ids: string[]) =>
    call<{ ok: true }>("POST", `/api/articles/${enc(slug)}/comments/seen`, { ids }),
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
