import type { AgentLook } from "@agora/look";
import type { AgentPresence, AttentionItem, LimitSnapshot, RoomAgent, RoomState, SystemNote, TableOp } from "@agora/types";

export type * from "@agora/types";

export interface RoomSummary {
  mode?: "chat" | "work";
  id: string;
  name: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  messages: number;
  /** `label`: the author's display name when an agent wrote it; `look`: its shade and mark, only next to another of its kind. */
  lastMessage?: { author: string; text: string; label?: string; look?: AgentLook; sys?: SystemNote };
  running: boolean;
  /** Who sits in the room, in roster order. */
  agents?: Array<Pick<RoomAgent, "id" | "kind" | "label">>;
  /** Whose turn runs now, and since when. */
  working?: Array<{ agent: string; since: string }>;
  /** The folder the human started the room in; absent when Agoryx made one. */
  folder?: string;
  branch?: string;
  driven?: boolean;
  /** The room waits for the human (the daemon sends it to the human only). */
  waiting?: AttentionItem;
  /** Messages from others since the human last looked (attention.json's seen cursor); the human's only. */
  unread?: number;
  /** Work rooms: their project (folder), by hash, and the name written for it. */
  projectHash?: string;
  projectName?: string;
  /** A thread: the room it was started from. */
  parent?: string;
}

/** A project event: a name, goal or instructions written, with who wrote it. */
type ProjectWriteMeta = {
  seq: number;
  ts: string;
  by: string;
  from?: { room: string; roomName: string; agent: string; label: string };
};

export type MemoryKind = "disagreement" | "decision" | "fact" | "person" | "preference";

export interface MemoryVoice {
  by: string;
  text: string;
}

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  text: string;
  why?: string;
  /** Whose claim it is. */
  author: string;
  decidedBy?: string;
  about?: string;
  positions?: Array<{ ref?: string; by: string; text: string; objections: MemoryVoice[] }>;
  objections?: MemoryVoice[];
  source?: { room: string; roomName: string; ref: string };
  /** Who wrote it into memory. */
  by: string;
  from?: ProjectWriteMeta["from"];
  at: string;
  revisedBy?: string;
  /** An edit made against an older one is refused (409). */
  seq: number;
}

export type ProjectEvent = ProjectWriteMeta &
  (
    | { type: "project.changed"; field: "name" | "goal" | "instructions"; value: string | null }
    | { type: "memory.noted"; id: string; entry: Pick<MemoryEntry, "kind" | "text"> }
    | { type: "memory.revised"; id: string }
    | { type: "memory.removed"; id: string }
  );

export interface ProjectView {
  hash: string;
  /** The folder. */
  key: string;
  name?: string;
  goal?: string;
  instructions?: string;
  /** The last event's seq. */
  seq: number;
  /** The last name/goal/instructions change: an edit of them made from an older one is refused (409). */
  fieldsSeq: number;
  memory: MemoryEntry[];
  memoryPath: string;
  rooms: string[];
  events: ProjectEvent[];
}

export interface StreamBuffer {
  agent: string;
  text: string;
}

export interface OpEntry {
  seq: number;
  ts: string;
  op: TableOp;
}

export interface Snapshot {
  state: RoomState;
  presence: Record<string, AgentPresence>;
  streams: Record<string, StreamBuffer>;
  ops: OpEntry[];
  rawBase: string;
  resume: Record<string, string>;
  driven: boolean;
  /** The room's folder is a git repository of its own (steps can be committed). */
  gitRepo?: boolean;
  lockedBy?: string;
  /** The human's profile: where it is and whether it exists (its text never reaches the UI). */
  profile?: { path: string; exists: boolean };
  /** What each agent's CLI last said about its subscription's limits. */
  limits?: LimitSnapshot[];
}

export type DiffItem = { t: "+" | "-" | " "; s: string } | { skip: number };

export interface DocNow {
  path: string;
  text: string;
  hash: string;
  exists: boolean;
  /** Too big to edit here: `text` is only the start of the file. */
  truncated?: boolean;
}

export interface DocRevisionView {
  revision: import("@agora/types").DocRevision;
  previous: number | null;
  text: string | null;
  truncated: boolean;
  diff: DiffItem[] | null;
}
