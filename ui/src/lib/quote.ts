import { local } from "./api";

/** A passage quoted from a room message: whose words, which message, and the words as the reader selected them. */
export interface Quote {
  /** The message id (m12), or the turn (t7) whose diff the lines come from. */
  id: string;
  author: string;
  /** The author's name as the room shows it (Codex, Claude Opus, Ivan). */
  label: string;
  /** The words, or the diff lines with their +/−/space marks. */
  text: string;
  /** Lines of the turn's diff rather than words of a message: the file and which lines (+42–48: added lines 42 to 48). */
  file?: { path: string; lines: string };
}

/** Longer selections are cut: a quote points at a passage, the message itself stays one click away. */
export const QUOTE_MAX = 1200;

const lines = (text: string) => text.replace(/\r\n?/g, "\n").split("\n");

export const clipQuote = (text: string) => {
  // Only blank lines are cut from the ends: the first line's indent is part of a selected code passage.
  const flat = lines(text).join("\n").replace(/\n{3,}/g, "\n\n").replace(/^(?:[ \t]*\n)+/, "").trimEnd();
  return flat.length > QUOTE_MAX ? `${flat.slice(0, QUOTE_MAX).trimEnd()}…` : flat;
};

/** A name or id on the source line: one line, and nothing that ends the link early. */
const inline = (text: string) => text.replace(/[\r\n[\]()]+/g, " ").trim();

/** A fence longer than any backtick run inside, so the passage cannot close it. */
const fence = (text: string) => "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((run) => run[0].length + 1)));

/**
 * The quote as the message carries it: a markdown blockquote whose first paragraph names the source.
 * Every line sits under `>`, so the server reads an @handle inside it as quoted, not as an address.
 * The selected lines are kept as they are. An indented passage (code) goes in a fence, which keeps its
 * indent and blank lines on screen too; other lines are each their own paragraph, as markdown would run them together.
 */
export const quoteMarkdown = (q: Quote) => {
  const body = lines(q.text);
  const under = (line: string) => (line ? `> ${line}` : ">");
  if (q.file) {
    // The turn's snapshot does not change, so t7 + path + lines name the very version the human read.
    const href = `#${inline(q.id)}/${encodeURIComponent(q.file.path).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`;
    // A path is shown as it is: brackets escaped (one would end the link text), line breaks flattened.
    const path = q.file.path.replace(/[\r\n]+/g, " ").replace(/[\\[\]]/g, "\\$&");
    const source = `[${inline(q.label)} · ${inline(q.id)} · ${path} ${inline(q.file.lines)}](${href})`;
    const marks = fence(q.text);
    return [source, "", `${marks}diff`, ...body, marks].map(under).join("\n");
  }
  const source = `[${inline(q.label)} · ${inline(q.id)}](#${inline(q.id)})`;
  if (body.some((line) => /^[ \t]+\S/.test(line))) {
    const marks = fence(q.text);
    return [source, "", marks, ...body, marks].map(under).join("\n");
  }
  return [source, ...body.filter((line) => line.trim())].map(under).join("\n>\n");
};

/**
 * Who a quote goes to when the draft names no one yet, the same for words of a message and lines of a diff:
 * the agent who wrote them. Nobody for the human's own words, or for lines of a file several agents changed.
 */
export const quoteAddressee = (q: Quote, agents: readonly string[], shared = false): string | undefined =>
  !shared && agents.includes(q.author) ? q.author : undefined;

/** A quote block as quoteMarkdown wrote it, read back; null for anything it would not write exactly so. */
export const readQuote = (block: string, authorOf: (id: string) => string | undefined): Quote | null => {
  const rows: string[] = [];
  for (const line of block.split("\n")) {
    if (line === ">") rows.push("");
    else if (line.startsWith("> ")) rows.push(line.slice(2));
    else return null;
  }
  const source = /^\[(.*)\]\((#[^)]*)\)$/.exec(rows[0] ?? "");
  if (!source) return null;
  const [, title, href] = source as unknown as [string, string, string];
  const fenced = (from: number) => {
    const marks = rows[from];
    if (rows[from - 1] !== "" || !marks || !/^`{3,}(diff)?$/.test(marks) || rows.at(-1) !== marks.replace(/diff$/, "") || rows.length < from + 2) return null;
    return rows.slice(from + 1, -1).join("\n");
  };
  let q: Quote | null = null;
  const diff = /^#(t[^/]+)\/(.*)$/.exec(href);
  if (diff) {
    const [, id, encoded] = diff as unknown as [string, string, string];
    let path: string;
    try {
      path = decodeURIComponent(encoded);
    } catch {
      return null;
    }
    const at = title.indexOf(` · ${id} · `);
    const shown = path.replace(/[\r\n]+/g, " ").replace(/[\\[\]]/g, "\\$&");
    const rest = at < 0 ? "" : title.slice(at + id.length + 6);
    const text = fenced(2);
    const author = authorOf(id);
    if (at < 0 || !rest.startsWith(`${shown} `) || text === null || !author) return null;
    q = { id, author, label: title.slice(0, at), text, file: { path, lines: rest.slice(shown.length + 1) } };
  } else {
    const id = href.slice(1);
    const author = authorOf(id);
    if (!id || !author || !title.endsWith(` · ${id}`)) return null;
    const text = rows[1] === "" && /^`{3,}$/.test(rows[2] ?? "") ? fenced(2) : rows.slice(1).filter(Boolean).join("\n");
    if (text === null) return null;
    q = { id, author, label: title.slice(0, -(id.length + 3)), text };
  }
  return quoteMarkdown(q) === block ? q : null;
};

/** One quote is its source and its words: the same code from two files of one turn is two quotes. */
export const quoteKey = (q: Quote) => JSON.stringify([q.file ? "diff" : "message", q.id, q.file?.path ?? "", q.file?.lines ?? "", q.text]);

/** The message with its quotes on top, in the order they were added. */
export const withQuotes = (body: string, quotes: Quote[]) => [...quotes.map(quoteMarkdown), body].filter(Boolean).join("\n\n");

const key = (roomId: string) => `quotes.${roomId}`;

/** Quotes wait with the draft: kept per room until sent or removed. */
export const savedQuotes = (roomId: string): Quote[] => {
  try {
    const raw: unknown = JSON.parse(local.get(key(roomId)) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (q): q is Quote =>
        Boolean(q) &&
        ["id", "author", "label", "text"].every((field) => typeof (q as Record<string, unknown>)[field] === "string") &&
        (q.file === undefined || (typeof q.file?.path === "string" && typeof q.file?.lines === "string")),
    );
  } catch {
    return [];
  }
};

export const saveQuotes = (roomId: string, quotes: Quote[]) => local.set(key(roomId), quotes.length ? JSON.stringify(quotes) : null);
