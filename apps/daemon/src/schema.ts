// The four Sparring tables (design section 7). Article text is never stored here; it lives in ~/writing.
import type { Db } from "./db.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, provider TEXT NOT NULL, chat TEXT,
  stage TEXT NOT NULL DEFAULT 'ideas', strictness TEXT NOT NULL DEFAULT 'normal',
  authorship TEXT NOT NULL DEFAULT 'coached', coach_quiet INT NOT NULL DEFAULT 0, offline INT NOT NULL DEFAULT 0,
  brief_notes_json TEXT NOT NULL DEFAULT '[]',
  draft_grant TEXT, draft_n INT NOT NULL DEFAULT 0, page_before_commit TEXT, draft_commit TEXT,
  stage_before_draft TEXT, dump_baseline_commit TEXT,
  article_sha TEXT, last_commit TEXT, saved_at TEXT, agent_seen_commit TEXT,
  open_question TEXT, last_line TEXT, letter_json TEXT NOT NULL DEFAULT '[]', pastes_json TEXT NOT NULL DEFAULT '[]',
  tokens_in INT NOT NULL DEFAULT 0, tokens_out INT NOT NULL DEFAULT 0, pr_number INT, pr_url TEXT,
  published_at TEXT, last_opened_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS comments (
  article_id TEXT NOT NULL, id TEXT NOT NULL, turn_id TEXT, file TEXT NOT NULL DEFAULT 'article',
  kind TEXT NOT NULL, pass TEXT, brief_line TEXT, span TEXT NOT NULL, block_orig TEXT NOT NULL,
  body TEXT NOT NULL, body_v2 TEXT, status TEXT NOT NULL DEFAULT 'open', muted INT NOT NULL DEFAULT 0,
  reply TEXT, seen_at TEXT, created_at TEXT NOT NULL, resolved_at TEXT,
  PRIMARY KEY (article_id, id)
);
CREATE TABLE IF NOT EXISTS publishes (
  id INTEGER PRIMARY KEY, article_id TEXT NOT NULL, n INT NOT NULL, kind TEXT NOT NULL,
  article_commit TEXT NOT NULL, authorship TEXT NOT NULL, yours_pct INT, counts_json TEXT, acks_json TEXT,
  origin_sha TEXT, branch TEXT, worktree TEXT, step TEXT NOT NULL, error TEXT, log_json TEXT NOT NULL DEFAULT '[]',
  pr_number INT, pr_url TEXT, pr_state TEXT, started_at TEXT NOT NULL, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS turns (
  turn_id TEXT PRIMARY KEY, article_id TEXT NOT NULL, origin TEXT NOT NULL, status TEXT NOT NULL,
  stage TEXT, pass TEXT, commit_before TEXT, is_question INT NOT NULL DEFAULT 0, violation INT NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL, ended_at TEXT
);
`;

/** Columns added after a table first shipped: added to an older database on start. */
const ADDED: [table: string, column: string, decl: string][] = [
  // bumped by note_brief (and later by notes): tells a client to fetch the snapshot again
  ["articles", "comments_rev", "INT NOT NULL DEFAULT 0"],
];

export function migrate(db: Db): void {
  db.exec(SCHEMA);
  for (const [table, column, decl] of ADDED) {
    const have = db.all<{ name: string }>(`PRAGMA table_info(${table})`).some((c) => c.name === column);
    if (!have) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}
