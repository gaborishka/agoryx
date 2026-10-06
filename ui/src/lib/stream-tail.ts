/**
 * The fence line (``` or ~~~, with its info string) a code block opened with, when `text` ends inside one.
 * A closing fence is the same character, at least as long, with nothing after it.
 */
const openFence = (text: string): string | null => {
  let open: { line: string; char: string; length: number } | null = null;
  for (const line of text.split("\n")) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence) continue;
    const marker = fence[1]!;
    if (!open) {
      // A backtick fence's info string may not hold a backtick.
      if (marker[0] === "`" && fence[2]!.includes("`")) continue;
      open = { line: line.trimStart(), char: marker[0]!, length: marker.length };
    } else if (marker[0] === open.char && marker.length >= open.length && !fence[2]!.trim()) {
      open = null;
    }
  }
  return open?.line ?? null;
};

/**
 * The end of a long streaming reply, as the live turn shows it: from the first paragraph after a step (about `keep`
 * to `keep * 1.5` characters), or from the step itself when no paragraph starts early enough (at least `keep`).
 * The start moves in steps of `keep / 2`, not with every token. Markdown renders a message block by block and keeps
 * the blocks it rendered while their text stays the same: a window that slid by each token would change every block of
 * it, and all of them would be parsed and rendered again for each chunk. A tail that begins inside a code block opens
 * it again, so the rest is not read inside out.
 */
export const streamTail = (text: string, keep = 2400): string => {
  if (text.length <= keep) return text;
  const step = Math.max(1, Math.floor(keep / 2));
  const floor = Math.floor((text.length - keep) / step) * step;
  if (floor === 0) return text;
  const paragraph = text.indexOf("\n\n", floor);
  const atParagraph = paragraph >= 0 && paragraph + 2 <= text.length - keep / 2;
  const from = atParagraph ? paragraph + 2 : floor;
  const fence = openFence(text.slice(0, from));
  return `…${atParagraph || fence ? "\n\n" : ""}${fence ? `${fence}\n` : ""}${text.slice(from)}`;
};
