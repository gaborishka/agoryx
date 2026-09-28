// Small formatting helpers shared by the whole UI (Ukrainian copy).

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

/** "1 хід", "3 ходи", "5 ходів". */
export const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} ${one}`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
};

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
  if (!workspace || !path || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("#")) return null;
  let rel = path;
  if (rel.startsWith("/")) {
    if (!rel.startsWith(`${workspace}/`)) return null;
    rel = rel.slice(workspace.length + 1);
  }
  rel = rel.replace(/^\.\//, "").split(/[?#]/)[0] ?? "";
  if (!rel || rel.split("/").includes("..")) return null;
  try {
    return decodeURIComponent(rel);
  } catch {
    return rel;
  }
};

const SYS_TEXT: Array<[RegExp, (...m: string[]) => string]> = [
  [/^Turn budget reached \((\d+) agent turns\)\..*$/s, (_, n) => `Агенти зробили ${plural(Number(n), "хід", "ходи", "ходів")} — розмова чекає на вас.`],
  [/^Agoryx restarted in the middle of a run.*$/s, () => "Agoryx перезапустився посеред розмови, тож її зупинено. Напишіть щось або натисніть «Продовжити»."],
  [/^The room's canonical file is now (.+)\.$/, (_, path) => `Спільний документ кімнати тепер — \`${path}\`.`],
  [/^The room no longer has a canonical file\.$/, () => "У кімнати більше немає спільного документа."],
  [/^(.+) stopped the run\.$/, () => "Розмову зупинено."],
  [/^(.+) asked for another round\.$/, (_, who) => `${who} просить ще один раунд.`],
  [/^(.+?) could not finish its turn: (.*)$/s, (_, who, why) => `${who}: хід не вдалося завершити — ${why}`],
  [/^(.+?) is busy in its own session.*$/s, (_, who) => `${who} зараз говорить у своїй сесії — хід у кімнаті почнеться після цього.`],
];

export const sysText = (text: string) => {
  for (const [pattern, say] of SYS_TEXT) {
    const m = pattern.exec(text);
    if (m) return say(...m);
  }
  return text;
};

export const isSysError = (text: string) => /error|failed|could not finish|timed out|rate limit/i.test(text);

export const passNote = (text: string) => {
  const t = text.trim();
  if (!t || /^::pass::$/i.test(t)) return "";
  return text.replace(/^[`"'*_\s]*::pass::[`"'*_\s.:—–-]*/i, "").trim();
};

/** Plain one-line preview of a markdown message. */
export const preview = (text: string) =>
  sysText(text)
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
