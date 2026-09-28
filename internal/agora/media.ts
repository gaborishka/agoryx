/**
 * Media an agent points at outside the room's workspace: Codex's image_gen output in
 * $CODEX_HOME, a chart plotted to /tmp. The room does not copy or keep these — the file
 * stays where the agent put it, and lives or goes with it. The UI may show such a file
 * only while a message in the room links or embeds it, and only if it is a media type.
 */
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, normalize } from "node:path";
import type { MessageEntry } from "./types.js";

// Keep in step with VISUAL_EXT in ui/src/lib/format.ts: the UI asks for what it can show.
export const MEDIA_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico",
  ".pdf", ".html", ".htm",
  ".mp4", ".webm", ".mov", ".mp3", ".wav", ".ogg", ".m4a",
  ".csv", ".tsv", ".mmd", ".mermaid",
]);

// ![alt](path "title") and [text](path) with an absolute, ~/ or file:// path: the path is group 1.
const LINK = /!?\[[^\]\n]*\]\(<?((?:file:\/\/|~\/|\/)[^)\s>]+)>?(?:\s+"[^"\n]*")?\)/g;

/** A link target as a filesystem path: file:// stripped, %-escapes decoded, ~/ expanded. */
export const expandPath = (ref: string): string => {
  let path = ref.startsWith("file://") ? ref.slice("file://".length) : ref;
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep it as written.
  }
  return normalize(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
};

/** Absolute media paths a message links or embeds, in order. */
export const mediaRefs = (text: string): string[] => {
  const found: string[] = [];
  for (const match of text.matchAll(LINK)) {
    const path = expandPath(match[1]!);
    if (isAbsolute(path) && MEDIA_EXTS.has(extname(path).toLowerCase()) && !found.includes(path)) found.push(path);
  }
  return found;
};

/** An embed for a file wherever it is: spaces and non-ASCII escaped so the markdown link holds. */
export const embed = (path: string): string => `![](${encodeURI(path)})`;

/**
 * The real path of `ref` if a message in the room links it and it is a media file that
 * still exists; null otherwise. The room's messages are the whole allowlist.
 */
export const linkedMedia = (messages: MessageEntry[], ref: string): string | null => {
  const path = expandPath(ref);
  if (!isAbsolute(path) || !MEDIA_EXTS.has(extname(path).toLowerCase())) return null;
  if (!messages.some((message) => message.text.includes("](") && mediaRefs(message.text).includes(path))) return null;
  try {
    const real = realpathSync(path);
    // A symlink may not turn a linked picture into some other kind of file.
    if (!MEDIA_EXTS.has(extname(real).toLowerCase()) || !statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
};
