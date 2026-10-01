import type { FileDiffMetadata, SelectedLineRange, SelectionSide } from "@pierre/diffs";

/** One line of a patch as the reader sees it: its mark and its number in the old and the new file. */
interface Row {
  mark: "+" | "-" | " ";
  old: number | null;
  new: number | null;
  text: string;
}

const bare = (line: string | undefined) => (line ?? "").replace(/\r?\n$/, "");

const rowsOf = (file: FileDiffMetadata): Row[] => {
  const rows: Row[] = [];
  for (const hunk of file.hunks) {
    let old = hunk.deletionStart;
    let neu = hunk.additionStart;
    for (const part of hunk.hunkContent) {
      if (part.type === "context") {
        // Context lines sit in both arrays.
        for (let i = 0; i < part.lines; i++) rows.push({ mark: " ", old: old++, new: neu++, text: bare(file.additionLines[part.additionLineIndex + i]) });
        continue;
      }
      for (let i = 0; i < part.deletions; i++) rows.push({ mark: "-", old: old++, new: null, text: bare(file.deletionLines[part.deletionLineIndex + i]) });
      for (let i = 0; i < part.additions; i++) rows.push({ mark: "+", old: null, new: neu++, text: bare(file.additionLines[part.additionLineIndex + i]) });
    }
  }
  return rows;
};

const find = (rows: Row[], line: number, side: SelectionSide | undefined) =>
  side === "deletions" ? rows.findIndex((r) => r.mark !== "+" && r.old === line) : rows.findIndex((r) => r.mark !== "-" && r.new === line);

const span = (nums: (number | null)[]) => {
  const n = nums.filter((x): x is number => x !== null);
  if (!n.length) return "";
  return n[0] === n[n.length - 1] ? `${n[0]}` : `${n[0]}–${n[n.length - 1]}`;
};

/**
 * The lines a reader picked in a file's diff: the patch text (marks kept) and a short name for them:
 * +42–48 when all were added (new-file numbers), -10–12 when all were removed (old-file numbers),
 * and both numberings, old 10–12 · new 10–13, when removed, added and unchanged lines mix.
 */
export const pickedLines = (file: FileDiffMetadata, range: SelectedLineRange): { text: string; lines: string } | null => {
  const rows = rowsOf(file);
  const a = find(rows, range.start, range.side);
  const b = find(rows, range.end, range.endSide ?? range.side);
  if (a < 0 || b < 0) return null;
  const picked = rows.slice(Math.min(a, b), Math.max(a, b) + 1);
  const text = picked.map((r) => `${r.mark}${r.text}`).join("\n");
  if (picked.every((r) => r.mark === "+")) return { text, lines: `+${span(picked.map((r) => r.new))}` };
  if (picked.every((r) => r.mark === "-")) return { text, lines: `-${span(picked.map((r) => r.old))}` };
  return { text, lines: [`old ${span(picked.map((r) => r.old))}`, `new ${span(picked.map((r) => r.new))}`].join(" · ") };
};
