// The slash commands, in one place. The listed ones are served through AHP completions with their approved
// hints; the rest are accepted but not listed.

export interface Command {
  name: string;
  hint: string;
  /** host: the host acts and the agent is not started. prompt: rewritten into a coach turn. client: the web
   *  client opens something and sends no turn. */
  kind: "host" | "prompt" | "client";
}

export const LISTED: readonly Command[] = [
  { name: "next", hint: "write the next section, then say done", kind: "prompt" },
  { name: "ask", hint: "park a question at the caret", kind: "prompt" },
  { name: "critique", hint: "argument pass over the whole draft", kind: "prompt" },
  { name: "reader", hint: "role-play the reader in brief.md", kind: "prompt" },
  {
    name: "pass",
    hint: "filler buried-verbs passive repeats topic-sentences cut voice typos tells",
    kind: "prompt",
  },
  { name: "queue", hint: "run passes unattended", kind: "host" },
  { name: "strict", hint: "howlers only · normal · every nit", kind: "host" },
  { name: "quiet", hint: "no notes until /quiet again, /pass or /critique", kind: "host" },
  { name: "sendit", hint: "the coach writes the draft; you review alone", kind: "client" },
  { name: "publish", hint: "open the publish sheet", kind: "client" },
];

export const UNLISTED: readonly Command[] = [
  { name: "idea", hint: "", kind: "host" },
  { name: "offline", hint: "", kind: "host" },
  { name: "stage", hint: "", kind: "host" },
  { name: "mute", hint: "", kind: "host" },
  { name: "log", hint: "", kind: "client" },
];

export const STAGES = ["ideas", "interview", "outline", "draft", "critique", "polish"] as const;
export type Stage = (typeof STAGES)[number];

export const STRICTNESS = ["howlers only", "normal", "every nit"] as const;

/** The built-in passes, in `prompts/passes/`. A copy of each is put in `~/writing/passes/`, where the writer edits it. */
export const PASSES = [
  "filler",
  "buried-verbs",
  "passive",
  "repeats",
  "topic-sentences",
  "cut",
  "voice",
  "typos",
  "tells",
] as const;

/** `/strict <word>`: the level a word names, by its full name or its first word. */
export function strictnessOf(word: string): (typeof STRICTNESS)[number] | undefined {
  const w = word.trim().toLowerCase().replace(/\s+/g, " ");
  if (!w) return undefined;
  return STRICTNESS.find((s) => s === w || s.split(" ")[0] === w || s.split(" ").at(-1) === w);
}

export const TOPICS = ["thesis", "reader", "evidence", "counter", "uncertainty", "scar"] as const;

/** The command a composer line starts with, or null when it is plain text. */
export function parseCommand(line: string): { command: Command; rest: string } | null {
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(line.trim());
  if (!m) return null;
  const command = [...LISTED, ...UNLISTED].find((c) => c.name === m[1]);
  return command ? { command, rest: (m[2] ?? "").trim() } : null;
}

/**
 * The commands this build can act on. The rest are listed so the writer can see what is coming; the client says
 * they are not built yet instead of sending them, and the daemon answers any that arrive with a host line.
 */
export const BUILT_COMMANDS: ReadonlySet<string> = new Set([
  "stage",
  "offline",
  "idea",
  "log",
  "critique",
  "reader",
  "mute",
  "next",
  "ask",
  "pass",
  "queue",
  "strict",
  "quiet",
  "sendit",
]);
