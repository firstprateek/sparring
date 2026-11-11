// The Sparring MCP tools, as the daemon serves them (design section 3, "MCP surface"). The proxy in packages/mcp
// forwards each call over daemon.sock with the session's secret; the scripted coach calls `call` directly with
// its own. The secret names the article, so no tool takes a slug. Every check and every write happens here.
//
// Step 3 serves read_article, read_source and note_brief. comment and resolve_comment answer that they are not in
// this step. write_draft is refused without a live grant, and the refusal is a letter line.

import { randomBytes } from "node:crypto";
import { TOPICS } from "@sparring/protocol/commands";
import type { ArticleRow, Articles } from "./articles.ts";

type Json = Record<string, unknown>;
type Topic = (typeof TOPICS)[number];

export type ToolReply = { ok: true; text: string } | { ok: false; error: string };

export const WRITE_REFUSED = "write refused · the coach tried to edit article.md · logged";
export const BRIEF_MAX = 12;
export const QUESTION_MAX = 200;

/** What the tools need from the coach. Set by the coach when it attaches. */
export interface ToolHooks {
  /** Every message the owner sent in the article's chat, the running turn's included. */
  ownerMessages(articleId: string): string[];
  /** A write the coach was refused: the letter line, the host line, the turn's violation. */
  refused(articleId: string, text: string): void;
  /** Something `_meta.sparring` shows changed: send it now. */
  changed(articleId: string): void;
  /** Is a single-use draft grant live? (Step 6; never in step 3.) */
  grantLive?(articleId: string): boolean;
}

const ok = (text: string): ToolReply => ({ ok: true, text });
const no = (error: string): ToolReply => ({ ok: false, error });
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export class Tools {
  private readonly secrets = new Map<string, { articleId: string; hello: boolean }>();
  hooks: ToolHooks = {
    ownerMessages: () => [],
    refused: () => {},
    changed: () => {},
  };

  constructor(private readonly articles: Articles) {}

  /** A new secret for one ACP session of an article. */
  issue(articleId: string): string {
    const secret = randomBytes(24).toString("hex");
    this.secrets.set(secret, { articleId, hello: false });
    return secret;
  }

  revoke(secret: string): void {
    this.secrets.delete(secret);
  }

  /** The article a secret belongs to, or undefined for a secret the daemon never gave out (or took back). */
  articleOf(secret: unknown): string | undefined {
    return typeof secret === "string" ? this.secrets.get(secret)?.articleId : undefined;
  }

  /** The proxy's `{secret, hello: true}` line. False for a wrong secret. */
  hello(secret: unknown): boolean {
    const s = typeof secret === "string" ? this.secrets.get(secret) : undefined;
    if (!s) return false;
    s.hello = true;
    return true;
  }

  /** Has the proxy of this secret said hello? */
  greeted(secret: string): boolean {
    return this.secrets.get(secret)?.hello === true;
  }

  /** One tool call. Never throws: a failure is an `{ok: false}` reply the coach reads. */
  async call(secret: unknown, tool: unknown, args: unknown): Promise<ToolReply> {
    const articleId = this.articleOf(secret);
    if (!articleId) return no("unknown session secret");
    const row = this.articles.byId(articleId);
    if (!row) return no("the article is gone");
    const a = isObj(args) ? args : {};
    try {
      switch (tool) {
        case "read_article":
          return await this.readArticle(row);
        case "read_source":
          return await this.readSource(row, a);
        case "note_brief":
          return await this.noteBrief(row, a);
        case "comment":
        case "resolve_comment":
          return no(`${tool} is not in this step · notes arrive in step 4`);
        case "write_draft":
          return this.writeDraft(row);
        default:
          return no(`no tool ${String(tool).slice(0, 40)}`);
      }
    } catch (e) {
      return no(`the daemon failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async readArticle(row: ArticleRow): Promise<ToolReply> {
    const text = await this.articles.read(row.slug, "article");
    if (text.trim() === "") return ok("(article.md is empty)");
    const lines = text.replace(/\n$/, "").split("\n");
    const width = String(lines.length).length;
    return ok(lines.map((l, i) => `${String(i + 1).padStart(width)}  ${l}`).join("\n"));
  }

  private async readSource(row: ArticleRow, a: Json): Promise<ToolReply> {
    const name = typeof a.name === "string" ? a.name : "";
    let text: string | undefined;
    if (name === "dump" || name === "brief") text = await this.articles.read(row.slug, name);
    else if (name === "style") text = await this.articles.style();
    else if (name.startsWith("pass:")) {
      text = await this.articles.pass(name.slice(5));
      if (text === undefined) return no(`no pass ${name.slice(5, 45)}`);
    } else return no("name is dump, brief, style or pass:<id>");
    return ok(text.trim() === "" ? `(${name === "style" ? "STYLE" : name}.md is empty)` : text);
  }

  /** note_brief({topic, quote, question?}), validated exactly as the design says. */
  private async noteBrief(row: ArticleRow, a: Json): Promise<ToolReply> {
    const topic = a.topic;
    if (typeof topic !== "string" || !(TOPICS as readonly string[]).includes(topic))
      return no(`topic is one of ${TOPICS.join(", ")}`);
    const quote = typeof a.quote === "string" ? a.quote : "";
    if (quote.trim() === "") return no("quote is required: the writer's exact words");
    let question: string | undefined;
    if (a.question !== undefined && a.question !== null && a.question !== "") {
      if (typeof a.question !== "string") return no("question is a string");
      question = a.question.trim();
      if (/[\r\n]/.test(question)) return no("question is one line");
      if (question.length > QUESTION_MAX) return no(`question is at most ${QUESTION_MAX} characters`);
      if (/^[#>]/.test(question)) return no("question cannot start with # or >");
      if (question === "") question = undefined;
    }
    const notes = JSON.parse(String(row.brief_notes_json ?? "[]")) as unknown[];
    if (notes.length >= BRIEF_MAX) return no(`the brief holds at most ${BRIEF_MAX} entries`);
    const dump = await this.articles.read(row.slug, "dump");
    const said = dump.includes(quote) || this.hooks.ownerMessages(row.id).some((m) => m.includes(quote));
    if (!said)
      return no(
        "quote the writer exactly: the quote must be an exact substring of dump.md or a writer message",
      );
    const all = await this.articles.addBriefNote(row.slug, {
      topic: topic as Topic,
      quote,
      ...(question ? { question } : {}),
    });
    this.hooks.changed(row.id);
    const covered = new Set(all.map((n) => n.topic)).size;
    return ok(`noted ${topic} · interview ${covered}/6 · ${all.length} of ${BRIEF_MAX} entries`);
  }

  private writeDraft(row: ArticleRow): ToolReply {
    if (this.hooks.grantLive?.(row.id)) return no("write_draft is not in this step");
    this.hooks.refused(row.id, WRITE_REFUSED);
    return no(
      "write refused: there is no draft grant. Only the writer can start a draft turn. Point, don't write.",
    );
  }
}
