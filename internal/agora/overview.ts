import { existsSync } from "node:fs";
import { extname, join, sep } from "node:path";
import { fileRefs, MEDIA_EXTS } from "./media.js";
import type { ThreadNote } from "./threads.js";
import type { RoomEvent, RoomState } from "./types.js";
import { emptyTotals, roomUsage, type UsageTotals } from "./usage.js";

/**
 * What a project's page shows across its rooms, read from the rooms as they are: the library (files the human
 * attached, the rooms' documents, media the agents linked — each by its path, where it is; nothing is copied), the
 * threads with what each last reported, and what the rooms' turns cost, summed from each room's own usage.
 */

export type LibraryKind = "upload" | "doc" | "media";

export interface LibraryEntry {
  kind: LibraryKind;
  /** Absolute for uploads and media; a document's is relative to its room's folder. */
  path: string;
  /** The room that first linked it (a document: its room), and who linked or last revised it, when. */
  room: string;
  roomName: string;
  by: string;
  at: string;
  /** Other rooms that link it too. */
  alsoIn: number;
  /** A document's revisions. */
  revisions?: number;
  /** The file is still where it was linked. */
  exists: boolean;
}

export interface ThreadView {
  id: string;
  name: string;
  parent: string;
  parentName?: string;
  agents: string[];
  branch?: string;
  base?: string;
  running: boolean;
  updatedAt: string;
  /** Its last report in its parent, as posted. */
  report?: Pick<ThreadNote, "reason" | "files" | "more" | "uncommitted" | "open" | "last"> & { at: string };
}

export interface ProjectUsage {
  total: UsageTotals;
  /** Per CLI: claude, codex. */
  byKind: Record<string, UsageTotals>;
  /** The threads' share of the total. */
  threads: UsageTotals;
  rooms: Array<{ id: string; name: string; thread: boolean; total: UsageTotals }>;
}

export interface ProjectOverview {
  library: LibraryEntry[];
  threads: ThreadView[];
  usage: ProjectUsage;
}

export interface OverviewRoom {
  state: RoomState;
  events: readonly RoomEvent[];
  updatedAt: string;
}

const sum = (into: UsageTotals, add: UsageTotals): void => {
  into.turns += add.turns;
  into.ms += add.ms;
  into.costUsd += add.costUsd;
  into.costTurns += add.costTurns;
  into.inputTokens += add.inputTokens;
  into.outputTokens += add.outputTokens;
};

const labelOf = (state: RoomState, id: string): string =>
  state.agents.find((agent) => agent.id === id)?.label ?? state.former.find((agent) => agent.id === id)?.label ?? id;

/**
 * The overview of a project's rooms. `uploads`: the folder attached files are kept in. `all`: every room, to name a
 * thread's parent and find its reports (a parent is a room of the same project, but read it wherever it is).
 */
export const projectOverview = (rooms: OverviewRoom[], uploads: string, all: Map<string, RoomState> = new Map(rooms.map((room) => [room.state.id, room.state]))): ProjectOverview => {
  const uploadsPrefix = uploads.endsWith(sep) ? uploads : uploads + sep;
  // Oldest room first: a file belongs to the room that linked it first.
  const ordered = [...rooms].sort((a, b) => a.state.createdAt.localeCompare(b.state.createdAt));

  const linked = new Map<string, LibraryEntry>();
  const linkedIn = new Map<string, Set<string>>();
  const docs: LibraryEntry[] = [];
  for (const { state } of ordered) {
    for (const message of state.messages) {
      if (message.kind === "system" || message.kind === "decision") continue;
      for (const path of fileRefs(message.text)) {
        const kind: LibraryKind | null = path.startsWith(uploadsPrefix) ? "upload" : MEDIA_EXTS.has(extname(path).toLowerCase()) ? "media" : null;
        if (!kind) continue;
        const rooms = linkedIn.get(path) ?? new Set<string>();
        rooms.add(state.id);
        linkedIn.set(path, rooms);
        if (linked.has(path)) continue;
        linked.set(path, { kind, path, room: state.id, roomName: state.name, by: message.kind === "human" ? message.author : labelOf(state, message.author), at: message.ts, alsoIn: 0, exists: existsSync(path) });
      }
    }
    const doc = state.settings.doc;
    if (doc) {
      const revisions = state.docRevisions.filter((revision) => revision.path === doc);
      const last = revisions.at(-1);
      docs.push({
        kind: "doc",
        path: doc,
        room: state.id,
        roomName: state.name,
        by: last ? (last.by === state.human ? last.by : labelOf(state, last.by)) : "",
        at: last?.ts ?? state.createdAt,
        alsoIn: 0,
        revisions: revisions.length,
        exists: existsSync(join(state.workspace, doc)),
      });
    }
  }
  for (const entry of linked.values()) entry.alsoIn = (linkedIn.get(entry.path)?.size ?? 1) - 1;
  const library = [...docs, ...linked.values()].sort((a, b) => b.at.localeCompare(a.at));

  const threads: ThreadView[] = rooms
    .filter(({ state }) => state.parent)
    .map(({ state, updatedAt }) => {
      const parent = all.get(state.parent!);
      const report = parent?.messages.filter((message) => message.sys?.code === "thread.reported" && message.sys.room === state.id).at(-1);
      const sys = report?.sys as ThreadNote | undefined;
      return {
        id: state.id,
        name: state.name,
        parent: state.parent!,
        ...(parent ? { parentName: parent.name } : {}),
        agents: state.agents.map((agent) => agent.label),
        ...(state.worktree ? { branch: state.worktree.branch, base: state.worktree.base } : {}),
        running: state.turns.some((turn) => turn.status === "running"),
        updatedAt,
        ...(sys && report
          ? { report: { reason: sys.reason, files: sys.files, ...(sys.more ? { more: sys.more } : {}), uncommitted: sys.uncommitted, ...(sys.open ? { open: sys.open } : {}), ...(sys.last ? { last: sys.last } : {}), at: report.ts } }
          : {}),
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const usage: ProjectUsage = { total: emptyTotals(), byKind: {}, threads: emptyTotals(), rooms: [] };
  for (const { state, events } of rooms) {
    const room = roomUsage(state, events);
    sum(usage.total, room.total);
    if (state.parent) sum(usage.threads, room.total);
    for (const agent of room.agents) {
      const kind = agent.kind ?? "other";
      sum((usage.byKind[kind] ??= emptyTotals()), agent.total);
    }
    usage.rooms.push({ id: state.id, name: state.name, thread: Boolean(state.parent), total: room.total });
  }
  usage.rooms.sort((a, b) => b.total.costUsd - a.total.costUsd || b.total.ms - a.total.ms);

  return { library, threads, usage };
};
