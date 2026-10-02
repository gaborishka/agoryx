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
  /** How hard the model thinks ("high", "xhigh", …): Claude's --effort, Codex's model_reasoning_effort. The CLI's own default when absent. */
  effort?: string;
  /** false: this agent is not given the human's profile (<AGORYX_HOME>/profile.md). On when absent. */
  profile?: false;
  /**
   * What the human asked this agent to be in the room ("reviewer: look for bugs, don't write code"), in their words.
   * Agoryx never assigns one: absent, the agent acts as itself. Told to the agent and to the others.
   */
  role?: string;
}

export type SandboxAccess = "workspace" | "readonly";

export interface RoomSettings {
  /**
   * Agent turns allowed per run (a run starts with a human message), or null: no limit — the run ends when
   * everyone passes, or when the human stops it. Null unless the human sets one.
   */
  budget: number | null;
  turnTimeoutMs: number;
  /** Filesystem access for agents. "workspace" = as in the human's terminal; "readonly" = sandboxed, no writes. */
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
  budget: null,
  turnTimeoutMs: 20 * 60 * 1000,
  access: "workspace",
  network: true,
  autoCommit: true,
  doc: null,
};

/**
 * "update" is what an agent says while it works (`agoryx say`): posted at once, not a turn, not counted
 * against the budget, and it wakes nobody — the turn's reply is still its "agent" (or "pass") message.
 */
export type MessageKind = "human" | "agent" | "pass" | "system" | "decision" | "update";

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
  /** The agent tool's nonce for an update, so an inbox replayed after a crash does not post it twice. */
  nonce?: string;
  /** The author is an agent of another room (its key used here). */
  from?: ActorOrigin;
  /**
   * What a line Agoryx writes (a system line, a decision) means, as a stable code and its params: a reader
   * says it in its own words (the UI, in Ukrainian). `text` stays the English line for the terminal, the
   * agents and older readers. Absent on messages from before codes existed.
   */
  sys?: SystemNote;
}

/** Who asked for a second look or was meant by a message, and how sure Jev was (0–100). */
export interface JevShare {
  label: string;
  percent: number;
}

/**
 * The codes of the lines Agoryx writes. `by`, `agent`: labels as the room shows them (the human's name,
 * an agent's label, a guest's "<agent>@<room>"). A code keeps its params once shipped; a new meaning is a new code.
 */
export type SystemNote =
  | { code: "run.restarted" }
  | { code: "run.budget"; turns: number; open: { questions: number; options: number; steps: number; disputes: number } }
  | { code: "run.stopped"; by: string }
  | { code: "run.continued"; by: string }
  | { code: "daemon.stopped"; by: string }
  | { code: "doc.set"; path: string }
  | { code: "doc.cleared" }
  | { code: "settings.changed"; by: string; patch: Partial<RoomSettings> }
  | { code: "room.renamed"; by: string; name: string }
  | { code: "agent.changed"; by: string; agent: string; model?: string | null; effort?: string | null }
  /** `role`: the new role (null: none any more); `label`: the agent's new name (`agent` is the old one); `profile`: given it or not. */
  | { code: "agent.set"; by: string; agent: string; role?: string | null; label?: string; profile?: boolean }
  | { code: "agent.added"; by: string; agent: string; handle: string; cli: AgentKind; model?: string; role?: string }
  | { code: "agent.removed"; by: string; agent: string }
  | { code: "turn.failed"; agent: string; cli: AgentKind; error: TurnError["kind"]; message: string }
  | { code: "agent.busy"; agent: string }
  /** The agent's CLI compacted its context (`handle`: the agent's id, `key`: the line in its session file, `at`: when). Agents never read it. */
  | { code: "agent.compacted"; agent: string; handle: string; key: string; at: string }
  | { code: "jev.second_look"; agent: string; readers: JevShare[] }
  | { code: "jev.meant_for"; agent: string; message: string; readers: JevShare[] }
  | { code: "decision"; n: number; option: string; title: string; note?: string; by: string };

export type SystemCode = SystemNote["code"];

/**
 * An agent of another room acting here with its own room's key (see actor.ts): the room records
 * who it is and where it came from, and never takes it for one of its own agents or for the human.
 */
export interface ActorOrigin {
  /** The room whose key it used. */
  room: string;
  roomName: string;
  /** Its id and label in that room. */
  agent: string;
  label: string;
  kind: AgentKind;
}

/**
 * Who did something the room records. `by` is the human's name, one of the room's agent ids, or —
 * for an agent of another room — "<agent>@<room>", with `from` saying who that is.
 */
export interface Actor {
  by: string;
  from?: ActorOrigin;
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
  | "browser"
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
  /** A shell command in full, while the label may be clipped: read for the files it names as written, never stored. */
  command?: string;
  /** The folder a shell command ran in, when the runner names one (Codex's workdir): read with it, never stored. */
  cwd?: string;
  /**
   * A shell command that leaves the agent's shell where it was, never stored: Claude's subagents' and background
   * commands, and one Claude Code reports done without exit 0 (grep found nothing, sent to the background at its timeout).
   */
  detached?: boolean;
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
// Subscription limits, as the agents' CLIs report them (see limits.ts)
// ---------------------------------------------------------------------------

/** One usage window of a subscription (Claude's five_hour / seven_day, Codex's primary / secondary). */
export interface LimitWindow {
  /** The CLI's own name for it: "five_hour", "seven_day", "seven_day_opus"… (Claude), "primary" / "secondary" (Codex). */
  id: string;
  /** Its length: Codex reports it (window_minutes); for Claude it follows from the name (five_hour → 300). */
  minutes?: number;
  /** How much of it is used, 0–100 (Claude reports a fraction, Codex a percent). */
  usedPercent: number;
  /** When it resets (ISO). */
  resetsAt?: string;
  /** When the CLI said so (ISO). */
  at: string;
}

/** What one CLI said about its limits: the windows it reported, and whether it is refusing now. */
export interface LimitReport {
  windows: LimitWindow[];
  /** Every window the account has: windows missing from it are gone, not unreported (Codex session files; Claude's unifiedWindows — not Codex app-server's rolling updates). */
  complete: boolean;
  /** Claude's status ("allowed", "allowed_warning", "rejected"). */
  status?: string;
  /** The CLI says the limit is reached: Claude's status "rejected", Codex's rate_limit_reached_type. */
  limited?: boolean;
  /** Codex's plan_type ("plus", "pro"…). */
  plan?: string;
}

/**
 * The latest a CLI said about one subscription, kept in <AGORYX_HOME>/limits.json across restarts. `account` is
 * the CLI's home when set (CLAUDE_CONFIG_DIR, CODEX_HOME), else "default": two homes are two logins.
 */
export interface LimitSnapshot extends LimitReport {
  kind: AgentKind;
  account: string;
  /** Where it was read: Claude's stream-json, Codex's app-server, or a Codex session file. */
  source: "claude-stream" | "codex-app-server" | "codex-session";
  /** When it was last updated (ISO). */
  at: string;
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export type TableOpInput =
  | { op: "ask"; text: string; many?: boolean }
  | { op: "propose"; title: string; body?: string; q?: string; file?: string }
  | { op: "object" | "support" | "evidence"; target: string; text: string; source?: string }
  | { op: "fact"; text: string }
  | { op: "settle"; text: string; q?: string }
  | { op: "concede"; text: string; target?: string }
  | { op: "next"; text: string }
  | { op: "done"; target: string }
  | { op: "withdraw"; target: string }
  | { op: "decide"; target: string; note?: string }
  | { op: "reopen"; target: string }
  /** Rewrite one's own item in place (the human can rewrite any): only the fields given change. */
  | { op: "edit"; target: string; text?: string; title?: string; body?: string; file?: string; q?: string; source?: string; many?: boolean }
  /** Take one's own item off the table entirely (the human can delete any); its id is not given out again. */
  | { op: "delete"; target: string; was?: string };

export type TableOpName = TableOpInput["op"];

/** A table op as stored: input plus who made it and the id it created (if any). */
export type TableOp = TableOpInput & {
  by: string;
  /** Id assigned to the created entity (Q3, P2, N7, F1, S2, X4, D1, C1). */
  id?: string;
  turnId?: string;
  /** Client nonce, echoed back so the agent-side CLI can learn the assigned id. */
  nonce?: string;
  /** Made by an agent of another room (its key used here). */
  from?: ActorOrigin;
};

export interface TableQuestion {
  id: string;
  text: string;
  by: string;
  seq: number;
  /**
   * decided: an option was chosen; answered: a settled conclusion closed it. A `many` question stays open
   * while options are chosen, until none is left open (then it is decided) or it is closed by hand.
   */
  status: "open" | "decided" | "answered";
  /** Its options do not exclude each other: any number of them can be chosen. */
  many?: boolean;
  decision?: string;
  /** The settled item (S3) that answers the question. */
  answer?: string;
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
  /** Who marked this step done — not always who put it on the table. */
  doneBy?: string;
  /** A fact its author (or the human) took back: it stays on the table, struck out. */
  withdrawn?: boolean;
  /** A settled item that answers a question: the question's id. */
  q?: string;
  /** A concession about a specific table item (P2, S1, Q1). */
  target?: string;
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
  /** Concessions: what someone no longer holds, and why (C1, C2…). */
  shifts: TableItem[];
  /** The highest number given out per id letter (Q, P, N…), so a deleted item's id is never reused. */
  issued?: Record<string, number>;
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
  /**
   * An agent opened this room from another room's turn (its key, or its turn's environment). The room's
   * human is still `human`; absent for rooms the human opened.
   */
  createdBy?: ActorOrigin;
}

export type RoomEventBody =
  | RoomCreatedEvent
  | { type: "message.posted"; message: RoomMessage }
  | { type: "run.started"; runId: string; trigger: string | null; budget: number | null }
  | { type: "run.extended"; runId: string; by: string; from?: ActorOrigin; turns: number }
  | {
      type: "run.ended";
      runId: string;
      reason: "quiet" | "budget" | "stopped";
      turns: number;
      /** Who stopped it (reason "stopped"); absent in logs from before, and when Agoryx itself stopped it. */
      by?: string;
      from?: ActorOrigin;
    }
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
      /**
       * Hash of the human's profile as this agent's session holds it once it has read this prompt (absent: none).
       * Only the hash: the profile itself is never written to the room.
       */
      profile?: string;
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
  /** `by`: who changed them (absent in logs from before authors were recorded). */
  | { type: "settings.changed"; patch: Partial<RoomSettings>; by?: string; from?: ActorOrigin }
  | { type: "room.renamed"; name: string; by?: string; from?: ActorOrigin }
  /**
   * An agent's model or effort changed; null: back to the CLI's own default. Its next turn uses them. Also its
   * role (null: none), its name, and whether it is given the human's profile.
   */
  | {
      type: "agent.changed";
      agent: string;
      model?: string | null;
      effort?: string | null;
      role?: string | null;
      label?: string;
      profile?: boolean;
      by?: string;
      from?: ActorOrigin;
    }
  /** The human seated another agent. It reads the conversation so far on its first turn; what was said before it came wakes it not. */
  | { type: "agent.added"; agent: RoomAgent; by?: string; from?: ActorOrigin }
  /** The human sent an agent out of the room. Its messages stay, under its name (`RoomState.former`). */
  | { type: "agent.removed"; agent: string; by?: string; from?: ActorOrigin }
  /** `folder`: the whole folder at this checkpoint, when the commit holds only the room's own files (a shared folder). */
  | { type: "commit.created"; sha: string; subject: string; files: number; folder?: string }
  /**
   * The human returned the room's folder to a checkpoint (`to`), or undid such a return (`undoOf`: that
   * return's seq, `to` its undo point). Only files changed: HEAD, the index, the messages and the table
   * stay. `undo` is the folder as it was just before, a commit kept under `ref`; `after`, the folder right
   * after. `changes` goes from the files then to the files now (A came back, D went away); `left`: paths
   * that could not be written back. `fromRoom`: made in another room sharing the folder (`undoOf` is then
   * that room's seq), recorded here so this room's agents learn of it too.
   */
  | {
      type: "workspace.reverted";
      to: string;
      undo: string;
      ref: string;
      changes: FileChange[];
      total: number;
      by: string;
      undoOf?: number;
      left?: string[];
      after?: string;
      fromRoom?: { room: string; name: string; seq: number };
    }
  /**
   * Jev's reading of an agent's message (see jev.ts): each other agent's probability that it is meant for them,
   * and, per paragraph (as prompts' paragraphs() splits it), the probability it holds a position the room still
   * has to settle — null where not asked.
   */
  | { type: "message.read"; messageId: string; by: "jev"; addressed: Record<string, number>; stances: Array<number | null> }
  | DocRevisedEvent;

/** The canonical file changed. `text` is the whole new version (omitted past MAX_DOC_TEXT). */
export interface DocRevisedEvent {
  type: "doc.revised";
  path: string;
  /** Agent id or the human's name ("<agent>@<room>" for an agent of another room). */
  by: string;
  from?: ActorOrigin;
  /** The room turn that made the change; absent for edits made outside a turn. */
  turnId?: string;
  /** Made by an agent in its own session, outside the room. */
  native?: boolean;
  /** Made during these agents' parallel turns, and the room cannot tell whose: `by` is their names joined with " or ". */
  among?: string[];
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
  among?: string[];
  hash: string;
  deleted?: boolean;
  added: number;
  removed: number;
}

export type RoomEvent = RoomEventBody & { seq: number; ts: string };

/** Non-persisted events broadcast to live listeners only. */
export type EphemeralEvent =
  | { type: "turn.stream"; turnId: string; agent: string; text: string; reset?: boolean }
  | { type: "presence"; agents: Record<string, AgentPresence> }
  /** What the agents' CLIs last said about their subscriptions (every kind and account). */
  | { type: "limits"; limits: LimitSnapshot[] };

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
  /** The profile hash this turn's prompt left the agent with, and the one it held before (restored like the cursor). */
  profile?: string;
  profileBefore?: string;
  seq: number;
  /** The seq of its turn.ended event: what was posted before it, the turn was there for. */
  endSeq?: number;
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

/** One return of the folder (see the workspace.reverted event); `undone`: the seq of the undo that reversed it. */
export interface RevertEntry {
  seq: number;
  ts: string;
  to: string;
  undo: string;
  ref: string;
  changes: FileChange[];
  total: number;
  by: string;
  undoOf?: number;
  undone?: number;
  left?: string[];
  after?: string;
  fromRoom?: { room: string; name: string; seq: number };
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
  /** Agents whose parallel turns also edited this file while this turn ran: the change is not this turn's alone. */
  with?: string[];
}

export interface RunState {
  id: string;
  trigger: string | null;
  /** Null: no limit on this run. */
  budget: number | null;
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
  /** Agents that left the room, as they were when they left: their messages are still theirs. */
  former: RoomAgent[];
  /** The seq each agent was seated at, for agents added after the room was made: nothing before it wakes them. */
  joined: Record<string, number>;
  settings: RoomSettings;
  createdAt: string;
  seq: number;
  messages: MessageEntry[];
  turns: TurnState[];
  runs: RunState[];
  sessions: Record<string, { sessionId: string; boundAt: string }>;
  /** Highest seq each agent has seen (via prompt or authorship). */
  cursors: Record<string, number>;
  /** Hash of the human's profile each agent's session holds ("" or absent: none). */
  profiles: Record<string, string>;
  table: TableState;
  commits: Array<{ sha: string; subject: string; files: number; seq: number; folder?: string }>;
  /** Returns of the folder to a checkpoint and their undos, oldest first. */
  reverts: RevertEntry[];
  /** Revisions of the canonical file (texts stay in the event log). */
  docRevisions: DocRevision[];
  counters: Record<string, number>;
  /** Agents of other rooms that acted here, by their handle here ("<agent>@<room>"). */
  guests: Record<string, ActorOrigin>;
  /** The agent that opened this room from another room, if one did. */
  createdBy?: ActorOrigin;
}

// ---------------------------------------------------------------------------
// An agent's own session, read back from its CLI's session file (see transcript.ts)
// ---------------------------------------------------------------------------

export interface TranscriptImage {
  /** A data: URL, when the image is in the session or a readable file. */
  src?: string;
  /** Where the agent saw it, when it is a file. */
  path?: string;
}

export interface TranscriptDiff {
  path: string;
  op: "add" | "update" | "delete";
  /** Unified diff with ---/+++ headers. */
  patch: string;
}

export interface TranscriptTodo {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

interface TranscriptBase {
  id: string;
  at?: string;
}

export type TranscriptEntry =
  | (TranscriptBase & { kind: "user"; text: string; agoryx?: boolean; images?: TranscriptImage[] })
  | (TranscriptBase & { kind: "assistant"; text: string; commentary?: boolean; /** The room's pass: nothing to add this turn (text: its note, if any). */ pass?: boolean })
  | (TranscriptBase & { kind: "thinking"; text: string })
  | (TranscriptBase & {
      kind: "tool";
      /** The tool's own name (Bash, Edit, exec, mcp server.tool…). */
      tool: string;
      category: ActivityKind;
      title: string;
      detail?: string;
      input?: string;
      output?: string;
      status: "running" | "ok" | "fail";
      diffs?: TranscriptDiff[];
      todos?: TranscriptTodo[];
      images?: TranscriptImage[];
    })
  | (TranscriptBase & { kind: "system"; code: "compacted" | "interrupted" | "error"; text?: string });

export type TranscriptTool = Extract<TranscriptEntry, { kind: "tool" }>;

export interface Transcript {
  entries: TranscriptEntry[];
  /** Byte offset the entries start from; 0 means the whole session. Pass it as `end` to read what came before. */
  start: number;
  /** Where reading stopped (the file size, less a partial last line). */
  end: number;
  size: number;
}

/** The models and effort levels each CLI offers (see models.ts). */
export interface ModelChoice {
  id: string;
  label: string;
  description?: string;
  /** Levels this model takes; the kind's `efforts` when absent. */
  efforts?: string[];
  defaultEffort?: string;
}

export interface KindModels {
  models: ModelChoice[];
  efforts: string[];
}

export type AgentModels = Record<AgentKind, KindModels>;

// ---------------------------------------------------------------------------
// Attention: a room that waits for the human (internal/agora/attention.ts)
// ---------------------------------------------------------------------------

export type AttentionReason = "done" | "budget" | "stopped" | "error" | "mention";

/** A room that waits for the human: at most one per room, until the human sees it. */
export interface AttentionItem {
  /** The room's id. */
  room: string;
  /** The room's current name, read when the item is read, so a rename shows. */
  name: string;
  /** The event that needs the human; stable across restarts, so (room, seq) is the key. */
  seq: number;
  ts: string;
  reason: AttentionReason;
  /** Who mentioned, stopped or failed: an agent's label, or "<agent>@<room>" for a guest. */
  by?: string;
  /** One line, whitespace collapsed, at most 160 characters with "…". */
  text: string;
}
