/**
 * The end of a long streaming reply, as the live turn shows it: at least `keep` characters, from the start of a paragraph.
 * The start moves in steps of `keep / 2`, not with every token. Markdown renders a message block by block and keeps
 * the blocks it rendered while their text stays the same: a window that slid by each token would change every block of
 * it, and all of them would be parsed and rendered again for each chunk.
 */
export const streamTail = (text: string, keep = 2400): string => {
  if (text.length <= keep) return text;
  const step = Math.max(1, Math.floor(keep / 2));
  const floor = Math.floor((text.length - keep) / step) * step;
  if (floor === 0) return text;
  const paragraph = text.indexOf("\n\n", floor);
  // The paragraph after the step, unless it begins too late to keep enough: then the step itself.
  const from = paragraph >= 0 && paragraph + 2 <= text.length - keep / 2 ? paragraph + 2 : floor;
  return `…${from === paragraph + 2 ? "\n\n" : ""}${text.slice(from)}`;
};
