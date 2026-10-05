// Turns "@claude" and table refs ("P3", "Q1") in plain text into links the
// renderer recognises (#@claude, #~P3). The renderer decides whether they are
// real — an unknown handle or a ref not on the table falls back to plain text.
// It also marks links and embeds to local paths ("chart.svg", "out/plot.png",
// "/abs/path", "file:///abs/path"): the sanitizer drops bare relative URLs, so they travel as /@ws/<path>
// and the renderer turns them back into workspace files.

type Node = { type: string; value?: string; url?: string; children?: Node[]; position?: { start: { line: number }; end: { line: number } } };

// An @handle is read as the server reads it (prompts.ts MENTION: 2–32 characters), so the handle that wakes an agent is the one the page tints.
const PATTERN = /(^|[^\w@])@([a-z][\w-]{1,31})|\b([QPDNXSF]\d{1,3})\b/gi;
const LOCAL = "/@ws/";
const LINKED = new Set(["link", "image", "definition"]);
const isLocal = (url: string) => url !== "" && !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith("#") && !url.startsWith("//");

/**
 * The local path a marked link or embed points at, or null for anything else: a ?query or
 * #fragment dropped (report.pdf#page=2 is report.pdf), then %-escapes decoded once.
 */
export const localPath = (url: string | undefined): string | null => {
  if (!url?.startsWith(LOCAL)) return null;
  const path = url.slice(LOCAL.length).replace(/[?#].*$/, "");
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};

/** The message a #m12 link points at (ids are m and digits); #methods, #main… are ordinary anchors. */
export const messageRefId = (href: string | undefined): string | null => (href && /^#m\d+$/.test(href) ? href.slice(1) : null);

const SKIP = new Set(["link", "linkReference", "inlineCode", "code", "html", "definition"]);

// In a quote an @handle is what someone else wrote: it wakes no one (parseMentions), so it is not tinted as if it did.
// As the server reads it, a quoted line is a source line that starts with ">": a line markdown only draws inside
// the quote (a lazy continuation) still wakes, so it is still tinted. Without the source, the quote decides.
const BREAK = /\r\n?|\n/g;
const breaks = (node: Node): number =>
  node.value !== undefined ? (node.value.match(BREAK)?.length ?? 0) : (node.children ?? []).reduce((n, c) => n + breaks(c), 0);

/**
 * The source line each child starts on, and whether its breaks are the source's. Children with no position
 * are one text split up (GFM's autolinks): they follow on from the sibling before, as far as the next one
 * starts. A break written as a character reference (&#10;) is not a source line, and then the lines cannot be told.
 */
const placed = (node: Node): { line?: number; exact: boolean }[] => {
  const children = node.children ?? [];
  const out: { line?: number; exact: boolean }[] = [];
  let line = node.position?.start.line;
  for (let i = 0; i < children.length; ) {
    const child = children[i]!;
    if (child.position) {
      out.push({ line: child.position.start.line, exact: breaks(child) === child.position.end.line - child.position.start.line });
      line = child.position.end.line;
      i += 1;
      continue;
    }
    let j = i;
    while (j < children.length && !children[j]!.position) j += 1;
    const run = children.slice(i, j);
    const end = j < children.length ? children[j]!.position!.start.line : node.position?.end.line;
    const exact = line !== undefined && end !== undefined && run.reduce((n, c) => n + breaks(c), 0) === end - line;
    for (const c of run) {
      out.push({ ...(line === undefined ? {} : { line }), exact });
      if (line !== undefined) line += breaks(c);
    }
    i = j;
  }
  return out;
};
const split = (value: string, quoted: (at: number) => boolean): Node[] | null => {
  const out: Node[] = [];
  let last = 0;
  PATTERN.lastIndex = 0;
  for (let m = PATTERN.exec(value); m; m = PATTERN.exec(value)) {
    if (m[2] && quoted(m.index + m[1]!.length)) continue;
    if (m[2]) {
      const start = m.index + m[1]!.length;
      if (start > last) out.push({ type: "text", value: value.slice(last, start) });
      out.push({ type: "link", url: `#@${m[2].toLowerCase()}`, children: [{ type: "text", value: `@${m[2]}` }] });
      last = start + m[2].length + 1;
    } else if (m[3] && m[3] === m[3].toUpperCase()) {
      if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) });
      out.push({ type: "link", url: `#~${m[3]}`, children: [{ type: "text", value: m[3] }] });
      last = m.index + m[3].length;
    }
  }
  if (!out.length) return null;
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
};

const walk = (node: Node, lines: string[] | null, quoted = false) => {
  if (LINKED.has(node.type) && node.url?.startsWith("file://")) node.url = node.url.slice("file://".length);
  if (LINKED.has(node.type) && node.url && isLocal(node.url)) node.url = `${LOCAL}${node.url}`;
  if (!node.children || SKIP.has(node.type)) return;
  const inQuote = quoted || node.type === "blockquote";
  const places = placed(node);
  const next: Node[] = [];
  for (const [k, child] of node.children.entries()) {
    if (child.type === "text" && child.value) {
      const value = child.value;
      const { line, exact } = places[k]!;
      const atQuote = (at: number) => {
        if (!inQuote) return false;
        if (!lines || line === undefined || !exact) return true;
        return /^[\t ]*>/.test(lines[line - 1 + (value.slice(0, at).match(BREAK)?.length ?? 0)] ?? "");
      };
      const parts = split(value, atQuote);
      if (parts) {
        next.push(...parts);
        continue;
      }
    }
    walk(child, lines, inQuote);
    next.push(child);
  }
  node.children = next;
};

/**
 * A message still streaming is parsed block by block (a posted one is parsed whole), and a quoted line is told
 * by its source. A split that does not give back the message's own text (marked rewrites a quote whose nested
 * quote or list runs on) would hide the source, so such a message is parsed whole there too.
 */
export const wholeBlocks =
  (split: (markdown: string) => string[]) =>
  (markdown: string): string[] => {
    const blocks = split(markdown);
    return blocks.join("") === markdown ? blocks : [markdown];
  };

export const remarkAgora = () => (tree: Node, file?: { value?: unknown }) => walk(tree, typeof file?.value === "string" ? file.value.split(/\r\n?|\n/) : null);
