// Shared by room routing and the composer: quoting someone is not addressing them, and neither is code:
// an @handle in `inline code` or a code block is shown, not said (the page does not tint it either).
const MENTION = /(^|[^\w@])@([a-z][\w-]{1,31})/gi;
// A backtick fence's info string has no backticks; otherwise the line is inline code.
const FENCE = /^(?:(`{3,})[^`]*|(~{3,}).*)$/;
const CLOSE = /^(`{3,}|~{3,})[\t ]*$/;
// A list item's marker and the spaces after it (with five or more columns, the text starts one column past the marker).
const ITEM = /^(?:[-+*]|(\d{1,9})[.)])(?:[\t ]+|$)/;
const HEADING = /^#{1,6}(?:[\t ]|$)/;
// Under a paragraph, a line of = or - makes it a heading.
const UNDERLINE = /^(?:=+|-+)[\t ]*$/;
const DELIMITER_CELL = /^[\t ]*:?-+:?[\t ]*$/;

// Rules, quote marks and delimiter rows are read by hand: a repeated group in a regex overflows the stack on a
// line of a few megabytes, and an agent's reply has no length cap.

/** Three or more *, - or _ (the same one), spaces and tabs between them. */
const isRule = (rest: string): boolean => {
  const marks = rest.replace(/[\t ]+/g, "");
  return marks.length >= 3 && "*-_".includes(marks[0]!) && marks === marks[0]!.repeat(marks.length);
};

/** A quote's markers from `column`, nested ones too (the next > at most four columns on), and its text's indent past the last one's space. */
const quoteMarks = (rest: string, column = 0): { nesting: number; text: number; indent: number } => {
  const step = (c: number, ch: string) => (ch === "\t" ? c + 4 - (c % 4) : c + 1);
  let end = 1;
  let col = column + 1;
  let nesting = 1;
  for (;;) {
    let at = end;
    let c = col;
    while (at < rest.length && (rest[at] === " " || rest[at] === "\t") && c - col <= 4) c = step(c, rest[at++]!);
    if (rest[at] !== ">" || c - col > 4) break;
    end = at + 1;
    col = c + 1;
    nesting += 1;
  }
  let at = end;
  let c = col;
  while (at < rest.length && (rest[at] === " " || rest[at] === "\t")) c = step(c, rest[at++]!);
  return { nesting, text: at, indent: Math.max(0, c - col - 1) };
};

/** A line's indent in columns (a tab to the next multiple of 4), and the rest of it. */
const indented = (line: string): { indent: number; rest: string } => {
  let indent = 0;
  let i = 0;
  for (; i < line.length && (line[i] === " " || line[i] === "\t"); i += 1) indent = line[i] === "\t" ? indent + 4 - (indent % 4) : indent + 1;
  return { indent, rest: line.slice(i) };
};

/** A table row's cells: [start, end) between its unescaped pipes. */
const cells = (row: string): [number, number][] => {
  const out: [number, number][] = [];
  let start = 0;
  for (let i = 0; i < row.length; i += 1) {
    if (row[i] === "\\") i += 1;
    else if (row[i] === "|") {
      out.push([start, i]);
      start = i + 1;
    }
  }
  out.push([start, row.length]);
  return out;
};
// The pipes at a row's ends leave empty cells outside it, which are not columns.
const columnCells = (row: string) => {
  const trimmed = row.trim();
  return cells(trimmed)
    .filter(([start, end], i, all) => start < end || (i > 0 && i < all.length - 1))
    .map(([start, end]) => trimmed.slice(start, end));
};
const columns = (row: string) => columnCells(row).length;
/** A table's delimiter row: cells of dashes, a colon at either end for alignment. */
const isDelimiter = (row: string) => {
  const found = columnCells(row);
  return found.length > 0 && found.every((cell) => DELIMITER_CELL.test(cell));
};

/** The [start, end) of each code span in one block's text: a run of backticks not escaped, up to the next run as long. */
const codeSpans = (text: string): [number, number][] => {
  const out: [number, number][] = [];
  // Every run of backticks, by its length, so a closer is found without reading the text again. A backslash
  // escapes no closer: inside code it is code.
  const runs = new Map<number, number[]>();
  for (let i = 0; i < text.length; ) {
    if (text[i] !== "`") {
      i += 1;
      continue;
    }
    const start = i;
    while (text[i] === "`") i += 1;
    const same = runs.get(i - start);
    if (same) same.push(start);
    else runs.set(i - start, [start]);
  }
  // Where the search for each length's closer goes on from: openers only move forward.
  const next = new Map<number, number>();
  for (let i = 0; i < text.length; ) {
    if (text[i] === "\\") i += 2;
    else if (text[i] !== "`") i += 1;
    else {
      let open = i;
      while (text[open] === "`") open += 1;
      const length = open - i;
      const closers = runs.get(length) ?? [];
      let k = next.get(length) ?? 0;
      while (k < closers.length && closers[k]! < open) k += 1;
      next.set(length, k);
      if (k < closers.length) {
        out.push([i, closers[k]! + length]);
        i = closers[k]! + length;
      } else i = open;
    }
  }
  return out;
};

type Block = "text" | "item" | "heading" | "rule" | "code";

/**
 * What a line starts, `depth` columns in from its container's text, after a paragraph or not. Only a
 * paragraph in the line's own container (`own`) takes a line of = or - as its underline. A list that starts
 * with no text or from a number other than 1 (01 passes here; the page wants exactly 1) cannot `interrupt` that
 * paragraph, nor indented code just above in the same container (the page's parser still holds that code open).
 */
const block = (rest: string, depth: number, paragraph: boolean, own = paragraph, interrupt = own): Block => {
  if (depth >= 4) return paragraph ? "text" : "code";
  if (own && UNDERLINE.test(rest)) return "rule";
  if (isRule(rest)) return "rule";
  if (HEADING.test(rest)) return "heading";
  const marker = ITEM.exec(rest);
  if (!marker) return "text";
  return interrupt && (!rest.slice(marker[0].length).trim() || (marker[1] !== undefined && Number(marker[1]) !== 1)) ? "text" : "item";
};

/** The columns spaces and tabs take from column `at` (a tab to the next multiple of 4). */
const width = (gap: string, at: number) => {
  let column = at;
  for (const c of gap) column = c === "\t" ? column + 4 - (column % 4) : column + 1;
  return column - at;
};

/**
 * A line as the server reads it: whether it is prose, and where its inline text starts (-1: none). Code spans
 * are matched across a paragraph's lines: `joins` carries on the paragraph above, `alone` is a block of one
 * line (a heading, a table row), and a table `row` shows as many cells as its header (0: not a row), each
 * keeping its spans in.
 */
type Line = { text: string; prose: boolean; from: number; joins: boolean; alone: boolean; row: number };

/**
 * The prose of a message: code blocks and quoted lines emptied, code spans blanked, line breaks kept, so no
 * two tokens join. A fence opens at most 3 columns in from where its block's text starts (the line's, or a
 * list item's) and closes only as far in, so a ``` inside code, or in an indented line of prose, is text. A
 * code span stays within its paragraph, heading or table cell, as the page reads them, and may run from a
 * quote into a line markdown continues it with.
 */
export const prose = (text: string): string => {
  // CR, LF and CRLF each end a line, as they do for the page.
  const source = text.split(/\r\n?|\n/);
  const lines: Line[] = [];
  let fence: { mark: string; base: number } | null = null;
  let quoteFence: { mark: string; nesting: number } | null = null;
  // The content columns of the list items the line is in, innermost last.
  const items: number[] = [];
  // Whether the line before was paragraph text a following line may carry on, and whether in a quote.
  let paragraph: "plain" | "quote" | null = null;
  // The quote's depth (its > marks) and list depth its paragraph is in, so a deeper quote, or one outside the list, starts anew.
  let quoted = { marks: 0, items: 0 };
  // In a table: the delimiter row comes next, or rows do; the list depth it is in, and its header's cells.
  let table: "delimiter" | "rows" | null = null;
  let tableItems = 0;
  let tableColumns = 0;
  // The line before was indented code in this container (blank lines keep it the page's open block).
  let code = false;
  // The line before was in a quote: a line that is not ends the quote.
  let wasQuote = false;
  // The list depth of an item with nothing in it yet: a blank line ends it (an item starts with one blank line at most).
  let bare = 0;
  // A blank line ended a bare item: the next line that is not blank has left it, quoted or not.
  let left = false;
  const push = (line: string, prose: boolean, inline: Partial<Omit<Line, "text" | "prose">> = {}) =>
    lines.push({ text: line, prose, from: -1, joins: false, alone: false, row: 0, ...inline });
  source.forEach((line, n) => {
    const { indent, rest } = indented(line);
    const lead = line.length - rest.length;
    const afterCode = code;
    code = false;
    if (fence) {
      if (!rest || indent >= fence.base) {
        const close = CLOSE.exec(rest)?.[1];
        if (close && indent - fence.base <= 3 && close[0] === fence.mark[0] && close.length >= fence.mark.length) fence = null;
        return push(line, false);
      }
      // A line left of the item the fence is in ends the item, and the fence with it.
      fence = null;
    }
    if (!rest) {
      code = afterCode;
      wasQuote = false;
      if (bare && bare === items.length) {
        items.length -= 1;
        left = true;
      }
      bare = 0;
      paragraph = table = quoteFence = null;
      return push(line, true);
    }
    bare = 0;
    // A line left of an item's text ends that item, unless it only carries on the item's paragraph.
    let depth = items.length;
    while (depth && indent < items[depth - 1]!) depth -= 1;
    const base = depth ? items[depth - 1]! : 0;
    const leftItem = left;
    left = false;
    // Every source line in a generated citation has >. Unicode separators within a quoted line stay quoted.
    // Four columns in, a > only carries on a quoted paragraph, as its text, whatever follows it.
    if (rest.startsWith(">") && (indent - base <= 3 || paragraph === "quote")) {
      wasQuote = true;
      table = null;
      if (indent - base > 3) return push(line, false, { from: lead, joins: true });
      // A quote deeper than the paragraph's, or outside the list it is in, starts a block of its own, and a
      // shallower one is a lazy line of it.
      const q = quoteMarks(rest, indent);
      const nesting = q.nesting;
      const carries = paragraph === "quote" && nesting <= quoted.marks && depth >= quoted.items;
      items.length = depth;
      const inner = { indent: q.indent, rest: rest.slice(q.text) };
      if (quoteFence && nesting >= quoteFence.nesting) {
        const close = CLOSE.exec(inner.rest)?.[1];
        if (close && nesting === quoteFence.nesting && inner.indent <= 3 && close[0] === quoteFence.mark[0] && close.length >= quoteFence.mark.length) quoteFence = null;
        paragraph = null;
        return push(line, false);
      }
      quoteFence = null;
      const open = inner.indent <= 3 ? FENCE.exec(inner.rest) : null;
      if (!inner.rest || open) {
        quoteFence = open ? { mark: open[1] ?? open[2]!, nesting } : null;
        paragraph = null;
        return push(line, false);
      }
      const kind = block(inner.rest, inner.indent, carries);
      // Quoted text the quote's paragraph runs on in, or a block of its own.
      push(line, false, { from: kind === "code" ? -1 : line.length - inner.rest.length, joins: carries && kind === "text", alone: kind === "heading" });
      if (!(carries && kind === "text")) quoted = { marks: nesting, items: items.length };
      paragraph = kind === "text" || kind === "item" ? "quote" : null;
      return;
    }
    // A line that ends a quote or an item holds no indented code open in it after: the page's parser has
    // left that container. A fence in a quote ends with the quote.
    const closes = wasQuote || leftItem || depth < items.length;
    wasQuote = false;
    quoteFence = null;
    if (table === "delimiter") {
      table = "rows";
      return push(line, true);
    }
    const marker = ITEM.exec(rest)?.[0];
    const own = paragraph === "plain" && depth === items.length;
    const kind = block(rest, indent - base, paragraph !== null, own, own || (afterCode && depth === items.length));
    // An item's text starts after its marker and the spaces after it; with none after the marker, or more than
    // four (then the text is indented code), its column is one past the marker.
    const mark = kind === "item" ? marker!.trimEnd().length : 0;
    const said = kind === "item" ? rest.slice(marker!.length) : rest;
    const gap = kind === "item" ? width(marker!.slice(mark), indent + mark) : 0;
    const coded = Boolean(said) && gap > 4;
    const open = kind === "item" ? (coded ? null : FENCE.exec(said)) : indent - base <= 3 ? FENCE.exec(rest) : null;
    if (paragraph && depth < items.length && kind === "text" && !open) {
      // A lazy line: still the paragraph of the innermost item, so nothing in it is checked against that item's column.
      return push(line, true, { from: lead, joins: true });
    }
    items.length = depth;
    if (kind === "item") {
      items.push(indent + mark + (said && !coded ? gap : 1));
      if (!said) bare = items.length;
    }
    if (open || kind === "code" || coded) {
      if (open) fence = { mark: open[1] ?? open[2]!, base: items.at(-1) ?? 0 };
      code = !open && !closes;
      paragraph = table = null;
      return push(line, false);
    }
    // A table starts at a line whose next one, in the same container, is a delimiter row with as many cells (with
    // a pipe or a colon: dashes alone underline a heading; not an item's marker), and runs to a blank line, a
    // block or the container's end. An item's text may start one, when it is text. Not from a line that carries
    // on a quote: the delimiter row would be outside the quote.
    const next = source[n + 1] === undefined ? null : indented(source[n + 1]!);
    const at = items.at(-1) ?? 0;
    const header =
      (kind === "text" && paragraph !== "quote" && indent - base <= 3) || (kind === "item" && said !== "" && !said.startsWith(">") && block(said, 0, false) === "text");
    if (header && !table && next && next.indent >= at && next.indent - at <= 3 && /[|:]/.test(next.rest) && !ITEM.test(next.rest) && isDelimiter(next.rest) && columns(said) === columns(next.rest)) {
      table = "delimiter";
      tableItems = items.length;
      tableColumns = columns(said);
    } else if (!(table && kind === "text" && depth >= tableItems)) table = null;
    const from = kind === "item" ? lead + marker!.length : kind === "heading" ? lead + /^#+/.exec(rest)![0].length : lead;
    if (table || kind === "rule" || kind === "heading") {
      paragraph = null;
      if (kind === "rule") return push(line, true);
      return push(line, true, { from, alone: true, row: table ? tableColumns : 0 });
    }
    const joins = paragraph !== null && kind === "text";
    push(line, true, { from, joins });
    // An item's text may be a quote, then a line carrying it on is quoted too.
    const content = said.trim();
    if (kind === "item" && content.startsWith(">")) quoted = { marks: quoteMarks(content, items.at(-1)!).nesting, items: items.length };
    paragraph = !content ? null : (kind === "item" && content.startsWith(">")) || (joins && paragraph === "quote") ? "quote" : "plain";
  });

  // Each line's code spans, as [start, end), blanked once at the end.
  const spans: [number, number][][] = lines.map(() => []);
  const blank = (at: number, start: number, end: number) => spans[at]!.push([start, end]);
  let group: number[] = [];
  const flush = () => {
    let joined = "";
    const starts = group.map((at) => {
      const start = joined.length;
      joined += lines[at]!.text.slice(lines[at]!.from) + "\n";
      return start;
    });
    // Spans come in order and do not overlap: each line is visited from the one the last span ended in.
    let k = 0;
    for (const [s, e] of codeSpans(joined)) {
      while (k + 1 < group.length && starts[k + 1]! <= s) k += 1;
      for (let j = k; j < group.length && starts[j]! < e; j += 1) {
        const at = group[j]!;
        const from = lines[at]!.from;
        const a = Math.max(s, starts[j]!) - starts[j]!;
        const b = Math.min(e, starts[j]! + lines[at]!.text.length - from) - starts[j]!;
        if (a < b) blank(at, from + a, from + b);
      }
    }
    group = [];
  };
  lines.forEach((line, at) => {
    if (line.from < 0 || !line.joins || line.alone) flush();
    if (line.from < 0) return;
    if (line.row) {
      const row = line.text.slice(line.from);
      // Past the header's cells the page shows none, so nothing there is said.
      const edge = row.startsWith("|") ? 1 : 0;
      cells(row).forEach(([start, end], i) => {
        if (i - edge >= line.row) blank(at, line.from + start, line.from + end);
        else for (const [s, e] of codeSpans(row.slice(start, end))) blank(at, line.from + start + s, line.from + start + e);
      });
      return;
    }
    group.push(at);
    if (line.alone) flush();
  });
  flush();
  return lines
    .map((line, at) => {
      if (!line.prose) return "";
      let kept = "";
      let from = 0;
      for (const [start, end] of spans[at]!.sort((a, b) => a[0] - b[0])) {
        kept += line.text.slice(from, start) + " ".repeat(end - start);
        from = end;
      }
      return kept + line.text.slice(from);
    })
    .join("\n");
};

export const parseMentions = (text: string, handles: string[]): string[] => {
  const known = new Set(handles.map((handle) => handle.toLowerCase()));
  const found = new Set<string>();
  for (const match of prose(text).matchAll(MENTION)) {
    const handle = match[2]!.toLowerCase();
    if (known.has(handle) || handle === "all") found.add(handle);
  }
  return [...found];
};
