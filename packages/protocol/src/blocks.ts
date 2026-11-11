// The page is a list of blocks: the blank-line split of the file. Blocks have no ids; the browser and the
// daemon split and join with these two functions so they always agree.

/** The blocks of a file. An empty file is one empty block, so the page always has a place to type. */
export function splitBlocks(text: string): string[] {
  const body = text.replace(/\r\n?/g, "\n").replace(/^\n+|\s+$/g, "");
  if (body === "") return [""];
  return body.split(/\n(?:[ \t]*\n)+/);
}

/** The file for a list of blocks: one blank line between blocks, one newline at the end. */
export function joinBlocks(blocks: readonly string[]): string {
  const kept = blocks.map((b) => b.replace(/\s+$/, "")).filter((b) => b !== "");
  return kept.length === 0 ? "" : `${kept.join("\n\n")}\n`;
}

/** Words as the footer counts them: runs of letters, digits and apostrophes. */
export function wordCount(text: string): number {
  return text.match(/[\p{L}\p{N}'’]+/gu)?.length ?? 0;
}
