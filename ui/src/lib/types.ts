import type { AgentPresence, RoomState, TableOp } from "@agora/types";

export type * from "@agora/types";

export interface RoomSummary {
  id: string;
  name: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  messages: number;
  lastMessage?: { author: string; text: string };
  running: boolean;
  driven?: boolean;
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
