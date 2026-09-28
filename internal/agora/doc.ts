import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DocRevisedEvent } from "./types.js";
import { AGORYX_DIR, resolveInside } from "./workspace.js";

/**
 * The room's canonical file: the one text the room is making. Agoryx names it,
 * keeps every revision with its author and shows each agent what the others
 * changed. It never says what goes in it.
 */

/** Revisions bigger than this are recorded without their text (stats and hash only). */
export const MAX_DOC_TEXT = 256 * 1024;

/** "./notes/time.md" → "notes/time.md"; null for anything outside the workspace or in .git / .agoryx. */
export const normalizeDocPath = (raw: string): string | null => {
  const cleaned = raw.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!cleaned || cleaned.startsWith("/") || /^[a-z]:/i.test(cleaned)) return null;
  const parts = cleaned.split("/").filter((part) => part && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) return null;
  if (parts[0] === ".git" || parts[0] === AGORYX_DIR) return null;
  return parts.join("/");
};

export const docHash = (text: string): string => createHash("sha1").update(text).digest("hex").slice(0, 12);

export interface DocFile {
  text: string;
  hash: string;
  size: number;
  mtimeMs: number;
}

/** The file as it is now; null when it does not exist (yet), is not a file, or leads out of the workspace. */
export const readDoc = (workspace: string, rel: string): DocFile | null => {
  const full = join(workspace, rel);
  if (!existsSync(full)) return null;
  const real = resolveInside(workspace, rel);
  if (!real) return null;
  try {
    const stats = statSync(real);
    if (!stats.isFile()) return null;
    const text = readFileSync(real, "utf8");
    return { text, hash: docHash(text), size: stats.size, mtimeMs: stats.mtimeMs };
  } catch {
    return null;
  }
};

export const statDoc = (workspace: string, rel: string): { size: number; mtimeMs: number } | null => {
  try {
    const stats = statSync(join(workspace, rel));
    return stats.isFile() ? { size: stats.size, mtimeMs: stats.mtimeMs } : null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Line diff
// ---------------------------------------------------------------------------

export interface DiffLine {
  t: " " | "+" | "-";
  s: string;
}

/** A hunk view: changed lines with a little context; runs of unchanged lines collapse to a skip. */
export type DiffItem = DiffLine | { skip: number };

const splitLines = (text: string): string[] => {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
};

const lcsDiff = (a: string[], b: string[]): DiffLine[] => {
  const n = a.length;
  const m = b.length;
  // suffix LCS lengths, row-major (n+1) x (m+1)
  const table = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[at(i, j)] = a[i] === b[j] ? table[at(i + 1, j + 1)]! + 1 : Math.max(table[at(i + 1, j)]!, table[at(i, j + 1)]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ t: " ", s: a[i]! });
      i += 1;
      j += 1;
    } else if (table[at(i + 1, j)]! >= table[at(i, j + 1)]!) {
      out.push({ t: "-", s: a[i]! });
      i += 1;
    } else {
      out.push({ t: "+", s: b[j]! });
      j += 1;
    }
  }
  while (i < n) out.push({ t: "-", s: a[i++]! });
  while (j < m) out.push({ t: "+", s: b[j++]! });
  return out;
};

// Past this many LCS cells (16 MB of table) the diff switches to Myers, whose memory grows with the
// number of edits rather than the document's size.
const LCS_MAX_CELLS = 4_000_000;
// Myers keeps one diagonal row per edit (O(D²) memory); past this, the change is a rewrite anyway.
const MYERS_MAX_EDITS = 1_000;

/** Myers' O((N+M)·D) diff; null when the edit script would be longer than `maxEdits`. */
const myersDiff = (a: string[], b: string[], maxEdits: number): DiffLine[] | null => {
  const n = a.length;
  const m = b.length;
  // trace[d][k + d] = furthest x on diagonal k after d edits
  const trace: Int32Array[] = [];
  const down = (prev: Int32Array, d: number, k: number) =>
    k === -d || (k !== d && prev[k + 1 + d - 1]! > prev[k - 1 + d - 1]!);
  for (let d = 0; d <= Math.min(maxEdits, n + m); d += 1) {
    const cur = new Int32Array(2 * d + 1);
    const prev = trace[d - 1];
    for (let k = -d; k <= d; k += 2) {
      let x = !prev ? 0 : down(prev, d, k) ? prev[k + 1 + d - 1]! : prev[k - 1 + d - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      cur[k + d] = x;
      if (x < n || y < m) continue;
      trace.push(cur);
      const out: DiffLine[] = [];
      for (let step = d; step > 0; step -= 1) {
        const before = trace[step - 1]!;
        const kk = x - y;
        const fromK = down(before, step, kk) ? kk + 1 : kk - 1;
        const fromX = before[fromK + step - 1]!;
        const fromY = fromX - fromK;
        while (x > fromX && y > fromY) out.push({ t: " ", s: a[(x -= 1, y -= 1, x)]! });
        out.push(fromK === kk + 1 ? { t: "+", s: b[fromY]! } : { t: "-", s: a[fromX]! });
        x = fromX;
        y = fromY;
      }
      while (x > 0) out.push({ t: " ", s: a[(x -= 1)]! });
      return out.reverse();
    }
    trace.push(cur);
  }
  return null;
};

/** Every line of `after`, plus the removed lines of `before`, in order. */
export const diffLines = (before: string, after: string): DiffLine[] => {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const middle =
    midA.length * midB.length <= LCS_MAX_CELLS
      ? lcsDiff(midA, midB)
      : (myersDiff(midA, midB, MYERS_MAX_EDITS) ?? [
          ...midA.map((s): DiffLine => ({ t: "-", s })),
          ...midB.map((s): DiffLine => ({ t: "+", s })),
        ]);
  return [
    ...a.slice(0, start).map((s): DiffLine => ({ t: " ", s })),
    ...middle,
    ...a.slice(endA).map((s): DiffLine => ({ t: " ", s })),
  ];
};

export const diffStats = (lines: DiffLine[]): { added: number; removed: number } => ({
  added: lines.filter((line) => line.t === "+").length,
  removed: lines.filter((line) => line.t === "-").length,
});

export const diffHunks = (lines: DiffLine[], context = 2): DiffItem[] => {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.t === " ") return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k += 1) keep[k] = true;
  });
  const out: DiffItem[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped) out.push({ skip: skipped });
      skipped = 0;
      out.push(line);
    } else skipped += 1;
  });
  if (skipped && out.length > 0) out.push({ skip: skipped });
  return out;
};

/** A compact diff for a prompt: hunks only, capped; null when nothing changed. */
export const renderDiff = (before: string, after: string, maxLines = 80): string | null => {
  const hunks = diffHunks(diffLines(before, after));
  if (!hunks.some((item) => "t" in item && item.t !== " ")) return null;
  const rendered = hunks.map((item) => ("skip" in item ? `  … ${item.skip} unchanged line${item.skip === 1 ? "" : "s"}` : `${item.t} ${item.s}`));
  if (rendered.length <= maxLines) return rendered.join("\n");
  return `${rendered.slice(0, maxLines).join("\n")}\n  … ${rendered.length - maxLines} more diff lines — read the file for the rest`;
};

/** The first revision: the file as the room found it, credited to nobody ("agoryx"). */
export const baselineRevision = (workspace: string, path: string): DocRevisedEvent | null => {
  const now = readDoc(workspace, path);
  if (!now) return null;
  const truncated = now.text.length > MAX_DOC_TEXT;
  return {
    type: "doc.revised",
    path,
    by: "agoryx",
    hash: now.hash,
    ...(truncated ? { truncated: true } : { text: now.text }),
    added: diffStats(diffLines("", truncated ? "" : now.text)).added,
    removed: 0,
  };
};
