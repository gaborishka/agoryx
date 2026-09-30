import type { AgentLook } from "@agora/look";
import type { AgentPresence, AttentionItem, LimitSnapshot, RoomAgent, RoomState, SystemNote, TableOp } from "@agora/types";

export type * from "@agora/types";

export interface RoomSummary {
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
