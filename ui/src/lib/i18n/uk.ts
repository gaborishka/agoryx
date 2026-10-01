import type { RoomSettings, SystemCode, SystemNote, TurnError } from "../types";

/**
 * The Ukrainian catalogue: every line Agoryx writes (by its code), and the words the UI uses for models, effort
 * and the room's own worktree. Another locale is another module of the same shape (Catalogue, in ./index).
 * Only strings moved here so far live here; the rest of the UI still says its Ukrainian in place.
 */

/** "1 хід", "3 ходи", "5 ходів". */
export const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} ${one}`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
};

/** "Claude", "Claude і Codex", "Opus, Sonnet і Codex": a room may seat any number of agents. */
export const names = (list: string[]) => (list.length <= 1 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} і ${list.at(-1)}`);

type Note<K extends SystemCode> = Extract<SystemNote, { code: K }>;
/** `who`: the name the UI gives the agent that did it, when an agent wrote the line; the note's own `by` otherwise. */
type Say = { [K in SystemCode]: (note: Note<K>, who?: string) => string };

const EFFORT: Record<string, string> = {
  none: "без роздумів",
  minimal: "мінімальна",
  low: "низька",
  medium: "середня",
  high: "висока",
  xhigh: "дуже висока",
  max: "максимальна",
};

/** An effort level in words; one the catalogue does not know stays as the CLI names it. */
const effortLevel = (level: string) => EFFORT[level] ?? level;

const onOff = (on: boolean, many = false) => (on ? (many ? "увімкнені" : "увімкнена") : many ? "вимкнені" : "вимкнена");

/** A settings change in words, in the order the daemon lists it. */
const settings = (patch: Partial<RoomSettings>): string =>
  [
    patch.budget === undefined ? null : patch.budget === null ? "без ліміту ходів" : `ліміт ${plural(patch.budget, "хід", "ходи", "ходів")} на розмову`,
    patch.access === undefined ? null : patch.access === "readonly" ? "лише читання" : "агенти можуть редагувати теку",
    patch.network === undefined ? null : `мережа ${onOff(patch.network)}`,
    patch.autoCommit === undefined ? null : `контрольні точки ${onOff(patch.autoCommit, true)}`,
    patch.turnTimeoutMs === undefined ? null : `ліміт ходу ${Math.round(patch.turnTimeoutMs / 60_000)} хв`,
    patch.doc === undefined ? null : patch.doc ? `спільний документ \`${patch.doc}\`` : "без спільного документа",
  ]
    .filter(Boolean)
    .join(", ");

const openOnTable = (open: Note<"run.budget">["open"]): string =>
  [
    open.questions ? plural(open.questions, "питання", "питання", "питань") : null,
    open.options ? plural(open.options, "пропозиція без рішення", "пропозиції без рішення", "пропозицій без рішення") : null,
    open.steps ? plural(open.steps, "крок до виконання", "кроки до виконання", "кроків до виконання") : null,
    open.disputes ? plural(open.disputes, "спірний пункт", "спірні пункти", "спірних пунктів") : null,
  ]
    .filter(Boolean)
    .join(", ");

/** What went wrong with a turn, and what to do about it; the CLI's own message stays as it said it. */
const failure = (error: TurnError["kind"], message: string, cli: string): string => {
  const minutes = error === "timeout" ? /(\d+)\s*min/.exec(message)?.[1] : undefined;
  if (minutes) return `хід довший за ліміт (${minutes} хв)`;
  const hint =
    error === "rate_limit"
      ? " (ліміт запитів — спробує знову з наступним повідомленням)"
      : error === "auth"
        ? ` (немає входу — виконайте \`${cli} login\`)`
        : error === "spawn"
          ? ` (чи встановлено \`${cli}\` і чи є він у PATH?)`
          : "";
  return `${message}${hint}`;
};

const shares = (readers: Array<{ label: string; percent: number }>) => readers.map((r) => `${r.label} ${r.percent}%`).join(", ");

const sys: Say = {
  "run.restarted": () => "Agoryx перезапустився посеред розмови, тож її зупинено. Напишіть щось або натисніть «Продовжити».",
  "run.budget": (n) => {
    const open = openOnTable(n.open);
    return `Агенти зробили ${plural(n.turns, "хід", "ходи", "ходів")} — розмова чекає на вас.${open ? ` На столі ще відкрито: ${open}.` : ""}`;
  },
  "run.stopped": (_, who) => (who ? `${who} зупиняє розмову.` : "Розмову зупинено."),
  "run.continued": (n, who) => `${who ?? n.by} просить ще один раунд.`,
  "daemon.stopped": (n, who) => `${who ?? n.by} зупиняє Agoryx, тож розмову зупинено.`,
  "doc.set": (n) => `Спільний документ кімнати тепер — \`${n.path}\`.`,
  "doc.cleared": () => "У кімнати більше немає спільного документа.",
  "settings.changed": (n, who) => `${who ?? n.by} змінює налаштування: ${settings(n.patch)}.`,
  "room.renamed": (n, who) => `${who ?? n.by} перейменовує кімнату на «${n.name}».`,
  "agent.changed": (n, who) => {
    const parts = [
      n.model === undefined ? null : n.model ? `модель \`${n.model}\`` : "модель — типова з CLI",
      n.effort === undefined ? null : `глибина — ${n.effort ? effortLevel(n.effort) : "типова з CLI"}`,
    ].filter(Boolean);
    return `${who ?? n.by} змінює ${n.agent}: ${parts.join(", ")}.`;
  },
  "agent.set": (n, who) => {
    const name = n.label ?? n.agent;
    const parts = [
      n.label === undefined ? null : `перейменовує ${n.agent} на ${n.label}`,
      n.role === undefined ? null : n.role ? `дає ${name} роль: «${n.role}»` : `знімає з ${name} роль — тепер діє як сам`,
      n.profile === undefined ? null : n.profile ? `дає ${name} свій профіль` : `більше не дає ${name} свій профіль`,
    ].filter(Boolean);
    return `${who ?? n.by} ${parts.join("; ")}.`;
  },
  "agent.added": (n, who) => {
    // "Codex (Codex)" says nothing: the CLI only when the name does not say it.
    const cli = n.cli === "codex" ? "Codex" : "Claude Code";
    const about = [n.agent.startsWith(n.cli === "codex" ? "Codex" : "Claude") ? null : cli, n.model ? `модель \`${n.model}\`` : null].filter(Boolean).join(", ");
    return `${who ?? n.by} додає до кімнати ${n.agent}${about ? ` (${about})` : ""}${n.role ? ` з роллю: «${n.role}»` : ""}. Він прочитає розмову й відповідатиме з наступного повідомлення.`;
  },
  "agent.removed": (n, who) => `${who ?? n.by} прибирає ${n.agent} з кімнати. Його повідомлення лишаються.`,
  "turn.failed": (n) => `${n.agent}: хід не вдалося завершити — ${failure(n.error, n.message, n.cli)}`,
  "agent.busy": (n) => `${n.agent} зараз говорить у своїй сесії — хід у кімнаті почнеться після цього.`,
  "jev.second_look": (n) => {
    const who = names(n.readers.map((r) => r.label));
    return `Jev: відповідь ${n.agent} варто переглянути ще раз (${shares(n.readers)}) — ${who} ${n.readers.length === 1 ? "дивиться" : "дивляться"}.`;
  },
  "jev.meant_for": (n) => {
    const who = names(n.readers.map((r) => r.label));
    return `Jev: ${n.message} від ${n.agent} звернене до ${who} (${shares(n.readers)}), хоч і без @ — ${who} ${n.readers.length === 1 ? "відповідає" : "відповідають"}.`;
  },
  decision: (n) => `Рішення №${n.n}: ${n.option} «${n.title}»${n.note ? ` — ${n.note}` : ""} (вирішує ${n.by})`,
};

export const uk = {
  plural,
  names,
  sys,
  /** The decision card: its heading, the option chosen, who decided. */
  decision: {
    title: (n?: number) => (n ? `Рішення №${n}` : "Рішення"),
    body: (n: Note<"decision">) => `${n.option} «${n.title}»${n.note ? ` — ${n.note}` : ""}`,
    by: (by: string) => `вирішує ${by}`,
  },
  /** Effort: how hard the model thinks (Claude's --effort, Codex's reasoning effort). */
  effort: {
    name: "Глибина",
    hint: "Глибина — наскільки ретельно модель думає",
    level: effortLevel,
    default: "типова",
    defaultIs: (level?: string) => `Типова${level ? `: ${effortLevel(level)}` : ""}`,
  },
  model: {
    and: "модель і глибина",
    of: (agent: string) => `Модель і глибина ${agent}`,
  },
  /** The room's own worktree: its own branch and folder that the agents share. */
  worktree: {
    label: "окрема копія",
    from: "Гілка, від якої почнеться окрема копія кімнати",
    fromMenu: "Почати окрему копію від гілки",
    about: "Окрема гілка й окрема тека для цієї кімнати. Агенти працюють у ній разом, а ваша тека й гілка лишаються як є.",
    noCommits: "У репозиторії ще немає комітів — окрему копію нема від чого почати",
    dirty: (n: number, folder: string, branch?: string | null) =>
      `${plural(n, "незакомічена зміна", "незакомічені зміни", "незакомічених змін")} у ${folder} не потраплять в окрему копію: вона почнеться з останнього коміту${branch ? ` ${branch}` : ""}.`,
    place: (branch: string, base: string, folder: string, agents: string[], source: string) =>
      `Окрема копія кімнати: гілка ${branch} від ${base}, тека ${folder}. ${names(agents)} працюють у ній разом; ${source} лишається як є.`,
  },
  checkpoint: {
    one: "Одна контрольна точка (коміт у git)",
    none: "Вони з'являються після раунду, якщо в налаштуваннях увімкнено контрольні точки.",
    setting: "Контрольна точка (коміт у git) після кожного раунду",
  },
  loading: "Завантаження",
};

export type Catalogue = typeof uk;
