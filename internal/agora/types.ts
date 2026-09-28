/**
 * Agora — the room subsystem.
 *
 * A room is a shared conversation between one human and several CLI agents
 * (Claude Code, Codex) around one git workspace. The append-only event log is
 * the source of truth; everything else (messages, table, cursors, runs) is a
 * projection of it. Agoryx gives agents context — who is here, what is new,
 * how to pass — and never assigns roles or arbitrates who speaks.
 */

export type AgentKind = "claude" | "codex";

export interface RoomAgent {
  /** Stable handle used in @mentions and as message author (e.g. "claude"). */
  id: string;
  kind: AgentKind;
  /** Display name ("Claude", "Codex"). */
  label: string;
  model?: string;
}

export type SandboxAccess = "workspace" | "readonly";

export interface RoomSettings {
  /** Agent turns allowed per run (a run starts with a human message). */
  budget: number;
  turnTimeoutMs: number;
  /** Filesystem access for agents. Always sandboxed; "workspace" = write inside the room dir. */
  access: SandboxAccess;
  /** Let sandboxed commands reach the network. */
  network: boolean;
  /** Commit workspace changes at the end of every run. */
  autoCommit: boolean;
  /**
   * The room's canonical file, relative to the workspace: the one text the room is making.
   * Every revision is kept with its author; agents see the others' changes as a diff.
   */
  doc?: string | null;
}

export const DEFAULT_SETTINGS: RoomSettings = {
  budget: 8,
  turnTimeoutMs: 20 * 60 * 1000,
  access: "workspace",
  network: true,
  autoCommit: true,
  doc: null,
};

export type MessageKind = "human" | "agent" | "pass" | "system" | "decision";

export interface RoomMessage {
  id: string;
  author: string;
  kind: MessageKind;
  text: string;
  /** Participant handles mentioned with @ (lower-case). */
  mentions: string[];
  /** Whether this message wakes agents (other than its author). */
  wakes: boolean;
  turnId?: string;
  runId?: string;
  /** Table refs this message is about (P1, Q2, D1...). */
  refs?: string[];
  /**
   * Set when the message was said in an agent's own session (the human opened
   * `claude --resume` / `codex resume` and talked there) and read back into the
   * room. That agent already has it; everyone else gets it in their next turn.
   */
  native?: NativeOrigin;
}

export interface NativeOrigin {
  /** The agent whose session this came from. */
  agent: string;
  /** Exchange id inside that session file (dedupe key). */
  key: string;
  /** When it was said, per the session file. */
  at?: string;
}

export type ActivityKind =
  | "command"
  | "edit"
  | "read"
  | "search"
  | "web"
  | "tool"
  | "thinking"
  | "note"
  | "denied"
  | "error";

export interface Activity {
  /** Runner-local id; later updates for the same id replace earlier ones. */
  id: string;
  kind: ActivityKind;
  label: string;
  detail?: string;
  status?: "running" | "ok" | "fail";
}

export type TurnStatus = "running" | "ok" | "pass" | "error" | "interrupted";

export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  costUsd?: number;
}

export interface TurnError {
  kind: "rate_limit" | "auth" | "context" | "timeout" | "spawn" | "session" | "unknown";
  message: string;
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export type TableOpInput =
  | { op: "ask"; text: string }
  | { op: "propose"; title: string; body?: string; q?: string; file?: string }
  | { op: "object" | "support" | "evidence"; target: string; text: string; source?: string }
  | { op: "fact"; text: string }
  | { op: "settle"; text: string }
  | { op: "next"; text: string }
  | { op: "done"; target: string }
  | { op: "withdraw"; target: string }
  | { op: "decide"; target: string; note?: string }
  | { op: "reopen"; target: string };

export type TableOpName = TableOpInput["op"];

/** A table op as stored: input plus who made it and the id it created (if any). */
export type TableOp = TableOpInput & {
  by: string;
  /** Id assigned to the created entity (Q3, P2, N7, F1, S2, X4, D1). */
  id?: string;
  turnId?: string;
  /** Client nonce, echoed back so the agent-side CLI can learn the assigned id. */
  nonce?: string;
};

export interface TableQuestion {
  id: string;
  text: string;
  by: string;
  seq: number;
  status: "open" | "decided";
  decision?: string;
}

export interface TableOption {
  id: string;
  q: string | null;
  title: string;
  body?: string;
  file?: string;
  by: string;
  seq: number;
  status: "open" | "withdrawn" | "chosen";
}

export interface TableNote {
  id: string;
  kind: "object" | "support" | "evidence";
  target: string;
  text: string;
  source?: string;
  by: string;
  seq: number;
}

export interface TableItem {
  id: string;
  text: string;
  by: string;
  seq: number;
  done?: boolean;
}

export interface TableDecision {
  id: string;
  n: number;
  option: string;
  q: string | null;
  by: string;
  note?: string;
  seq: number;
}

export interface TableState {
  questions: TableQuestion[];
  options: TableOption[];
  notes: TableNote[];
  facts: TableItem[];
  settled: TableItem[];
  next: TableItem[];
  decisions: TableDecision[];
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** A git worktree Agoryx made for a room: its own branch and folder, shared by every agent in it. */
export interface RoomWorktree {
  /** The folder the human picked. */
  source: string;
  /** The top of the repository it belongs to. */
  repo: string;
  /** The worktree's own folder. */
  path: string;
  /** The branch made for the room. */
  branch: string;
  /** What it branched from. */
  base: string;
}

export interface RoomCreatedEvent {
  type: "room.created";
  id: string;
  name: string;
  workspace: string;
  createdWorkspace: boolean;
  worktree?: RoomWorktree;
  human: string;
  agents: RoomAgent[];
  settings: RoomSettings;
}

export type RoomEventBody =
  | RoomCreatedEvent
  | { type: "message.posted"; message: RoomMessage }
  | { type: "run.started"; runId: string; trigger: string | null; budget: number }
  | { type: "run.extended"; runId: string; by: string; turns: number }
  | { type: "run.ended"; runId: string; reason: "quiet" | "budget" | "stopped"; turns: number }
  | {
      type: "turn.started";
      turnId: string;
      agent: string;
      runId: string;
      /** Highest seq included in this turn's prompt. */
      cursor: number;
      resume: boolean;
      sessionId: string | null;
      promptChars: number;
    }
  | { type: "turn.activity"; turnId: string; agent: string; activity: Activity }
  | {
      type: "turn.ended";
      turnId: string;
      agent: string;
      status: Exclude<TurnStatus, "running">;
      sessionId: string | null;
      messageId?: string;
      usage?: TurnUsage;
      error?: TurnError;
      durationMs: number;
      files?: string[];
      /** Per-file line counts for `files`, from git trees taken at the turn's start and end. */
      changes?: FileChange[];
      /** Those two trees; `git diff before after` shows the whole workspace change. */
      trees?: { before: string; after: string };
      /** The agent never got to answer what this turn showed it (the process died): show it again. */
      unseen?: boolean;
    }
  | { type: "session.bound"; agent: string; sessionId: string }
  | { type: "table.op"; op: TableOp }
  | { type: "settings.changed"; patch: Partial<RoomSettings> }
  | { type: "room.renamed"; name: string }
  | { type: "commit.created"; sha: string; subject: string; files: number }
  | DocRevisedEvent;

/** The canonical file changed. `text` is the whole new version (omitted past MAX_DOC_TEXT). */
export interface DocRevisedEvent {
  type: "doc.revised";
  path: string;
  /** Agent id or the human's name. */
  by: string;
  /** The room turn that made the change; absent for edits made outside a turn. */
  turnId?: string;
  /** Made by an agent in its own session, outside the room. */
  native?: boolean;
  hash: string;
  /** null: the file was deleted. */
  text?: string | null;
  truncated?: boolean;
  added: number;
  removed: number;
}

export interface DocRevision {
  seq: number;
  ts: string;
  path: string;
  by: string;
  turnId?: string;
  native?: boolean;
  hash: string;
  deleted?: boolean;
  added: number;
  removed: number;
}

export type RoomEvent = RoomEventBody & { seq: number; ts: string };

/** Non-persisted events broadcast to live listeners only. */
export type EphemeralEvent =
  | { type: "turn.stream"; turnId: string; agent: string; text: string; reset?: boolean }
  | { type: "presence"; agents: Record<string, AgentPresence> };

/** "native": someone is mid-exchange with the agent in its own session, outside the room. */
export type AgentPresence = "idle" | "working" | "queued" | "native";

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export interface TurnState {
  id: string;
  agent: string;
  runId: string;
  cursor: number;
  /** The agent's cursor before this turn: restored if the turn never finished. */
  cursorBefore: number;
  seq: number;
  startedAt: string;
  endedAt?: string;
  status: TurnStatus;
  resume: boolean;
  sessionId: string | null;
  activity: Activity[];
  messageId?: string;
  usage?: TurnUsage;
  error?: TurnError;
  durationMs?: number;
  files?: string[];
  changes?: FileChange[];
}

/** One file a turn changed. */
export interface FileChange {
  /** Relative to the repository root, like git status. */
  path: string;
  /** A added, M modified, D deleted, T type changed. */
  status: string;
  /** Line counts; null for a binary file. */
  added: number | null;
  removed: number | null;
}

export interface RunState {
  id: string;
  trigger: string | null;
  budget: number;
  used: number;
  startedSeq: number;
  status: "active" | "ended";
  endReason?: "quiet" | "budget" | "stopped";
}

export interface MessageEntry extends RoomMessage {
  seq: number;
  ts: string;
}

export interface RoomState {
  id: string;
  name: string;
  workspace: string;
  createdWorkspace: boolean;
  worktree?: RoomWorktree;
  human: string;
  agents: RoomAgent[];
  settings: RoomSettings;
  createdAt: string;
  seq: number;
  messages: MessageEntry[];
  turns: TurnState[];
  runs: RunState[];
  sessions: Record<string, { sessionId: string; boundAt: string }>;
  /** Highest seq each agent has seen (via prompt or authorship). */
  cursors: Record<string, number>;
  table: TableState;
  commits: Array<{ sha: string; subject: string; files: number; seq: number }>;
  /** Revisions of the canonical file (texts stay in the event log). */
  docRevisions: DocRevision[];
  counters: Record<string, number>;
}
