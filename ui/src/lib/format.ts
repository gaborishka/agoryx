// Small formatting helpers shared by the whole UI (Ukrainian copy).

import { decisionOf, sysLine } from "./system";
import type { SystemNote } from "./types";

export const clock = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export const fullDate = (iso: string) => new Date(iso).toLocaleString("uk-UA", { dateStyle: "medium", timeStyle: "short" });

export const secs = (ms?: number | null) => {
  if (ms == null) return "";
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} с` : `${Math.floor(s / 60)} хв ${String(s % 60).padStart(2, "0")} с`;
};

export { names, plural } from "./i18n/uk";

export const ago = (iso: string) => {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "щойно";
  if (diff < 3600) return `${Math.floor(diff / 60)} хв`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} год`;
  return new Date(iso).toLocaleDateString("uk-UA", { day: "numeric", month: "short" });
};

export const shortPath = (path: string) => {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
};

export const baseName = (path: string) => path.split("/").pop() || path;

export const ext = (path: string) => {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

export const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico"]);
export const FRAME_EXT = new Set(["html", "htm", "pdf"]);
export const VIDEO_EXT = new Set(["mp4", "webm", "mov"]);
export const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "m4a"]);
export const TABLE_EXT = new Set(["csv", "tsv"]);
export const DIAGRAM_EXT = new Set(["mmd", "mermaid"]);
/** Files that are worth seeing, not just opening: shown under the turn that made them. */
export const VISUAL_EXT = new Set([...IMAGE_EXT, ...FRAME_EXT, ...VIDEO_EXT, ...AUDIO_EXT, ...TABLE_EXT, ...DIAGRAM_EXT]);
export const PROSE_EXT = new Set(["md", "markdown", "txt", ""]);

export const cost = (usd?: number) => (usd == null ? "" : `$${usd < 0.1 ? usd.toFixed(3) : usd.toFixed(2)}`);

export const kb = (bytes: number) => (bytes < 1024 ? `${bytes} Б` : `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} КБ`);

/** cyrb53 — must match the daemon's block hash for live html/svg blocks. */
export const hashBlock = (text: string) => {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
};

/** A link target inside the room's workspace, as a relative path; null for anything else. */
export const workspaceRel = (path: string | undefined, workspace: string | undefined) => {
  // ~/ is the home folder, never a folder named "~" in the workspace.
  if (!workspace || !path || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("#") || path.startsWith("~/")) return null;
  let rel = path;
  if (rel.startsWith("/")) {
    if (!rel.startsWith(`${workspace}/`)) return null;
    rel = rel.slice(workspace.length + 1);
  }
  rel = rel.replace(/^\.\//, "");
  if (!rel || rel.split("/").includes("..")) return null;
  return rel;
};

export const passNote = (text: string) => {
  const t = text.trim();
  if (!t || /^::pass::$/i.test(t)) return "";
  return text.replace(/^[`"'*_\s]*::pass::[`"'*_\s.:—–-]*/i, "").trim();
};

type Last = { author: string; text: string; label?: string; sys?: SystemNote };

/** The last line in a room list, in parts: who said it (by label — any agent, not only Claude and Codex) and a preview. */
export const roomPreviewParts = (last: Last | undefined): { who: string; text: string } => {
  if (!last) return { who: "", text: "Ще без повідомлень" };
  // A line Agoryx wrote (a decision) in the UI's words; an older decision by its English.
  const said = last.sys ? sysLine(last) : decisionOf(last) ? sysLine(last) : last.text;
  return { who: last.label ?? (last.author === "agoryx" ? "" : "Ви"), text: preview(said) };
};

export const roomPreview = (last: Last | undefined) => {
  const { who, text } = roomPreviewParts(last);
  return `${who ? `${who}: ` : ""}${text}`;
};

/**
 * Markdown's marks out and nothing else: headings, quotes, table bars, and emphasis, code or strike marks only
 * where they come in pairs, so `test_calc.py`, `a * b` and `x > 0` read as written.
 */
export const unmark = (text: string) =>
  text
    .replace(/^[ \t]{0,3}(?:#{1,6}|>+)[ \t]?/gm, "")
    .replace(/^[ \t]*\|[ \t:|-]*-[ \t:|-]*\|[ \t]*$/gm, "")
    .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, row: string) => row.replace(/\|/g, " "))
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/(^|[\s(«"'])(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\2(?=[\s).,!?:;»"']|$)/gm, "$1$3")
    .replace(/(^|[\s(«"'])([*_])(?=\S)(.+?)(?<=\S)\2(?=[\s).,!?:;»"']|$)/gm, "$1$3");

/** Plain one-line preview of a markdown message. */
export const preview = (text: string) =>
  unmark(
    text
      .replace(/```[\s\S]*?(```|$)/g, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"),
  )
    .replace(/\s+/g, " ")
    .trim();
