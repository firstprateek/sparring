// What each page and each stage is for, in words the Room shows.
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

/** The article leaf's help line in a drafted article. */
export const DRAFTED_HELP =
  "article · the coach wrote this draft because you said send it. A dotted bar marks each block that is still its words. Rewrite a block and the bar fades, then goes.";

/** The same line while the draft turn runs. */
export const DRAFTING_HELP =
  "article · read-only while the coach writes the draft. Your page moves to the shelf when the draft lands.";

/** Whether the coach has anything to do in a stage yet. */
export const BUILT: ReadonlySet<Stage> = new Set<Stage>([
  "ideas",
  "interview",
  "outline",
  "draft",
  "critique",
  "polish",
]);

export const STAGE_HELP: Record<Stage, string> = {
  ideas:
    "Ideas: say anything to the coach and it quotes back the threads in your dump, then asks which one you mean. When the dump has something in it, pick interview from the stage menu.",
  interview:
    "Interview: the coach asks about six things, one at a time: thesis, reader, evidence, counter, uncertainty and scar. Answer here. Your answers go into the brief.",
  outline:
    "Outline: on the article page, type a ## heading for each section with a one-line note under it. Then say anything here and the coach checks the outline against your brief: what each section gives the reader, and where the counter-argument lives. It never proposes a heading.",
  draft:
    "Draft: write the article. The coach stays quiet until you speak. /next names the section to write; say done when it is in the file and it leaves up to five notes on it. /ask <question> parks a question at the paragraph your cursor is in. Stuck? /sendit has the coach write one draft for you to review.",
  critique:
    "Critique: type /critique and the coach reads the whole article and leaves up to ten notes, each tied to an exact phrase. A bar marks the paragraph. Change the text, disagree or dismiss each note. /reader has the coach read as the reader in your brief.",
  polish:
    "Polish: one pass, one kind of problem. /pass filler runs one; the others are buried-verbs, passive, repeats, topic-sentences, cut, voice, typos and tells. /queue filler repeats cut runs several while you are away. /strict howlers only, normal or every nit sets how much they flag. /quiet folds the notes away. When it reads the way you want, publish → in the stage menu (or /publish) opens the publish sheet.",
};

export function stageHelp(stage: string): string {
  return STAGE_HELP[stage as Stage] ?? "";
}
