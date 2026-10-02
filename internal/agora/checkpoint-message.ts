import type { RoomEvent, TableItem, TurnState } from "./types.js";

/** A step a run worked on: finished during it, or put on the table during it and still to do. */
export type RunStep = Pick<TableItem, "id" | "text" | "by" | "done" | "doneBy" | "commit">;

/** What a line of a commit message must not carry: control characters, line breaks, bidi overrides and isolates. */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The text's first line as one line of a commit message: none of those, at most `max` characters, never half of one. */
const firstLine = (text: string, max: number): string => {
  const line = text.split(/\r\n?|\n/, 1)[0]!.replace(UNSAFE, " ").trim();
  const parts = [...graphemes.segment(line)].map((part) => part.segment);
  return parts.length > max ? `${parts.slice(0, max - 1).join("").trimEnd()}…` : line;
};

/** A step as a commit names it: its id, then its first line, if it has one. */
const stepName = (step: RunStep, max: number): string => {
  const text = firstLine(step.text, max);
  return text ? `${step.id} ${text}` : step.id;
};

/** The room a checkpoint came from, for the end of its body: its name is not the commit's subject. */
export const roomLine = (name: string): string => `Room: ${firstLine(name, 100)}`;

/** At most this many files are listed in a commit's body; the rest are counted. */
const MAX_LISTED = 200;

/** The steps a commit's subject names first — `X1 …`, `X1, X2: …`, `[X1] …` — the ones it says it holds. */
export const stepsInSubject = (subject: string): string[] => {
  const match = /^\s*\[?(X\d+(?:\s*[,+&/]\s*X\d+)*)\]?(?=[\s:.,—-]|$)/.exec(subject);
  return match ? match[1]!.split(/\s*[,+&/]\s*/) : [];
};

/**
 * The steps a run worked on, in the order the run met them, as the table holds them now: those marked done
 * during the run, and those put on it during the run that are still to do. A deleted step is gone from both.
 */
export const runSteps = (events: readonly RoomEvent[], next: readonly TableItem[], since: number): TableItem[] => {
  const ids: string[] = [];
  for (const event of events) {
    if (event.seq <= since || event.type !== "table.op") continue;
    const id = event.op.op === "done" ? event.op.target : event.op.op === "next" ? event.op.id : undefined;
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.flatMap((id) => next.filter((step) => step.id === id));
};

/**
 * A checkpoint's subject: the steps the run finished, or, with none, the run and who changed files in it. A step
 * already committed during the run (`committed`: its id and that commit) went in with that commit, not this one.
 */
export const checkpointSubject = (steps: readonly RunStep[], run: string, agents: readonly string[], committed: ReadonlyMap<string, string> = new Map()): string => {
  const done = steps.filter((step) => step.done && !committed.has(step.id));
  if (done.length === 1) return stepName(done[0]!, 60);
  if (done.length > 1) {
    // As many ids as fit, and always the word that says what they are.
    const ids = done.map((step) => step.id);
    const named = (count: number) => `${ids.slice(0, count).join(", ")}${count < ids.length ? ", …" : ""} done`;
    let count = ids.length;
    while (count > 1 && named(count).length > 60) count -= 1;
    return named(count);
  }
  return `run ${run}${agents.length ? ` by ${agents.join(", ")}` : ""}`;
};

/**
 * A checkpoint's body: the run's steps, and every file the commit holds with the turns of the run that changed it
 * (a file no turn of the run was credited with says so); past the first 200, how many more.
 */
export const checkpointBody = (
  steps: readonly RunStep[],
  files: readonly string[],
  turns: readonly Pick<TurnState, "id" | "agent" | "files">[],
  committed: ReadonlyMap<string, string> = new Map(),
): string =>
  sections([
    ["Steps done:", steps.filter((entry) => entry.done).map((entry) => stepLine(entry, committed.get(entry.id)))],
    ["Steps still to do:", steps.filter((entry) => !entry.done).map((entry) => stepLine(entry))],
    ["Files:", listed(files, (path) => fileLine(path, turns, "no turn of this run"))],
  ]);

/** The body of a step's own commit (the human's button): the step, and every file with the step's turns that changed it. */
export const stepCommitBody = (step: RunStep, files: readonly string[], turns: readonly Pick<TurnState, "id" | "agent" | "files">[]): string =>
  sections([
    ["Step:", [stepLine(step)]],
    ["Files:", listed(files, (path) => fileLine(path, turns, "no turn of this step"))],
  ]);

const stepLine = (entry: RunStep, sha?: string): string =>
  `- ${stepName(entry, 100)} (${entry.done ? `done by ${entry.doneBy ?? entry.by}` : entry.by}${sha ? `; committed as ${sha.slice(0, 8)}` : ""})`;

const fileLine = (path: string, turns: readonly Pick<TurnState, "id" | "agent" | "files">[], none: string): string => {
  const by = turns.filter((turn) => turn.files?.includes(path)).map((turn) => `${turn.id} ${turn.agent}`);
  return `- ${path} (${by.length ? by.join(", ") : none})`;
};

/** The first 200 files, each as `line` says, and how many more. */
const listed = (files: readonly string[], line: (path: string) => string): string[] => [
  ...files.slice(0, MAX_LISTED).map(line),
  ...(files.length > MAX_LISTED ? [`- … and ${files.length - MAX_LISTED} more`] : []),
];

const sections = (list: [string, string[]][]): string =>
  list
    .filter(([, lines]) => lines.length)
    .map(([title, lines]) => [title, ...lines].join("\n"))
    .join("\n\n");
