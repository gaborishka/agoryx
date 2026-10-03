import { findRun } from "./projection.js";
import type { RoomStore } from "./store.js";
import type { FileChange, RoomState, SystemNote, TableState } from "./types.js";
import { uncommittedFiles } from "./workspace.js";

/**
 * Threads: a Work room started from another (`agoryx new --from <room>`), on its own branch of the same project folder.
 * When a thread's run ends, its parent gets a report in its own feed — what the thread left, as the thread holds it,
 * with no summary: its last message verbatim, what its table got in that run, its branch, and the diff stat of the
 * branch against its base plus what is uncommitted (agents commit only when they choose to, so that is part of the
 * result). It wakes the parent's agent that started the thread; one the human started wakes no one (it waits in
 * Attention). Steering is `agoryx say -r <thread>`; merging is the agents' own git work.
 */

export type ThreadNote = Extract<SystemNote, { code: "thread.reported" }>;

/** Files named in a report; the rest is counted. */
const MAX_FILES = 30;

/** Everything on a table, with the text it is known by. */
export const tableItems = (table: TableState): Array<{ id: string; text: string; seq: number }> => [
  ...table.questions,
  ...table.options.map((option) => ({ ...option, text: option.title })),
  ...table.facts,
  ...table.settled,
  ...table.next,
  ...table.shifts,
  ...table.notes.map((note) => ({ ...note, text: `${note.kind} on ${note.target}: ${note.text}` })),
  // A decision is its own record; the option it chose keeps its older seq.
  ...table.decisions.map((decision) => {
    const option = table.options.find((entry) => entry.id === decision.option);
    const chose = `${decision.by} chose ${decision.option}${option ? ` "${option.title}"` : ""}${decision.q ? ` for ${decision.q}` : ""}`;
    return { ...decision, text: decision.note ? `${chose}: ${decision.note}` : chose };
  }),
];

const indent = (text: string): string => text.split("\n").map((line) => `    ${line}`).join("\n");

const stat = (file: { added: number | null; removed: number | null }): string => (file.added === null ? "binary" : `+${file.added} −${file.removed ?? 0}`);

/**
 * The report of a thread's run, for its parent; null when the run had no turn (nothing happened) or is not over.
 * `parent`: the parent's state, to know whom it wakes; `changes`: the thread's whole change (engine.roomWorkspaceDiff).
 */
export const threadReport = (store: RoomStore, runId: string, parent: RoomState, changes: FileChange[]): { text: string; sys: ThreadNote } | null => {
  const state = store.state;
  const run = findRun(state, runId);
  if (!run || run.status !== "ended" || run.used === 0) return null;
  const said = state.messages.filter((message) => message.runId === runId && (message.kind === "agent" || message.kind === "update") && !message.native);
  const lastMessage = said.at(-1);
  const labelOf = (id: string) => state.agents.find((agent) => agent.id === id)?.label ?? state.former.find((agent) => agent.id === id)?.label ?? id;
  const uncommitted = uncommittedFiles(state.workspace)?.filter((path) => !path.startsWith(".agoryx/")) ?? [];
  const items = tableItems(state.table)
    // This run's items only: not what a later run, or the human after it, added before the report is written.
    .filter((item) => item.seq > run.startedSeq && item.seq <= (run.endedSeq ?? Infinity))
    .sort((a, b) => a.seq - b.seq)
    .map(({ id, text }) => ({ id, text }));
  const open = state.table.questions.find((question) => question.status === "open");
  const spawner = state.createdBy?.room === parent.id ? parent.agents.find((agent) => agent.id === state.createdBy!.agent) : undefined;
  const files = changes.filter((change) => !change.path.startsWith(".agoryx/"));
  const sys: ThreadNote = {
    code: "thread.reported",
    room: state.id,
    run: runId,
    name: state.name,
    reason: run.endReason ?? "quiet",
    agents: state.agents.map((agent) => agent.label),
    ...(state.worktree ? { branch: state.worktree.branch, base: state.worktree.base } : {}),
    files: files.slice(0, MAX_FILES).map(({ path, status, added, removed }) => ({ path, status, added, removed })),
    ...(files.length > MAX_FILES ? { more: files.length - MAX_FILES } : {}),
    uncommitted: uncommitted.length,
    items,
    ...(open ? { open: { id: open.id, text: open.text } } : {}),
    ...(lastMessage ? { last: { by: labelOf(lastMessage.author), text: lastMessage.text } } : {}),
    ...(spawner ? { wakes: spawner.id } : {}),
  };
  return { text: threadText(sys), sys };
};

/** The report's line in the parent's transcript, for its agents and the terminal. */
export const threadText = (sys: ThreadNote): string => {
  const ended = sys.reason === "quiet" ? "went quiet" : sys.reason === "budget" ? "spent its turn limit" : "was stopped";
  const lines = [`Thread "${sys.name}" (${sys.room}, ${sys.agents.join(", ")}) ${ended}.`];
  const total = sys.files.length + (sys.more ?? 0);
  const where = sys.branch ? `Branch ${sys.branch} (from ${sys.base})` : "Its folder";
  if (total === 0) lines.push(`${where}: no changes.`);
  else {
    const uncommitted = sys.uncommitted ? `, ${sys.uncommitted} file${sys.uncommitted === 1 ? "" : "s"} uncommitted` : ", all committed";
    lines.push(`${where}: ${total} file${total === 1 ? "" : "s"} changed${uncommitted}:`);
    for (const file of sys.files) lines.push(`  ${file.status} ${file.path} ${stat(file)}`);
    if (sys.more) lines.push(`  … and ${sys.more} more`);
  }
  if (sys.items.length) {
    lines.push("New on its table:");
    for (const item of sys.items) lines.push(`  ${item.id} ${item.text.split("\n")[0]}`);
  }
  if (sys.open && !sys.items.some((item) => item.id === sys.open!.id)) lines.push(`Still open there: ${sys.open.id} ${sys.open.text.split("\n")[0]}`);
  if (sys.last) lines.push(`Its last message, by ${sys.last.by}:`, indent(sys.last.text));
  else lines.push("Nobody in it said anything this run.");
  lines.push(`\`agoryx tail -r ${sys.room}\` reads it; \`agoryx say -r ${sys.room} "…"\` steers it.`);
  return lines.join("\n");
};

/**
 * For a fresh Work session's briefing: in a thread, whose thread it is and what goes back there; elsewhere, how to
 * start one. `parentName`: the parent room's name, when it can be read.
 */
export const threadBriefing = (state: RoomState, cli: string, parentName?: string): string =>
  state.parent
    ? `Thread: this room is a thread of "${parentName ?? state.parent}" (${state.parent})${state.worktree ? `, on its own branch ${state.worktree.branch}` : ""}. When a run here ends, Agoryx shows that room what this one left — the last message, verbatim; what the table got; the diff, uncommitted files too — and wakes the agent there that started it. Nothing else is summarised for you or for them.`
    : `Threads: \`${cli} new --from here --agents '[{"kind":"codex"}]' -m "<brief>"\` starts a Work room on its own branch of this folder (you alone, without --agents), to work in parallel; when its run ends it reports back here and wakes you. Steer one with \`${cli} say -r <thread> "…"\`; merging its branch is your own git work.`;
