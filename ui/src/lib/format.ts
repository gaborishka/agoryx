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

const OPEN_ITEMS: Array<[RegExp, (n: number) => string]> = [
  [/^(\d+) open questions?$/, (n) => plural(n, "питання", "питання", "питань")],
  [/^(\d+) undecided proposals?$/, (n) => plural(n, "пропозиція без рішення", "пропозиції без рішення", "пропозицій без рішення")],
  [/^(\d+) steps? to do$/, (n) => plural(n, "крок до виконання", "кроки до виконання", "кроків до виконання")],
];

/** "1 open question, 2 steps to do" → "1 питання, 2 кроки до виконання". */
const openItems = (list: string) =>
  list
    .split(", ")
    .map((item) => {
      for (const [pattern, say] of OPEN_ITEMS) {
        const m = pattern.exec(item);
        if (m) return say(Number(m[1]));
      }
      return item;
    })
    .join(", ");

const SYS_TEXT: Array<[RegExp, (...m: string[]) => string]> = [
  [
    /^Turn budget reached \((\d+) agent turns\)\.(?: Still open on the table: (.+?) —)?.*$/s,
    (_, n, open) => `Агенти зробили ${plural(Number(n), "хід", "ходи", "ходів")} — розмова чекає на вас.${open ? ` На столі ще відкрито: ${openItems(open)}.` : ""}`,
  ],
  [/^Agoryx restarted in the middle of a run.*$/s, () => "Agoryx перезапустився посеред розмови, тож її зупинено. Напишіть щось або натисніть «Продовжити»."],
  [/^The room's canonical file is now (.+)\.$/, (_, path) => `Спільний документ кімнати тепер — \`${path}\`.`],
  [/^The room no longer has a canonical file\.$/, () => "У кімнати більше немає спільного документа."],
  [/^(.+) stopped the run\.$/, () => "Розмову зупинено."],
  [/^(.+) asked for another round\.$/, (_, who) => `${who} просить ще один раунд.`],
  [/^(.+) stopped the daemon, so the run was stopped\.$/, (_, who) => `${who} зупиняє Agoryx, тож розмову зупинено.`],
  [/^(.+?) changed the settings: (.+)\.$/s, (_, who, what) => `${who} змінює налаштування: ${settingsText(what)}.`],
  [/^(.+?) renamed the room to "(.+)"\.$/s, (_, who, name) => `${who} перейменовує кімнату на «${name}».`],
  [/^(.+?) could not finish its turn: (.*)$/s, (_, who, why) => `${who}: хід не вдалося завершити — ${why}`],
  [/^(.+?) is busy in its own session.*$/s, (_, who) => `${who} зараз говорить у своїй сесії — хід у кімнаті почнеться після цього.`],
];

/** What an agent's settings change says ("budget 5 turns per run, network off", see describeSettings), in Ukrainian. */
const SETTING_TEXT: Array<[RegExp, (...m: string[]) => string]> = [
  [/^budget (\d+) turns per run$/, (_, n) => `ліміт ${plural(Number(n), "хід", "ходи", "ходів")} на розмову`],
  [/^no turn budget$/, () => "без ліміту ходів"],
  [/^access workspace$/, () => "агенти можуть редагувати теку"],
  [/^access readonly$/, () => "лише читання"],
  [/^network (on|off)$/, (_, v) => `мережа ${v === "on" ? "увімкнена" : "вимкнена"}`],
  [/^autocommit (on|off)$/, (_, v) => `автокоміти ${v === "on" ? "увімкнені" : "вимкнені"}`],
  [/^turn limit (\d+) min$/, (_, n) => `ліміт ходу ${n} хв`],
  [/^canonical file (.+)$/, (_, path) => `спільний документ \`${path}\``],
  [/^no canonical file$/, () => "без спільного документа"],
];

const settingsText = (what: string) =>
  what
    .split(", ")
    .map((item) => {
      for (const [pattern, say] of SETTING_TEXT) {
        const m = pattern.exec(item);
        if (m) return say(...m);
      }
      return item;
    })
    .join(", ");

/**
 * A system line in Ukrainian. `who`: how the UI names the one who did it, when an agent did (its own
 * or another room's): the line says so by that name, and "stopped the run" is no longer anonymous.
 */
export const sysText = (text: string, who?: string) => {
  if (who) {
    const stopped = /^(.+) stopped the run\.$/.exec(text);
    if (stopped) return `${who} зупиняє розмову.`;
    const round = /^(.+) asked for another round\.$/.exec(text);
    if (round) return `${who} просить ще один раунд.`;
  }
  for (const [pattern, say] of SYS_TEXT) {
    const m = pattern.exec(text);
    if (m) return who && m.length > 1 ? say(m[0]!, who, ...m.slice(2)) : say(...m);
  }
  return text;
};

export const isSysError = (text: string) => /error|failed|could not finish|timed out|rate limit/i.test(text);

export const passNote = (text: string) => {
  const t = text.trim();
  if (!t || /^::pass::$/i.test(t)) return "";
  return text.replace(/^[`"'*_\s]*::pass::[`"'*_\s.:—–-]*/i, "").trim();
};

/** "Claude", "Claude і Codex", "Opus, Sonnet і Codex": a room may seat any number of agents. */
export const names = (list: string[]) => (list.length <= 1 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} і ${list.at(-1)}`);

/** The last line in a room list, in parts: who said it (by label — any agent, not only Claude and Codex) and a preview. */
export const roomPreviewParts = (last: { author: string; text: string; label?: string } | undefined): { who: string; text: string } => {
  if (!last) return { who: "", text: "Ще без повідомлень" };
  return { who: last.label ?? (last.author === "agoryx" ? "" : "Ви"), text: preview(last.text) };
};

export const roomPreview = (last: { author: string; text: string; label?: string } | undefined) => {
  const { who, text } = roomPreviewParts(last);
  return `${who ? `${who}: ` : ""}${text}`;
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
