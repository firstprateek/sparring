// The slash list under the composer: the listed commands whose name starts with what is typed after `/`.
import { type Command, LISTED } from "@sparring/protocol/commands";

/**
 * The commands to offer for the composer text, or null when the list is closed: it is open while the text is a
 * `/` followed by letters only (no space yet, one line).
 */
export function slashMatches(text: string, commands: readonly Command[] = LISTED): Command[] | null {
  const m = /^\/([a-z]*)$/.exec(text);
  if (!m) return null;
  const typed = m[1] ?? "";
  return commands.filter((c) => c.name.startsWith(typed));
}

/** The composer text once a command is picked. */
export const completion = (c: Command): string => `/${c.name} `;
