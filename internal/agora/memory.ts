import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendProjectEvent, projectDir, ProjectError, readProject, type Project, type ProjectWriter } from "./projects.js";
import { disputeOf } from "./table.js";
import type { TableState } from "./types.js";

/**
 * A project's memory: what its rooms decided, found and still disagree about, kept for every Work room in the folder.
 *
 * Nothing goes in by itself. Someone notes an entry, or promotes one from a room's table (S3, F2, D1, Q1) — then the
 * table's own words go in verbatim, with who held them. An open question goes in as a disagreement: every open option
 * with its author and the objections still standing against it. Every entry is someone's claim, never the room's
 * fact, and the index lists disagreements first, so that what is remembered does not settle what is still open.
 *
 * Kept as `memory.*` events in the project's `events.jsonl`; `MEMORY.md` beside it is what they add up to.
 */

export type MemoryKind = "decision" | "fact" | "disagreement" | "person" | "preference";
export const MEMORY_KINDS: readonly MemoryKind[] = ["disagreement", "decision", "fact", "person", "preference"];

/** Someone's words, verbatim. */
export interface MemoryVoice {
  by: string;
  text: string;
}

/** One side of a disagreement: an option, who put it forward, and who still objects to it. */
export interface MemoryPosition {
  /** Its id on the table it came from (P2). */
  ref?: string;
  by: string;
  text: string;
  objections: MemoryVoice[];
}

/** Where a promoted entry came from. */
export interface MemorySource {
  room: string;
  roomName: string;
  /** The table item (S3, F2, D1, Q1). */
  ref: string;
}

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  text: string;
  /** The reason given for it, if any. */
  why?: string;
  /** Whose claim it is: who settled, proposed, asked or noted it. */
  author: string;
  /** For a decision taken on the table: who decided it, when not its author. */
  decidedBy?: string;
  /** For an answer or a decision: the question it answers. */
  about?: string;
  /** A disagreement's sides. */
  positions?: MemoryPosition[];
  /** Objections still standing against a decision or a fact. */
  objections?: MemoryVoice[];
  source?: MemorySource;
  /** Who wrote it into memory, and when; who revised it last. */
  by: string;
  from?: ProjectWriter["from"];
  at: string;
  revisedBy?: string;
  /** The project seq of the last event that touched it: an edit made against an older one is refused. */
  seq: number;
}

/** What an entry is, as written: everything but who wrote it and when (the event says that). */
export type MemoryDraft = Omit<MemoryEntry, "id" | "by" | "from" | "at" | "revisedBy" | "seq">;

export type MemoryEventBody =
  | { type: "memory.noted"; id: string; entry: MemoryDraft }
  | { type: "memory.revised"; id: string; kind?: MemoryKind; text?: string; why?: string | null }
  | { type: "memory.removed"; id: string };

const MAX_MEMORY_TEXT = 4_000;

/** Apply one memory event to the list (projects.ts folds the log with it). */
export const foldMemoryEvent = (
  memory: MemoryEntry[],
  event: MemoryEventBody & { seq: number; ts: string; by: string; from?: ProjectWriter["from"] },
): MemoryEntry[] => {
  switch (event.type) {
    case "memory.noted":
      return [...memory, { ...event.entry, id: event.id, by: event.by, ...(event.from ? { from: event.from } : {}), at: event.ts, seq: event.seq }];
    case "memory.revised":
      return memory.map((entry) => {
        if (entry.id !== event.id) return entry;
        const next: MemoryEntry = { ...entry, revisedBy: event.by, seq: event.seq };
        if (event.kind) next.kind = event.kind;
        if (event.text !== undefined) next.text = event.text;
        if (event.why === null) delete next.why;
        else if (event.why !== undefined) next.why = event.why;
        return next;
      });
    case "memory.removed":
      return memory.filter((entry) => entry.id !== event.id);
  }
};

const clean = (value: string, what: string): string => {
  const text = value.replace(/\r\n/g, "\n").trim();
  if (text.length > MAX_MEMORY_TEXT) throw new ProjectError(`the ${what} is ${text.length} characters; at most ${MAX_MEMORY_TEXT}`);
  return text;
};

const isKind = (value: string): value is MemoryKind => (MEMORY_KINDS as readonly string[]).includes(value);

export const memoryPath = (key: string, env: NodeJS.ProcessEnv = process.env): string => join(projectDir(key, env), "MEMORY.md");

const writeMemoryMarkdown = (project: Project, env: NodeJS.ProcessEnv): void => {
  const file = memoryPath(project.key, env);
  writeFileSync(`${file}.tmp`, renderMemoryMarkdown(project));
  renameSync(`${file}.tmp`, file);
};

const append = (key: string, body: MemoryEventBody, writer: ProjectWriter, env: NodeJS.ProcessEnv): Project => {
  const project = appendProjectEvent(key, body, writer, env);
  writeMemoryMarkdown(project, env);
  return project;
};

const nextId = (project: Project): string => {
  const used = project.events.filter((event) => event.type === "memory.noted").length;
  return `M${used + 1}`;
};

/** Note something by hand: a person to ask, how someone likes to work, a decision made outside any table. */
export const noteMemory = (
  key: string,
  input: { text: string; kind?: string; why?: string },
  writer: ProjectWriter,
  env: NodeJS.ProcessEnv = process.env,
): Project => {
  const text = clean(input.text, "text");
  if (!text) throw new ProjectError('nothing to note: `agoryx memory note "text"`');
  const kind = input.kind ?? "fact";
  if (!isKind(kind)) throw new ProjectError(`a memory entry is a ${MEMORY_KINDS.join(", ")}; not "${kind}"`);
  const why = input.why === undefined ? undefined : clean(input.why, "reason");
  const project = readProject(key, env);
  return append(key, { type: "memory.noted", id: nextId(project), entry: { kind, text, author: writer.by, ...(why ? { why } : {}) } }, writer, env);
};

/** Standing objections to a table item: from everyone who objected and has not conceded on it, verbatim. */
const standingObjections = (table: TableState, item: { id: string; by: string; withdrawn?: boolean }): MemoryVoice[] => {
  const still = new Set(disputeOf(table, item));
  return table.notes.filter((note) => note.target === item.id && note.kind === "object" && still.has(note.by)).map((note) => ({ by: note.by, text: note.text }));
};

const optionText = (option: { title: string; body?: string }): string => (option.body ? `${option.title}\n${option.body}` : option.title);

/**
 * What a table item becomes in memory, in the table's own words. S (settled) and D (decided) are decisions, F a fact,
 * an open Q a disagreement with every open option and the objections still standing against each.
 */
export const draftFromTable = (table: TableState, ref: string): MemoryDraft => {
  const id = ref.trim().toUpperCase();
  const question = (q: string | null | undefined) => {
    const found = q ? table.questions.find((entry) => entry.id === q) : undefined;
    return found ? { about: `${found.id}: ${found.text}` } : {};
  };
  const letter = id[0];
  if (letter === "S") {
    const item = table.settled.find((entry) => entry.id === id);
    if (!item) throw new ProjectError(`${id} is not on this room's table`);
    const objections = standingObjections(table, item);
    return { kind: "decision", text: item.text, author: item.by, ...question(item.q), ...(objections.length ? { objections } : {}) };
  }
  if (letter === "F") {
    const item = table.facts.find((entry) => entry.id === id);
    if (!item) throw new ProjectError(`${id} is not on this room's table`);
    if (item.withdrawn) throw new ProjectError(`${id} was withdrawn by ${item.by}: nothing to keep`);
    const objections = standingObjections(table, item);
    return { kind: "fact", text: item.text, author: item.by, ...(objections.length ? { objections } : {}) };
  }
  if (letter === "D") {
    const decision = table.decisions.find((entry) => entry.id === id);
    if (!decision) throw new ProjectError(`${id} is not on this room's table`);
    const option = table.options.find((entry) => entry.id === decision.option);
    if (!option) throw new ProjectError(`${id} decided ${decision.option}, which is no longer on the table`);
    const objections = standingObjections(table, option);
    return {
      kind: "decision",
      text: optionText(option),
      author: option.by,
      ...(decision.by !== option.by ? { decidedBy: decision.by } : {}),
      ...(decision.note ? { why: decision.note } : {}),
      ...question(decision.q),
      ...(objections.length ? { objections } : {}),
    };
  }
  if (letter === "Q") {
    const item = table.questions.find((entry) => entry.id === id);
    if (!item) throw new ProjectError(`${id} is not on this room's table`);
    if (item.status === "decided") throw new ProjectError(`${id} is decided (${item.decision ?? "an option was chosen"}): promote the decision instead`);
    if (item.status === "answered") throw new ProjectError(`${id} is answered by ${item.answer ?? "a settled point"}: promote that instead`);
    const open = table.options.filter((option) => option.q === id && option.status === "open");
    if (!open.length) throw new ProjectError(`${id} has no open options: nothing is held against anything yet`);
    return {
      kind: "disagreement",
      text: item.text,
      author: item.by,
      positions: open.map((option) => ({ ref: option.id, by: option.by, text: optionText(option), objections: standingObjections(table, option) })),
    };
  }
  throw new ProjectError(`promote takes a settled point, a fact, a decision or an open question (S3, F2, D1, Q1); not "${ref}"`);
};

/** Keep a table item in the project's memory, as the table holds it now. */
export const promoteToMemory = (
  key: string,
  room: { id: string; name: string; table: TableState },
  ref: string,
  writer: ProjectWriter,
  env: NodeJS.ProcessEnv = process.env,
): Project => {
  const draft = draftFromTable(room.table, ref);
  const project = readProject(key, env);
  const tableRef = ref.trim().toUpperCase();
  const again = project.memory.find((entry) => entry.source?.room === room.id && entry.source.ref === tableRef);
  if (again) throw new ProjectError(`${tableRef} of "${room.name}" is already in memory as ${again.id}; \`agoryx memory remove ${again.id}\` first to keep it as it stands now`);
  return append(key, { type: "memory.noted", id: nextId(project), entry: { ...draft, source: { room: room.id, roomName: room.name, ref: tableRef } } }, writer, env);
};

const entryOf = (project: Project, id: string): MemoryEntry => {
  const entry = project.memory.find((item) => item.id === id.trim().toUpperCase());
  if (!entry) throw new ProjectError(`no memory entry ${id}`);
  return entry;
};

/** Rewrite an entry's text, reason or kind. Nothing is appended when nothing changes. */
export const reviseMemory = (
  key: string,
  id: string,
  change: { text?: string; why?: string | null; kind?: string },
  writer: ProjectWriter,
  env: NodeJS.ProcessEnv = process.env,
): Project => {
  const project = readProject(key, env);
  const entry = entryOf(project, id);
  const body: MemoryEventBody & { type: "memory.revised" } = { type: "memory.revised", id: entry.id };
  if (change.kind !== undefined && change.kind !== entry.kind) {
    if (!isKind(change.kind)) throw new ProjectError(`a memory entry is a ${MEMORY_KINDS.join(", ")}; not "${change.kind}"`);
    if ((change.kind === "disagreement") !== Boolean(entry.positions)) throw new ProjectError("only an entry with positions is a disagreement");
    body.kind = change.kind;
  }
  if (change.text !== undefined) {
    const text = clean(change.text, "text");
    if (!text) throw new ProjectError(`an entry needs its text; \`agoryx memory remove ${entry.id}\` removes it`);
    if (text !== entry.text) body.text = text;
  }
  if (change.why !== undefined) {
    const why = change.why === null ? "" : clean(change.why, "reason");
    if (why !== (entry.why ?? "")) body.why = why || null;
  }
  if (Object.keys(body).length === 2) return project;
  return append(key, body, writer, env);
};

export const removeMemory = (key: string, id: string, writer: ProjectWriter, env: NodeJS.ProcessEnv = process.env): Project => {
  const entry = entryOf(readProject(key, env), id);
  return append(key, { type: "memory.removed", id: entry.id }, writer, env);
};

// --- reading it ---------------------------------------------------------------------------------

const quote = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return `"${flat.length > max ? `${flat.slice(0, max)}…` : flat}"`;
};

/** Disagreements first, then the rest newest first. */
export const memoryOrder = (memory: MemoryEntry[]): MemoryEntry[] => [
  ...memory.filter((entry) => entry.kind === "disagreement"),
  ...memory.filter((entry) => entry.kind !== "disagreement").reverse(),
];

/** Whose claim, from where: "codex's S3 in "Store"", or "noted by Ivan". */
const claimant = (entry: MemoryEntry): string => {
  if (!entry.source) return entry.author === entry.by ? `noted by ${entry.by}` : `${entry.author}, noted by ${entry.by}`;
  const own = `${entry.author}'s ${entry.source.ref} in "${entry.source.roomName}"`;
  return entry.decidedBy ? `${own}, decided by ${entry.decidedBy}` : own;
};

const voices = (list: MemoryVoice[] | undefined, max: number): string =>
  list?.length ? `; still objected to by ${list.map((voice) => `${voice.by} ${quote(voice.text, max)}`).join(", ")}` : "";

/** One entry for an agent's briefing: a claim with who holds it, never a bare fact. */
const indexLines = (entry: MemoryEntry): string[] => {
  if (entry.kind === "disagreement") {
    const lines = [`    ${entry.id} open disagreement — ${claimant(entry)}: ${quote(entry.text, 140)}`];
    for (const position of entry.positions ?? []) {
      lines.push(`       ${position.ref ? `${position.ref} ` : ""}${position.by} holds ${quote(position.text, 120)}${voices(position.objections, 80)}`);
    }
    return lines;
  }
  const why = entry.why ? ` because ${quote(entry.why, 100)}` : "";
  return [`    ${entry.id} ${entry.kind} — ${claimant(entry)}: ${quote(entry.text, 160)}${why}${voices(entry.objections, 80)}`];
};

/** How many entries a briefing lists; the rest are a command away. */
export const MEMORY_INDEX_CAP = 12;

/** The memory part of a fresh Work session's briefing: a capped index, disagreements first. */
export const memoryBriefing = (project: Project, cli: string, env: NodeJS.ProcessEnv = process.env): string[] => {
  const lines: string[] = [];
  const how = `\`${cli} memory note "…" [--kind decision|fact|person|preference] [--why "…"]\` or \`${cli} memory promote S3|F2|D1|Q1\` keeps something for every Work room here.`;
  if (!project.memory.length) return [`  Memory: empty. ${how}`];
  const shown = memoryOrder(project.memory).slice(0, MEMORY_INDEX_CAP);
  lines.push(
    `  Memory — ${project.memory.length} entr${project.memory.length === 1 ? "y" : "ies"}, open disagreements first. Each is someone's claim, with who holds it — not a fact of this room; weigh it, don't defer to it:`,
  );
  for (const entry of shown) lines.push(...indexLines(entry));
  const rest = project.memory.length - shown.length;
  lines.push(`    ${rest > 0 ? `${rest} more, and ` : ""}every entry in full: \`${cli} memory\` (or ${memoryPath(project.key, env)}).`);
  lines.push(`  ${how}`);
  return lines;
};

/** For a running session: what others did to the memory since its last turn, as one line. */
export const memoryUpdateLine = (events: Project["events"], cli: string): string | null => {
  const bits: string[] = [];
  const added = new Map<string, number>();
  for (const event of events) {
    if (event.type === "memory.noted") {
      const label = `${event.entry.kind} by ${event.by}`;
      added.set(label, (added.get(label) ?? 0) + 1);
    }
  }
  for (const [label, count] of added) bits.push(`+${count} ${label}`);
  for (const event of events) {
    if (event.type === "memory.revised") bits.push(`${event.id} revised by ${event.by}`);
    if (event.type === "memory.removed") bits.push(`${event.id} removed by ${event.by}`);
  }
  return bits.length ? `  memory: ${bits.join(", ")} — \`${cli} memory\` for the text.` : null;
};

const indent = (text: string, pad: string): string => text.split("\n").map((line) => `${pad}${line}`).join("\n");

/** MEMORY.md: every entry in full, grouped by kind, disagreements first. */
export const renderMemoryMarkdown = (project: Project): string => {
  const title = project.name ?? project.key;
  const lines = [`# Memory — ${title}`, "", `Folder: ${project.key}`, "", "Each entry is someone's claim, with who holds it. Written by those who work here; Agoryx adds nothing.", ""];
  if (!project.memory.length) {
    lines.push("Nothing yet. `agoryx memory note \"…\"` or `agoryx memory promote S3|F2|D1|Q1`.");
    return `${lines.join("\n")}\n`;
  }
  const heads: Record<MemoryKind, string> = {
    disagreement: "Open disagreements",
    decision: "Decisions",
    fact: "Facts",
    person: "People",
    preference: "Preferences",
  };
  for (const kind of MEMORY_KINDS) {
    const entries = project.memory.filter((entry) => entry.kind === kind);
    if (!entries.length) continue;
    lines.push(`## ${heads[kind]}`, "");
    for (const entry of entries) {
      lines.push(`### ${entry.id} — ${claimant(entry)}`, "");
      if (entry.about) lines.push(`About ${entry.about}`, "");
      lines.push(entry.text, "");
      if (entry.why) lines.push(`Why: ${entry.why}`, "");
      for (const position of entry.positions ?? []) {
        lines.push(`- **${position.ref ?? "?"}** by ${position.by}:`, indent(position.text, "  "));
        for (const voice of position.objections) lines.push(`  - ✗ ${voice.by}: ${voice.text}`);
      }
      if (entry.positions?.length) lines.push("");
      for (const voice of entry.objections ?? []) lines.push(`- ✗ still objected to by ${voice.by}: ${voice.text}`);
      if (entry.objections?.length) lines.push("");
      lines.push(`_written by ${entry.by}${entry.from ? ` in "${entry.from.roomName}"` : ""}, ${entry.at.slice(0, 10)}${entry.revisedBy ? `; revised by ${entry.revisedBy}` : ""}_`, "");
    }
  }
  return `${lines.join("\n")}\n`;
};
