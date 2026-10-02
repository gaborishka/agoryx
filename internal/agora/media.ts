/**
 * Media an agent points at outside the room's workspace: Codex's image_gen output in
 * $CODEX_HOME, a chart plotted to /tmp. The room does not copy or keep these — the file
 * stays where the agent put it, and lives or goes with it. The UI may show such a file
 * only while a text in the room (a message, the table's prose) links or embeds it, and only if it is a media type.
 */
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, normalize } from "node:path";
import { marked, type Tokens } from "marked";
import type { RoomState } from "./types.js";

// Keep in step with VISUAL_EXT in ui/src/lib/format.ts: the UI asks for what it can show.
export const MEDIA_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico",
  ".pdf", ".html", ".htm",
  ".mp4", ".webm", ".mov", ".mp3", ".wav", ".ogg", ".m4a",
  ".csv", ".tsv", ".mmd", ".mermaid",
]);

/** A link target as written in markdown → a filesystem path: file:// and any ?query/#fragment dropped, %-escapes decoded once. */
export const linkPath = (ref: string): string => {
  let path = ref.startsWith("file://") ? ref.slice("file://".length) : ref;
  path = path.replace(/[?#].*$/, "");
  try {
    return decodeURIComponent(path);
  } catch {
    return path; // Keep it as written.
  }
};

/** A filesystem path with ~/ expanded and normalized. Already decoded: nothing here touches % signs. */
export const nativePath = (path: string): string => normalize(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

const refsCache = new Map<string, string[]>();
const HTML_URL = /<(?:img|video|audio|source|a)\b[^>]*?\s(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/**
 * Absolute paths a text links or embeds, of any kind, in order — read with a markdown lexer, as the
 * UI renders it: reference-style links count, examples inside code spans and fences do not.
 */
export const fileRefs = (text: string): string[] => {
  const cached = refsCache.get(text);
  if (cached) return cached;
  const found: string[] = [];
  const add = (href: string) => {
    if (!/^(file:\/\/|~\/|\/)/.test(href) || href.startsWith("//")) return;
    const path = nativePath(linkPath(href));
    if (isAbsolute(path) && !found.includes(path)) found.push(path);
  };
  marked.walkTokens(marked.lexer(text), (token) => {
    if (token.type === "image" || token.type === "link") add((token as Tokens.Image | Tokens.Link).href);
    // The UI renders raw HTML too, so <img src>, <video src>, <a href> count as well.
    else if (token.type === "html") for (const match of token.raw.matchAll(HTML_URL)) add(match[1] ?? match[2] ?? "");
  });
  if (refsCache.size > 5000) refsCache.clear();
  refsCache.set(text, found);
  return found;
};

/** Absolute media paths a text links or embeds, in order (see fileRefs). */
export const mediaRefs = (text: string): string[] => fileRefs(text).filter((path) => MEDIA_EXTS.has(extname(path).toLowerCase()));

/** An embed for a file wherever it is, escaped so the markdown link holds and the name survives as written. */
export const embed = (path: string): string =>
  `![](${encodeURI(path).replace(/[()#?]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)})`;

/** Every text in the room the UI renders as markdown, and so may embed a file: messages and the table's prose. */
export const markdownTexts = (state: Pick<RoomState, "messages" | "table">): string[] => {
  const { table } = state;
  return [
    ...state.messages.map((message) => message.text),
    ...table.questions.map((q) => q.text),
    ...table.options.map((o) => o.body ?? ""),
    ...table.notes.map((n) => n.text),
    ...[...table.facts, ...table.settled, ...table.next, ...table.shifts].map((item) => item.text),
    ...table.decisions.map((d) => d.note ?? ""),
  ].filter(Boolean);
};

/**
 * The real path of `path` (a filesystem path, already decoded) if one of `texts` links it and
 * it is a media file that still exists; null otherwise. The room's texts are the whole allowlist.
 */
export const linkedMedia = (texts: string[], path: string): string | null => {
  const wanted = nativePath(path);
  if (!isAbsolute(wanted) || !MEDIA_EXTS.has(extname(wanted).toLowerCase())) return null;
  if (!texts.some((text) => mediaRefs(text).includes(wanted))) return null;
  try {
    const real = realpathSync(wanted);
    // A symlink may not turn a linked picture into some other kind of file.
    if (!MEDIA_EXTS.has(extname(real).toLowerCase()) || !statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
};
