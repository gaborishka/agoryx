import type { RoomSettings, SystemCode, SystemNote, TurnError } from "../types";

/**
 * The UI's catalogue: every line Agoryx writes (by its code), and the words the UI uses for models, effort
 * and the room's own worktree. The interface speaks one locale, English; the rest of the UI keeps its copy in place.
 */

/** "1 turn", "3 turns". */
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Claude", "Claude and Codex", "Opus, Sonnet and Codex": a room may seat any number of agents. */
export const names = (list: string[]) => (list.length <= 1 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`);

type Note<K extends SystemCode> = Extract<SystemNote, { code: K }>;
/** `who`: the name the UI gives the agent that did it, when an agent wrote the line; the note's own `by` otherwise. */
type Say = { [K in SystemCode]: (note: Note<K>, who?: string) => string };

const EFFORT: Record<string, string> = {
  none: "no thinking",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "extra high",
  max: "max",
};

/** An effort level in words; one the catalogue does not know stays as the CLI names it. */
const effortLevel = (level: string) => EFFORT[level] ?? level;

const onOff = (on: boolean) => (on ? "on" : "off");

/** A settings change in words, in the order the daemon lists it. */
const settings = (patch: Partial<RoomSettings>): string =>
  [
    patch.budget === undefined ? null : patch.budget === null ? "no turn limit" : `a limit of ${plural(patch.budget, "turn", "turns")} per conversation`,
    patch.access === undefined ? null : patch.access === "readonly" ? "read-only" : "agents can edit the folder",
    patch.network === undefined ? null : `network ${onOff(patch.network)}`,
    patch.autoCommit === undefined ? null : `checkpoints ${onOff(patch.autoCommit)}`,
    patch.turnTimeoutMs === undefined ? null : `turn time limit ${Math.round(patch.turnTimeoutMs / 60_000)} min`,
    patch.doc === undefined ? null : patch.doc ? `shared document \`${patch.doc}\`` : "no shared document",
  ]
    .filter(Boolean)
    .join(", ");

const openOnTable = (open: Note<"run.budget">["open"]): string =>
  [
    open.questions ? plural(open.questions, "question", "questions") : null,
    open.options ? plural(open.options, "undecided option", "undecided options") : null,
    open.steps ? plural(open.steps, "step to do", "steps to do") : null,
    open.disputes ? plural(open.disputes, "disputed point", "disputed points") : null,
  ]
    .filter(Boolean)
    .join(", ");

/** What went wrong with a turn, and what to do about it; the CLI's own message stays as it said it. */
const failure = (error: TurnError["kind"], message: string, cli: string): string => {
  const minutes = error === "timeout" ? /(\d+)\s*min/.exec(message)?.[1] : undefined;
  if (minutes) return `the turn ran past its time limit (${minutes} min)`;
  const hint =
    error === "rate_limit"
      ? " (rate limit — it will try again with the next message)"
      : error === "auth"
        ? ` (not signed in — run \`${cli} login\`)`
        : error === "spawn"
          ? ` (is \`${cli}\` installed and on your PATH?)`
          : "";
  return `${message}${hint}`;
};

/** "14:21", the viewer's local time. */
const clock = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

const shares = (readers: Array<{ label: string; percent: number }>) => readers.map((r) => `${r.label} ${r.percent}%`).join(", ");

const sys: Say = {
  "run.restarted": () => "Agoryx restarted mid-conversation, so it was stopped. Write something or press “Continue”.",
  "run.budget": (n) => {
    const open = openOnTable(n.open);
    return `The agents took ${plural(n.turns, "turn", "turns")} — the conversation is waiting for you.${open ? ` Still open on the table: ${open}.` : ""}`;
  },
  "run.stopped": (_, who) => (who ? `${who} stops the conversation.` : "The conversation was stopped."),
  "run.continued": (n, who) => `${who ?? n.by} asks for another round.`,
  "daemon.stopped": (n, who) => `${who ?? n.by} stops Agoryx, so the conversation was stopped.`,
  "doc.set": (n) => `The room’s shared document is now \`${n.path}\`.`,
  "doc.cleared": () => "The room no longer has a shared document.",
  "settings.changed": (n, who) => `${who ?? n.by} changes the settings: ${settings(n.patch)}.`,
  "room.renamed": (n, who) => `${who ?? n.by} renames the room to “${n.name}”.`,
  "agent.changed": (n, who) => {
    const parts = [
      n.model === undefined ? null : n.model ? `model \`${n.model}\`` : "model — the CLI default",
      n.effort === undefined ? null : `effort — ${n.effort ? effortLevel(n.effort) : "the CLI default"}`,
    ].filter(Boolean);
    return `${who ?? n.by} changes ${n.agent}: ${parts.join(", ")}.`;
  },
  "agent.set": (n, who) => {
    const name = n.label ?? n.agent;
    const parts = [
      n.label === undefined ? null : `renames ${n.agent} to ${n.label}`,
      n.role === undefined ? null : n.role ? `gives ${name} a role: “${n.role}”` : `takes the role away from ${name} — it acts as itself again`,
      n.profile === undefined ? null : n.profile ? `gives ${name} their profile` : `stops giving ${name} their profile`,
    ].filter(Boolean);
    return `${who ?? n.by} ${parts.join("; ")}.`;
  },
  "agent.added": (n, who) => {
    // "Codex (Codex)" says nothing: the CLI only when the name does not say it.
    const cli = n.cli === "codex" ? "Codex" : "Claude Code";
    const about = [n.agent.startsWith(n.cli === "codex" ? "Codex" : "Claude") ? null : cli, n.model ? `model \`${n.model}\`` : null].filter(Boolean).join(", ");
    return `${who ?? n.by} adds ${n.agent} to the room${about ? ` (${about})` : ""}${n.role ? ` with the role: “${n.role}”` : ""}. It reads the conversation and answers from the next message.`;
  },
  "agent.removed": (n, who) => `${who ?? n.by} removes ${n.agent} from the room. Its messages stay.`,
  "turn.failed": (n) => `${n.agent}: the turn could not finish — ${failure(n.error, n.message, n.cli)}`,
  "agent.busy": (n) => `${n.agent} is talking in its own session right now — its turn in the room starts after that.`,
  "agent.compacted": (n) => `${n.agent}’s context was compacted at ${clock(n.at)}.`,
  "jev.second_look": (n) => {
    const who = names(n.readers.map((r) => r.label));
    return `Jev: ${n.agent}’s reply is worth a second look (${shares(n.readers)}) — ${who} ${n.readers.length === 1 ? "takes a look" : "take a look"}.`;
  },
  "jev.meant_for": (n) => {
    const who = names(n.readers.map((r) => r.label));
    return `Jev: ${n.message} from ${n.agent} is meant for ${who} (${shares(n.readers)}), even without an @ — ${who} ${n.readers.length === 1 ? "replies" : "reply"}.`;
  },
  decision: (n) => `Decision #${n.n}: ${n.option} “${n.title}”${n.note ? ` — ${n.note}` : ""} (decided by ${n.by})`,
  "pr.checks": (n) =>
    n.result === "pass"
      ? `PR #${n.n}: ${n.total === 1 ? "the check" : `all ${n.total} checks`} passed.`
      : `PR #${n.n}: ${n.failed?.length ?? 0} of ${plural(n.total, "check", "checks")} failed${n.failed?.length ? ` — ${n.failed.join(", ")}` : ""}.`,
  "pr.review": (n) => (n.review === "approved" ? `PR #${n.n} approved${n.by ? ` by ${n.by}` : ""}.` : `PR #${n.n}: changes requested${n.by ? ` by ${n.by}` : ""}.`),
  "pr.merged": (n) => `PR #${n.n} merged into \`${n.base}\`${n.by ? ` by ${n.by}` : ""}.`,
  "pr.closed": (n) => `PR #${n.n} closed without merging.`,
  "pr.reopened": (n) => `PR #${n.n} reopened.`,
  "git.force_pushed": (n) =>
    n.rewrote === false
      ? `${n.agent} pushed with force${n.refs?.length ? ` to ${n.refs.map((ref) => `\`${ref}\``).join(", ")}` : " to its remote"}${n.failed ? `, or tried to (${n.failed === "command" ? "the command failed" : "git printed an error"}; git did not say whether it rewrote history)` : " (git did not say whether it rewrote history)"}: \`${n.command}\``
      : `${n.agent} force-pushed, rewriting the history of ${n.refs?.length ? n.refs.map((ref) => `\`${ref}\``).join(", ") : "the remote branch"}: \`${n.command}\``,
};

export const en = {
  plural,
  names,
  sys,
  /** The decision card: its heading, the option chosen, who decided, and the reasons behind a toggle. */
  decision: {
    title: (n?: number) => (n ? `Decision #${n}` : "Decision"),
    body: (n: Note<"decision">) => `${n.option} “${n.title}”${n.note ? ` — ${n.note}` : ""}`,
    by: (by: string) => `decided by ${by}`,
    why: "Why",
  },
  /** Effort: how hard the model thinks (Claude's --effort, Codex's reasoning effort). */
  effort: {
    name: "Effort",
    hint: "Effort — how carefully the model thinks",
    level: effortLevel,
    default: "default",
    defaultIs: (level?: string) => `Default${level ? `: ${effortLevel(level)}` : ""}`,
  },
  model: {
    and: "model and effort",
    of: (agent: string) => `${agent} model and effort`,
  },
  /** The room's own worktree: its own branch and folder that the agents share. */
  worktree: {
    label: "worktree",
    from: "Branch the room’s worktree starts from",
    fromMenu: "Start the worktree from a branch",
    about: "Its own branch and folder for this room. The agents work in it together; your folder and branch stay as they are.",
    noCommits: "The repository has no commits yet — there is nothing to start a worktree from",
    dirty: (n: number, folder: string, branch?: string | null) =>
      `${plural(n, "uncommitted change", "uncommitted changes")} in ${folder} won’t go into the worktree: it starts from the last commit${branch ? ` on ${branch}` : ""}.`,
    place: (branch: string, base: string, folder: string, agents: string[], source: string) =>
      `The room’s worktree: branch ${branch} from ${base}, folder ${folder}. ${names(agents)} work in it together; ${source} stays as it is.`,
  },
  checkpoint: {
    one: "One recovery snapshot",
    none: "They appear after agents change files, without adding commits to your branch.",
    setting: "Recovery snapshots after file changes",
  },
  loading: "Loading",
};

export type Catalogue = typeof en;
