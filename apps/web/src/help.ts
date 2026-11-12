// What each page and each stage is for, in words the Room shows. Stages the daemon cannot run yet say so.
import type { Stage } from "@sparring/protocol/commands";
import type { FileName } from "./api.ts";

export const LEAF_HELP: Record<FileName, { help: string; placeholder: string }> = {
  dump: {
    help: "dump · everything you think about this, in any order. Messy is fine. The coach reads it.",
    placeholder: "Start typing. Fragments, lists, arguments with yourself. Blank line = new block.",
  },
  brief: {
    help: "brief · what the article is for, in your own words. The interview fills it in; edit it freely.",
    placeholder: "Empty until the interview. Pick interview from the stage menu, top right.",
  },
  article: {
    help: "article · the piece itself. You write it; the coach never edits this page. Cmd+S saves a version.",
    placeholder: "Write the article here once the brief says what it is for.",
  },
};

/** Whether the coach has anything to do in a stage yet. */
export const BUILT: ReadonlySet<Stage> = new Set<Stage>(["ideas", "interview", "critique"]);

export const STAGE_HELP: Record<Stage, string> = {
  ideas:
    "Ideas: say anything to the coach and it quotes back the threads in your dump, then asks which one you mean. When the dump has something in it, pick interview from the stage menu.",
  interview:
    "Interview: the coach asks about six things, one at a time: thesis, reader, evidence, counter, uncertainty and scar. Answer here. Your answers go into the brief.",
  outline: "Outline: not built yet. For now, write the article from the brief.",
  draft: "Draft: not built yet. For now, write the article from the brief.",
  critique:
    "Critique: type /critique and the coach reads the whole article and leaves up to ten notes, each tied to an exact phrase. A bar marks the paragraph. Change the text, disagree or dismiss each note. /reader has the coach read as the reader in your brief.",
  polish: "Polish: not built yet. Passes like /pass filler arrive in a later build step.",
};

export function stageHelp(stage: string): string {
  return STAGE_HELP[stage as Stage] ?? "";
}
