import { t } from "./i18n";
import type { AgentKind, RoomSettings, SystemCode, SystemNote, TurnError } from "./types";

/**
 * The lines Agoryx writes, in the UI's words. The daemon attaches a code and its params (message.sys) and the
 * catalogue says it; a room from before codes has only the English, read back here into the same note.
 */

type Line = { text: string; sys?: SystemNote };

/** Codes that mean something went wrong: the line is shown as an error. */
const ERRORS = new Set<SystemCode>(["turn.failed"]);

const say = (note: SystemNote, who?: string): string => (t.sys[note.code] as (note: SystemNote, who?: string) => string)(note, who);

/** What a line means: its code, or for an older room what its English says (null when it says nothing known). */
export const noteOf = (m: Line): SystemNote | null => m.sys ?? legacyNote(m.text);

/** A system line in the UI's words. `who`: the name the UI gives the agent that wrote it, when one did. */
export const sysLine = (m: Line, who?: string): string => {
  const note = noteOf(m);
  return note ? say(note, who) : m.text;
};

/** Codes for a risky step someone took: the line stands out, short of an error. */
const RISKS = new Set<SystemCode>(["git.force_pushed"]);

/** Whether a system line reports a risky step (see RISKS). */
export const sysRisk = (m: Line): boolean => {
  const note = noteOf(m);
  return Boolean(note && RISKS.has(note.code));
};

/** Whether a system line reports a failure: by its code; an older line nobody can read, by its words. */
export const sysError = (m: Line): boolean => {
  const note = noteOf(m);
  return note ? ERRORS.has(note.code) : /error|failed|could not finish|timed out|rate limit/i.test(m.text);
};

/** A decision's line, from its code or the English of an older room; null when the text is not one. */
export const decisionOf = (m: Line): Extract<SystemNote, { code: "decision" }> | null => {
  const note = noteOf(m);
  return note?.code === "decision" ? note : null;
};

// --- rooms from before codes: the daemon's English, read back -------------------------------------------------

const OPEN: Array<[RegExp, keyof Extract<SystemNote, { code: "run.budget" }>["open"]]> = [
  [/^(\d+) open questions?$/, "questions"],
  [/^(\d+) undecided proposals?$/, "options"],
  [/^(\d+) steps? to do$/, "steps"],
  [/^(\d+) contested points?$/, "disputes"],
];

/** "1 open question, 2 steps to do" → counts. */
const openItems = (list: string | undefined) => {
  const open = { questions: 0, options: 0, steps: 0, disputes: 0 };
  for (const item of list ? list.split(", ") : []) {
    for (const [pattern, key] of OPEN) {
      const m = pattern.exec(item);
      if (m) open[key] = Number(m[1]);
    }
  }
  return open;
};

/** "budget 5 turns per run, network off" (describeSettings) → the patch; null when an item is not one of them. */
const settingsPatch = (list: string): Partial<RoomSettings> | null => {
  const patch: Partial<RoomSettings> = {};
  for (const item of list.split(", ")) {
    let m: RegExpExecArray | null;
    if ((m = /^budget (\d+) turns per run$/.exec(item))) patch.budget = Number(m[1]);
    else if (item === "no turn budget") patch.budget = null;
    else if ((m = /^access (workspace|readonly)$/.exec(item))) patch.access = m[1] as RoomSettings["access"];
    else if ((m = /^network (on|off)$/.exec(item))) patch.network = m[1] === "on";
    else if ((m = /^autocommit (on|off)$/.exec(item))) patch.autoCommit = m[1] === "on";
    else if ((m = /^turn limit (\d+) min$/.exec(item))) patch.turnTimeoutMs = Number(m[1]) * 60_000;
    else if ((m = /^canonical file (.+)$/.exec(item))) patch.doc = m[1]!;
    else if (item === "no canonical file") patch.doc = null;
    else return null;
  }
  return patch;
};

/** "model opus, effort high" (updateAgent) → the change; null when a part is not one of them. */
const agentChange = (list: string): { model?: string | null; effort?: string | null } | null => {
  const change: { model?: string | null; effort?: string | null } = {};
  for (const part of list.split(", ")) {
    let m: RegExpExecArray | null;
    if (part === "the CLI's default model") change.model = null;
    else if (part === "the CLI's default effort") change.effort = null;
    else if ((m = /^model (\S+)$/.exec(part))) change.model = m[1]!;
    else if ((m = /^effort (\S+)$/.exec(part))) change.effort = m[1]!;
    else return null;
  }
  return change;
};

/** "Codex 72%, Claude 64%" → who and how sure. */
const shares = (list: string) =>
  list.split(", ").flatMap((part) => {
    const m = /^(.+) (\d+)%$/.exec(part);
    return m ? [{ label: m[1]!, percent: Number(m[2]) }] : [];
  });

/** Why a turn failed, from the hint the daemon added; the CLI's own message without it. */
const failed = (agent: string, said: string): SystemNote => {
  let m: RegExpExecArray | null;
  let error: TurnError["kind"] = "unknown";
  // Only a hint names the CLI, and only those hints use it.
  let cli: AgentKind = "claude";
  let message = said;
  if ((m = /^(.*) \(rate limit — it will retry on the next message\)$/s.exec(said))) [error, message] = ["rate_limit", m[1]!];
  else if ((m = /^(.*) \(not logged in — run `(claude|codex) login`\)$/s.exec(said))) [error, message, cli] = ["auth", m[1]!, m[2] as AgentKind];
  else if ((m = /^(.*) \(is `(claude|codex)` installed and on PATH\?\)$/s.exec(said))) [error, message, cli] = ["spawn", m[1]!, m[2] as AgentKind];
  else if (/^turn exceeded \d+ min$/.test(said)) error = "timeout";
  return { code: "turn.failed", agent, cli, error, message };
};

const LEGACY: Array<[RegExp, (...m: string[]) => SystemNote | null]> = [
  [/^Turn budget reached \((\d+) agent turns\)\.(?: Still open on the table: (.+?) —)?.*$/s, (_, n, open) => ({ code: "run.budget", turns: Number(n), open: openItems(open) })],
  [/^Agoryx restarted in the middle of a run.*$/s, () => ({ code: "run.restarted" })],
  [/^The room's canonical file is now (.+)\.$/s, (_, path) => ({ code: "doc.set", path: path! })],
  [/^The room no longer has a canonical file\.$/, () => ({ code: "doc.cleared" })],
  [/^(.+) stopped the daemon, so the run was stopped\.$/s, (_, by) => ({ code: "daemon.stopped", by: by! })],
  [/^(.+) stopped the run\.$/s, (_, by) => ({ code: "run.stopped", by: by! })],
  [/^(.+) asked for another round\.$/s, (_, by) => ({ code: "run.continued", by: by! })],
  [
    /^(.+?) changed the settings: (.+)\.$/s,
    (_, by, list) => {
      const patch = settingsPatch(list!);
      return patch ? { code: "settings.changed", by: by!, patch } : null;
    },
  ],
  [/^(.+?) renamed the room to "(.+)"\.$/s, (_, by, name) => ({ code: "room.renamed", by: by!, name: name! })],
  [/^(.+?) could not finish its turn: (.*)$/s, (_, agent, said) => failed(agent!, said!)],
  [/^(.+?) is busy in its own session.*$/s, (_, agent) => ({ code: "agent.busy", agent: agent! })],
  [
    /^Jev: a second look at (.+?)'s answer seems worth a turn \((.+?)\) — .*$/s,
    (_, agent, list) => ({ code: "jev.second_look", agent: agent!, readers: shares(list!) }),
  ],
  [
    /^Jev: (.+?)'s (m\d+) reads as meant for .+? \((.+?)\), with no @.*$/s,
    (_, agent, message, list) => ({ code: "jev.meant_for", agent: agent!, message: message!, readers: shares(list!) }),
  ],
  [
    /^Decision №(\d+): (\S+) «(.*)»(?: — (.*))? \(decided by (.+)\)$/s,
    (_, n, option, title, note, by) => ({ code: "decision", n: Number(n), option: option!, title: title!, ...(note ? { note } : {}), by: by! }),
  ],
  // Last: it reads any "X set Y to Z." — only as an agent change when every part is one.
  [
    /^(.+?) set (.+?) to (.+)\.$/s,
    (_, by, agent, list) => {
      const change = agentChange(list!);
      return change ? { code: "agent.changed", by: by!, agent: agent!, ...change } : null;
    },
  ],
];

/** The note an older room's English line stands for; null for a line no code covers (shown as written). */
export const legacyNote = (text: string): SystemNote | null => {
  for (const [pattern, read] of LEGACY) {
    const m = pattern.exec(text);
    if (m) {
      const note = read(...m);
      if (note) return note;
    }
  }
  return null;
};
