/**
 * Media an agent made outside the room's workspace: Codex's image_gen output in
 * $CODEX_HOME, a chart plotted to /tmp, a video rendered elsewhere. The UI can only
 * show workspace files, so these are copied into .agoryx/media/ and the agent's
 * message points at the copy. Only media types are taken, never arbitrary files.
 */
import { copyFileSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, sep } from "node:path";
import { AGORYX_DIR } from "./workspace.js";

export const MEDIA_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg",
  ".pdf", ".html", ".htm",
  ".mp4", ".webm", ".mov", ".mp3", ".wav", ".ogg", ".m4a",
  ".csv", ".tsv",
]);

export const MAX_MEDIA_BYTES = 256 * 1024 * 1024;
export const MEDIA_DIR = `${AGORYX_DIR}/media`;

// ![alt](path "title") and [text](path): the path is group 2.
const LINK = /(!?\[[^\]\n]*\]\()<?((?:file:\/\/|~\/|\/)[^)\s>]+)>?((?:\s+"[^"\n]*")?\))/g;

const expand = (ref: string): string => {
  let path = ref.startsWith("file://") ? ref.slice("file://".length) : ref;
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep it as written.
  }
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
};

const inside = (root: string, path: string): boolean => path === root || path.startsWith(`${root}${sep}`);

/** A media file outside the workspace, small enough to copy; its real path, or null. */
const outsideMedia = (workspace: string, path: string): string | null => {
  if (!isAbsolute(path) || !MEDIA_EXTS.has(extname(path).toLowerCase())) return null;
  try {
    const real = realpathSync(path);
    if (inside(realpathSync(workspace), real)) return null;
    const stat = statSync(real);
    return stat.isFile() && stat.size <= MAX_MEDIA_BYTES ? real : null;
  } catch {
    return null;
  }
};

/** Absolute media paths a message links or embeds that live outside the workspace, in order. */
export const outsideMediaRefs = (text: string, workspace: string): string[] => {
  const found: string[] = [];
  for (const match of text.matchAll(LINK)) {
    const real = outsideMedia(workspace, expand(match[2]!));
    if (real && !found.includes(real)) found.push(real);
  }
  return found;
};

/**
 * Copies media into .agoryx/media/<turn>-<name> and returns source → workspace-relative
 * path. Sources that cannot be copied are left out (the message keeps pointing at them).
 */
export const bringMedia = (workspace: string, turnId: string, sources: string[], log?: (line: string) => void): Map<string, string> => {
  const kept = new Map<string, string>();
  const used = new Set<string>();
  for (const source of sources) {
    if (kept.has(source)) continue;
    const real = outsideMedia(workspace, source);
    if (!real) continue;
    const ext = extname(real).toLowerCase();
    const stem = basename(real, extname(real)).replace(/[^\w.-]+/g, "_").slice(0, 60) || "media";
    let name = `${turnId}-${stem}${ext}`;
    for (let n = 2; used.has(name); n += 1) name = `${turnId}-${stem}-${n}${ext}`;
    try {
      mkdirSync(join(workspace, MEDIA_DIR), { recursive: true });
      copyFileSync(real, join(workspace, MEDIA_DIR, name));
      used.add(name);
      kept.set(source, `${MEDIA_DIR}/${name}`);
    } catch (error) {
      log?.(`could not bring ${source} into the room: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return kept;
};

/** Points links and embeds at the copies. */
export const rewriteMediaRefs = (text: string, workspace: string, copies: Map<string, string>): string =>
  copies.size
    ? text.replace(LINK, (whole, open: string, ref: string, close: string) => {
        const real = outsideMedia(workspace, expand(ref));
        const copy = real ? copies.get(real) : undefined;
        return copy ? `${open}${copy}${close}` : whole;
      })
    : text;
