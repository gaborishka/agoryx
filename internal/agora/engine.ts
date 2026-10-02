import { closeSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { clearTurnContext, TURN_FILE_ENV, turnContextPath, writeTurnContext } from "./turn-context.js";
import { actorFields, actorLabel, AGENT_KEY_ENV, describeSettings, originName } from "./actor.js";
import { baselineRevision, diffLines, diffStats, docHash, docWritable, MAX_DOC_TEXT, normalizeDocPath, readDoc, renderDiff, statDoc } from "./doc.js";
import { embed, mediaRefs } from "./media.js";
import { locateNativeSession, scanNativeSession, type NativeCompaction, type NativeExchange } from "./native.js";
import { activeRun } from "./projection.js";
import { inTurnAt, wakesAgent } from "./wakes.js";
import { limitAccount } from "./limits-store.js";
import { profileBriefing, profileUpdate, readProfile, seesProfile } from "./profile.js";
import { buildTurnPrompt, forHumanOnly, paragraphs, parseMentions, passNote } from "./prompts.js";
import { JEV_ENV, type ReadMessage, type SecondLook } from "./jev.js";
import { cleanRole, MAX_ROLE_CHARS, parseAgents, validEffort, validModel } from "./roster.js";
import { truncate, type AgentRunner, type LiveProcess, type TurnRequest, type TurnResult } from "./runners/types.js";
import { MAX_REVERT_CHANGES, REVERT_FAILURE, RevertError, revertTarget, type RevertRequest } from "./revert.js";
import { RoomStore } from "./store.js";
import { fromWorkspace, namesFile, shellWriteTargets, shellWrites, type ShellCwd } from "./shell-writes.js";
import { describeTableOp, openOnTable, prepareTableOp, renderTableMarkdown, TableOpError } from "./table.js";
import type {
  Activity,
  Actor,
  AgentKind,
  AgentPresence,
  DocRevision,
  FileChange,
  LimitReport,
  LimitSnapshot,
  MessageEntry,
  MessageKind,
  RevertEntry,
  RoomAgent,
  RoomEvent,
  RoomMessage,
  RoomSettings,
  RunState,
  SystemNote,
  TableOp,
  TurnState,
} from "./types.js";
import {
  checkpointCommit,
  checkpointFolder,
  checkpointRef,
  clearStaleAcks,
  diffSnapshots,
  drainOpsInbox,
  forkPoint,
  markTurnLive,
  MAX_TREE_SNAPSHOT_DIRTY,
  messagePath,
  otherRoomTurns,
  prepareWorkspace,
  readTurnPatch,
  markRevert,
  restoreWorkspace,
  revertMarkers,
  revertRef,
  roomDirName,
  snapshotChanges,
  snapshotTree,
  treeChangedPaths,
  treeChanges,
  workspacePaths,
  workspaceRooms,
  workspaceDiff,
  workspaceTracking,
  writeAck,
  writeRoomMessage,
  writeTurnPatch,
  type ChangeSnapshot,
  type WorkspacePaths,
} from "./workspace.js";

export interface EngineOptions {
  store: RoomStore;
  runners: Partial<Record<AgentKind, AgentRunner>>;
  /** Directory containing the `agoryx` shim for agents (prepended to PATH). */
  shimDir?: string;
  /** Command agents are told to use for the table. */
  agentCli?: string;
  env?: NodeJS.ProcessEnv;
  /** The human's profile (<AGORYX_HOME>/profile.md, see profile.ts). Without it no agent is given one. */
  profilePath?: string;
  opsPollMs?: number;
  /** How often to read the agents' native sessions for turns taken outside the room (0 = never). */
  nativePollMs?: number;
  log?: (message: string) => void;
  /**
   * Issues an agent's key to the daemon (see actor.ts), put in its turns' environment as
   * AGORYX_AGENT_KEY: the human's CLI in the agent's shell then acts as that agent, not as the human.
   */
  agentKey?: (agentId: string) => string | undefined;
  /**
   * Keep each agent's CLI process up between its turns (Claude `--input-format stream-json`, Codex
   * `app-server`), so a turn does not wait for the CLI to start. Off unless given. `idleMs`: how long an
   * unused process is kept (default 5 minutes). A runner without a live mode, and a process that fails to
   * start, fall back to one process per turn without a word.
   */
  live?: boolean | { idleMs?: number };
  /**
   * Asked when the human put something to one agent alone and its answer names no one: whether another
   * agent should take a look (see jev.ts). Without it such an answer wakes nobody else.
   */
  secondLook?: SecondLook | null;
  /** How sure secondLook must be before it wakes an agent (default one half); readMessage wakes at the same mark. */
  secondLookThreshold?: number;
  /**
   * Reads each agent's message (see jev.ts): who it is meant for, @name or not, and which paragraphs take a
   * position. Without it the room goes by @names and its word lists alone.
   */
  readMessage?: ReadMessage | null;
  /** What an agent's CLI said about its subscription's limits (see limits.ts); only shown, never acted on. */
  onLimits?: (snapshot: LimitSnapshot) => void;
}

/** A process kept up for an agent between turns. */
interface LiveEntry {
  proc: LiveProcess;
  idleTimer?: NodeJS.Timeout;
  /** Turns it has taken: one that has taken none is new, and its failure to start says something about live mode itself. */
  turns: number;
  /** Where its shell was when its last turn ended: Claude Code keeps a `cd` into the next turn of the same process. */
  cwd?: ShellCwd;
}

export const DEFAULT_LIVE_IDLE_MS = 5 * 60 * 1000;

/** The files a command's label names as written, or none when it cannot be read. */
const labelWrites = (label: string): string[] => {
  try {
    return shellWriteTargets(label);
  } catch {
    return [];
  }
};

/** Where the engine is in an agent's native session file. */
interface NativeTracker {
  sessionId: string;
  file: string | null;
  offset: number;
  lastAgoryx: boolean;
  size: number;
  mtimeMs: number;
  /** A native exchange is in progress (someone is talking to the agent in its own app). */
  openNative: boolean;
  nextLocateAt: number;
  /** When a native exchange was last seen open or imported. */
  nativeAt?: number;
}

/** A change to the canonical file this soon after a native exchange is credited to that agent. */
const NATIVE_EDIT_MS = 20_000;

export class DocConflictError extends Error {
  constructor(readonly current: { text: string; hash: string } | null) {
    super("the canonical file changed since you opened it");
    this.name = "DocConflictError";
  }
}

/** The longest delay a Node timer can hold. */
export const MAX_TURN_TIMEOUT_MS = 2 ** 31 - 1;

export class DocTooLargeError extends Error {
  constructor() {
    super(`the canonical file is bigger than ${MAX_DOC_TEXT / 1024} KB; edit it in the workspace, not here`);
    this.name = "DocTooLargeError";
  }
}

/** A native exchange still being written this recently means the agent is busy there. */
const NATIVE_BUSY_MS = 5 * 60 * 1000;
const NATIVE_RELOCATE_MS = 30_000;

/** What can change about an agent in a room (see updateAgent). */
export interface AgentPatch {
  model?: string | null;
  effort?: string | null;
  role?: string | null;
  label?: string;
  profile?: boolean;
}

interface RunningTurn {
  turnId: string;
  agent: RoomAgent;
  controller: AbortController;
  snapshot: ChangeSnapshot | null;
  /** The workspace as a git tree when the turn started (null without git, or too dirty to snapshot). */
  tree: string | null;
  startedAt: number;
  done: Promise<void>;
  /** Hash of the canonical file as the human last saved it while this turn ran (not the turn's work). */
  outsideDoc?: string;
  /** The workspace when the last turn that ran alongside this one (in any room here) ended: what changed after it is this turn's. */
  handoff?: { dirty: ChangeSnapshot | null; tree: string | null; at: number };
}

const LOCK_FILE = "engine.lock";

/** Past this, the canonical file's diff in a turn prompt is cut; the agent reads the file for the rest. */
const MAX_DOC_DELTA_CHARS = 6_000;

interface LockSnapshot {
  ino: number;
  text: string;
  pid: number;
}

/** The lock file's identity and content, or null if it is gone. */
const readLock = (path: string): LockSnapshot | null => {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const text = readFileSync(fd, "utf8");
    return { ino: fstatSync(fd).ino, text, pid: Number.parseInt(text, 10) };
  } finally {
    closeSync(fd);
  }
};

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export class RoomLockedError extends Error {}

/** Rooms driven by an engine in this process (the lock file covers other processes). */
const lockedHere = new Set<string>();

/** Engines in this process, by workspace: a turn that ends hands the workspace to the others' running turns. */
const enginesHere = new Map<string, Set<RoomEngine>>();

/** One key for one directory, however it was reached (a symlinked path is the same workspace). */
const workspaceKey = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/**
 * One turn's exact patch: the file written when it ended, or regenerated from
 * the git trees in its turn.ended event. Needs only the log and the workspace,
 * so the CLI and a daemon that does not drive the room can read it too.
 */
export const roomTurnPatch = (store: RoomStore, turnId: string): { patch: string; truncated: boolean } | null => {
  const turn = store.state.turns.find((entry) => entry.id === turnId);
  if (!turn?.changes?.length) return null;
  const ended = store.events.find((event) => event.type === "turn.ended" && event.turnId === turnId);
  const trees = ended?.type === "turn.ended" ? ended.trees : undefined;
  const author = store.state.agents.find((agent) => agent.id === turn.agent)?.label;
  return readTurnPatch(workspacePaths(store.state.workspace, store.state.id), turnId, {
    ...(trees ? { trees } : {}),
    files: turn.changes.map((change) => change.path),
    ...(author ? { author } : {}),
    ...(turn.endedAt ? { endedAt: turn.endedAt } : {}),
    // An old .agoryx/turns/ file is this room's only when no other room ever had this workspace.
    ownsLegacy: () => roomsSharingWorkspace(store).length === 1,
  });
};

/** Where the room's whole change is counted from: its worktree's fork point, or the tree before its first turn. */
export type RoomDiffBase = { kind: "worktree"; ref: string; sha: string } | { kind: "turn"; turnId: string; ts: string };

/**
 * Everything the workspace differs by since the room began: the folder as it is now (untracked files too)
 * against the commit its worktree branched from, or else the tree taken at the start of its first turn that
 * has one. Other rooms in the same folder and the human's own edits show too: it is the folder, not a turn.
 * Null when there is nothing to count from yet (no turn has run) or git can't tell.
 */
export const roomWorkspaceDiff = (
  store: RoomStore,
): ({ base: RoomDiffBase } & { changes: FileChange[]; patch: string; truncated: boolean }) | null => {
  const { workspace, worktree } = store.state;
  if (worktree) {
    const sha = forkPoint(workspace, worktree.base);
    const diff = sha ? workspaceDiff(workspace, sha) : null;
    if (sha && diff) return { base: { kind: "worktree", ref: worktree.base, sha }, ...diff };
  }
  for (const event of store.events) {
    if (event.type !== "turn.ended" || !event.trees) continue;
    const diff = workspaceDiff(workspace, event.trees.before);
    // The first turn's tree may be gone (git prunes loose objects); the next one still counts from early on.
    if (diff) return { base: { kind: "turn", turnId: event.turnId, ts: event.ts }, ...diff };
  }
  return null;
};

/**
 * Every room whose workspace this room's is, this one included: by the room logs next to its own
 * (a room that never opened since rooms got their own directories counts too), and by the room
 * directories rooms from elsewhere left in the workspace. Room logs are the persisted owner record.
 */
export const roomsSharingWorkspace = (store: RoomStore): Array<{ id: string; name: string }> => {
  const here = resolve(store.state.workspace);
  const rooms = new Map<string, string>();
  for (const id of workspaceRooms(store.state.workspace)) rooms.set(id, id);
  for (const room of RoomStore.list(dirname(store.dir))) {
    const id = roomDirName(room.id);
    if (id && resolve(room.workspace) === here) rooms.set(id, room.name);
  }
  rooms.set(roomDirName(store.state.id)!, store.state.name);
  return [...rooms].map(([id, name]) => ({ id, name })).sort((a, b) => a.id.localeCompare(b.id));
};

/**
 * Drives one room. There is no orchestrator deciding who speaks: every new
 * message wakes the agents that have not seen it, each agent gets a turn with
 * only what is new for it, a pass is silence, and a run ends when nobody has
 * anything unseen (quiet), the human stops it, or — only in a room given a turn
 * limit — the limit is spent.
 */
export class RoomEngine {
  readonly store: RoomStore;
  readonly ws: WorkspacePaths;
  private readonly runners: Partial<Record<AgentKind, AgentRunner>>;
  private readonly shimDir?: string;
  private readonly agentCli: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly profilePath?: string;
  private readonly opsPollMs: number;
  private readonly nativePollMs: number;
  private readonly native = new Map<string, NativeTracker>();
  /** The room's last event when this engine opened it: a compaction from before is history, one after it is news even if no engine ran then. */
  private readonly compactedSince: number;
  private compactedKeys?: Set<string>;
  private nativeKeys?: Set<string>;
  private nativeTimer: NodeJS.Timeout | undefined;
  private lastPresence = "";
  /** Last stat of the canonical file, so the sync tick reads it only when it changed. */
  private docWatch = "";
  /** When the canonical file was last seen as `docWatch` (another room's turn since then may have changed it). */
  private docWatchAt = Date.now();
  private retryTimer: NodeJS.Timeout | undefined;
  /** Agents already announced as busy in their own session (cleared when they are free). */
  private readonly nativeBusyNoted = new Set<string>();
  private readonly log: (message: string) => void;
  private readonly onLimits: ((snapshot: LimitSnapshot) => void) | undefined;
  private readonly running = new Map<string, RunningTurn>();
  /** Agents that failed hard (spawn/auth) sit out until the next human message. */
  private readonly benched = new Set<string>();
  /** Agents being sent out of the room: no new turn starts for them while theirs stops. */
  private readonly leaving = new Set<string>();
  private idleWaiters: Array<() => void> = [];
  private opsTimer: NodeJS.Timeout | undefined;
  private scheduleQueued = false;
  private readonly secondLook: SecondLook | null;
  private readonly secondLookThreshold: number;
  private readonly readMessage: ReadMessage | null;
  /** Turns whose answer is being weighed for a second look, and messages Jev is reading: the run stays open until they are. */
  private readonly consulting = new Set<string>();
  /** Agents whose message Jev is reading, with how many: each waits for it before its next turn, whose delta uses it. */
  private readonly beingRead = new Map<string, number>();
  private stopping = false;
  private heldWork: { trigger: string | null; minTurns: number | undefined; actor: Actor | undefined } | null = null;
  private closed = false;
  private lockHeld = false;
  private readonly agentKey: ((agentId: string) => string | undefined) | undefined;
  private readonly liveIdleMs: number;
  private readonly liveOn: boolean;
  /** Live processes by agent: at most one each, used by one turn at a time. */
  private readonly live = new Map<string, LiveEntry>();
  /** Agents whose live process could not start: they run one process per turn from then on. */
  private readonly liveOff = new Set<string>();

  constructor(options: EngineOptions) {
    this.store = options.store;
    this.compactedSince = Date.parse(this.store.events.at(-1)?.ts ?? "") || Date.now();
    this.runners = options.runners;
    this.shimDir = options.shimDir;
    this.agentCli = options.agentCli ?? "agoryx";
    this.agentKey = options.agentKey;
    this.liveOn = Boolean(options.live);
    this.liveIdleMs = typeof options.live === "object" && options.live.idleMs !== undefined ? options.live.idleMs : DEFAULT_LIVE_IDLE_MS;
    this.env = options.env ?? process.env;
    this.secondLook = options.secondLook ?? null;
    this.secondLookThreshold = options.secondLookThreshold ?? 0.5;
    this.readMessage = options.readMessage ?? null;
    this.profilePath = options.profilePath;
    this.opsPollMs = options.opsPollMs ?? 250;
    this.nativePollMs = options.nativePollMs ?? 2000;
    this.log = options.log ?? (() => {});
    this.onLimits = options.onLimits;
    this.acquireLock();
    try {
      this.ws = prepareWorkspace(this.state.workspace, {
        initGit: this.state.createdWorkspace,
        room: { id: this.state.id, name: this.state.name },
      });
      clearStaleAcks(this.ws);
      clearStaleAcks(workspacePaths(this.state.workspace));
      this.publishSharingRooms();
      const peers = enginesHere.get(workspaceKey(this.state.workspace)) ?? new Set<RoomEngine>();
      enginesHere.set(workspaceKey(this.state.workspace), peers.add(this));
      this.writeTableFile();
      this.writeMissingMessages();
      this.recover();
      this.recordDocBaseline();
      this.absorbForeignReverts();
      // Table ops written while no engine ran, or taken by one that died before applying them.
      this.ingestOps();
    } catch (error) {
      // A room that fails to open must not stay locked until the process exits.
      this.releaseLock();
      throw error;
    }
    if (this.nativePollMs > 0) {
      this.nativeTimer = setInterval(() => this.syncNative(), this.nativePollMs);
      this.nativeTimer.unref();
      // Agents can write to the table from their own sessions too, not only during room turns.
      this.ensureOpsPolling();
    }
  }

  get state() {
    return this.store.state;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  private acquireLock(): void {
    const lock = join(this.store.dir, LOCK_FILE);
    if (lockedHere.has(this.store.dir)) {
      throw new RoomLockedError(`room ${this.store.id} is already running in this process`);
    }
    // Created exclusively, so two processes opening the room at once cannot both win. A lock left by a
    // dead process (or by this one, before a restart in place) is removed and the create retried once.
    for (let attempt = 0; ; attempt += 1) {
      try {
        const fd = openSync(lock, "wx");
        try {
          writeSync(fd, String(process.pid));
        } finally {
          closeSync(fd);
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw error;
        const seen = readLock(lock);
        if (seen && Number.isFinite(seen.pid) && seen.pid !== process.pid && pidAlive(seen.pid)) {
          throw new RoomLockedError(`room ${this.store.id} is already running in process ${seen.pid}`);
        }
        if (seen) this.discardStaleLock(lock, seen);
      }
    }
    lockedHere.add(this.store.dir);
    this.lockHeld = true;
  }

  /**
   * Removes the stale lock `seen` — and only it. Another process may have recovered the same stale
   * lock a moment earlier and written its own; a plain unlink would delete that fresh lock and let two
   * engines run the room. So the lock is first renamed aside (atomic), and the renamed file is deleted
   * only if it is still the stale one (same inode and content); otherwise it is put back.
   */
  private discardStaleLock(lock: string, seen: LockSnapshot): void {
    const aside = `${lock}.stale-${process.pid}-${Date.now()}`;
    try {
      renameSync(lock, aside);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return; // someone else removed it
      throw error;
    }
    const moved = readLock(aside);
    if (moved && moved.ino === seen.ino && moved.text === seen.text) {
      rmSync(aside, { force: true });
      return;
    }
    // Not the stale lock we judged: a fresh one another process just wrote. Restore it (link fails if
    // yet another lock appeared meanwhile, which then stands) and report the room as taken.
    try {
      linkSync(aside, lock);
    } catch {
      // the lock that is there now wins
    }
    rmSync(aside, { force: true });
    throw new RoomLockedError(`room ${this.store.id} is already running in process ${moved?.pid ?? "?"}`);
  }

  private releaseLock(): void {
    if (!this.lockHeld) return;
    rmSync(join(this.store.dir, LOCK_FILE), { force: true });
    lockedHere.delete(this.store.dir);
    this.lockHeld = false;
  }

  /** Turns that were running when a previous process died are closed out. */
  private recover(): void {
    const stale = this.state.turns.filter((turn) => turn.status === "running");
    for (const turn of stale) {
      // Its marker may carry this very pid (a restart in place): other rooms must not wait on it forever.
      markTurnLive(this.state.workspace, { room: this.state.id, turn: turn.id, pid: process.pid, startedAt: Date.parse(turn.startedAt), endedAt: Date.now() });
      this.store.append({
        type: "turn.ended",
        turnId: turn.id,
        agent: turn.agent,
        status: "interrupted",
        sessionId: turn.sessionId,
        durationMs: Date.now() - Date.parse(turn.startedAt),
        unseen: true,
      });
    }
    // Never resume spending turns on our own after a restart: the human decides.
    const run = activeRun(this.state);
    if (run) {
      this.store.append({ type: "run.ended", runId: run.id, reason: "stopped", turns: run.used });
      this.postSystem("Agoryx restarted in the middle of a run, so the run was stopped. Write anything, or ask for another round, to continue.", { code: "run.restarted" }, false);
    }
  }

  /** `by`: who stopped the daemon (so the run stopped with it is credited to them). */
  async close(by?: Actor): Promise<void> {
    if (this.closed) return;
    await this.stop("shutdown", by);
    this.closed = true;
    this.closeAllLive();
    if (this.opsTimer) clearInterval(this.opsTimer);
    if (this.nativeTimer) clearInterval(this.nativeTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    enginesHere.get(workspaceKey(this.state.workspace))?.delete(this);
    this.releaseLock();
  }

  /** Resolves when no turn is running and no run is active. */
  waitIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolveWaiter) => this.idleWaiters.push(resolveWaiter));
  }

  isIdle(): boolean {
    return this.running.size === 0 && !activeRun(this.state);
  }

  presence(): Record<string, AgentPresence> {
    return Object.fromEntries(
      this.state.agents.map((agent) => [
        agent.id,
        this.running.has(agent.id) ? "working" : this.nativeOpen(agent) ? "native" : "idle",
      ]),
    );
  }

  /** Tell listeners when who-is-busy changes; "native" is not in the event log, so it travels as an ephemeral. */
  private notePresence(): void {
    if (this.closed) return;
    const agents = this.presence();
    const key = JSON.stringify(agents);
    if (key === this.lastPresence) return;
    this.lastPresence = key;
    this.store.emit({ type: "presence", agents });
  }

  // -------------------------------------------------------------------------
  // Human actions
  // -------------------------------------------------------------------------

  /** Someone acting: the human by default; an agent id; or an Actor (an agent of another room). */
  private actor(by?: string | Actor): Actor {
    if (by === undefined) return { by: this.state.human };
    return typeof by === "string" ? { by } : by;
  }

  /** Whether the room's human did this (not one of its agents, not an agent of another room). */
  private byHuman(actor: Actor): boolean {
    return !actor.from && !this.state.agents.some((agent) => agent.id === actor.by);
  }

  /** A line in the transcript saying what someone did. It wakes nobody. */
  private postNote(actor: Actor, text: string, sys: SystemNote): MessageEntry {
    return this.postMessage({ author: actor.by, kind: "system", text, sys, mentions: [], wakes: false, ...(actor.from ? { from: actor.from } : {}) });
  }

  postHuman(text: string, author = this.state.human): MessageEntry {
    const body = text.trim();
    if (!body) throw new Error("empty message");
    const handles = [...this.state.agents.map((agent) => agent.id), this.state.human.toLowerCase()];
    this.benched.clear();
    const message = this.postMessage({
      author,
      kind: "human",
      text: body,
      mentions: parseMentions(body, handles),
      wakes: true,
    });
    this.startWork(message.id);
    return message;
  }

  /**
   * A message from whoever sent it: the human's is the human's; one of this room's agents, or an agent
   * of another room, posts as itself (kind "agent", never "human") and it wakes the others like any reply.
   */
  post(text: string, by?: string | Actor): MessageEntry {
    const actor = this.actor(by);
    if (this.byHuman(actor)) return this.postHuman(text, actor.by);
    const body = text.trim();
    if (!body) throw new Error("empty message");
    const handles = [...this.state.agents.map((agent) => agent.id), this.state.human.toLowerCase()];
    const message = this.postMessage({
      author: actor.by,
      kind: "agent",
      text: body,
      mentions: parseMentions(body, handles),
      wakes: true,
      ...(actor.from ? { from: actor.from } : {}),
    });
    this.startWork(message.id, undefined, actor);
    return message;
  }

  /** "One more round": every agent gets another turn even with nothing new. */
  continueRun(by?: string | Actor): void {
    const actor = this.actor(by);
    this.benched.clear();
    const who = actorLabel(this.state, actor.by);
    const message = this.postMessage({
      author: actor.by,
      kind: "system",
      text: `${who} asked for another round.`,
      sys: { code: "run.continued", by: who },
      mentions: [],
      wakes: true,
      ...(actor.from ? { from: actor.from } : {}),
    });
    this.startWork(message.id, this.state.agents.length, actor);
  }

  tableOp(raw: unknown, by?: string | Actor): TableOp {
    const actor = this.actor(by);
    const isHuman = this.byHuman(actor);
    const op = this.applyTableOp(raw, actor, isHuman, undefined);
    // The human's move, or one from another room (it has no reply here to ride on), is news for the agents.
    if (isHuman || actor.from) {
      if (isHuman) this.benched.clear();
      this.startWork(null, undefined, actor);
    }
    return op;
  }

  /**
   * Starts or extends the run for something someone did (the human, by default). While a stop is under way the run being
   * stopped must not absorb it, so the work is held and started as a fresh run once the stop is done.
   */
  private startWork(trigger: string | null, minTurns?: number, actor?: Actor): void {
    if (this.stopping) {
      const held = this.heldWork;
      this.heldWork = {
        trigger: held?.trigger ?? trigger,
        minTurns: Math.max(held?.minTurns ?? 0, minTurns ?? 0) || undefined,
        actor: held?.actor ?? actor,
      };
      return;
    }
    this.ensureRun(trigger, minTurns, actor);
    this.requestSchedule();
  }

  updateSettings(patch: Partial<RoomSettings>, by?: string | Actor): void {
    const actor = this.actor(by);
    const clean: Partial<RoomSettings> = {};
    if (patch.budget === null || (typeof patch.budget === "number" && patch.budget >= 1 && patch.budget <= 100)) {
      clean.budget = patch.budget === null ? null : Math.round(patch.budget);
    }
    if (typeof patch.network === "boolean") clean.network = patch.network;
    if (typeof patch.autoCommit === "boolean") clean.autoCommit = patch.autoCommit;
    if (patch.access === "workspace" || patch.access === "readonly") clean.access = patch.access;
    if (patch.turnTimeoutMs !== undefined) {
      const ms = patch.turnTimeoutMs;
      // Node timers overflow past 2^31-1 ms and fire at once: a "longer" limit would kill every turn immediately.
      if (typeof ms !== "number" || !Number.isInteger(ms) || ms < 30_000 || ms > MAX_TURN_TIMEOUT_MS) {
        throw new Error(`the turn limit must be a whole number of ms from 30000 to ${MAX_TURN_TIMEOUT_MS} (about 24 days)`);
      }
      clean.turnTimeoutMs = ms;
    }
    if (patch.doc !== undefined) {
      const doc = patch.doc === null || patch.doc === "" ? null : normalizeDocPath(patch.doc);
      if (doc === null && patch.doc) throw new Error("the canonical file must be a path inside the workspace (not in .git or .agoryx)");
      if (doc !== (this.state.settings.doc ?? null)) clean.doc = doc;
    }
    if (Object.keys(clean).length === 0) return;
    this.store.append({ type: "settings.changed", patch: clean, ...actorFields(actor) });
    if (clean.doc !== undefined) this.recordDocBaseline();
    // The human sees what they changed; an agent's change is said in the transcript, by name.
    if (!this.byHuman(actor)) {
      const who = actorLabel(this.state, actor.by);
      this.postNote(actor, `${who} changed the settings: ${describeSettings(clean).join(", ")}.`, { code: "settings.changed", by: who, patch: clean });
    } else if (clean.doc !== undefined) {
      if (clean.doc) this.postSystem(`The room's canonical file is now ${clean.doc}.`, { code: "doc.set", path: clean.doc }, false);
      else this.postSystem("The room no longer has a canonical file.", { code: "doc.cleared" }, false);
    }
  }

  /**
   * Another model or effort for an agent, from its next turn on (a live process restarts for it). Empty
   * or null: back to the CLI's own default. Said in the transcript by whoever changed it; wakes nobody.
   * Its role, name and profile are the human's to set: the room reads the change in its next turn.
   */
  updateAgent(agentId: string, patch: AgentPatch, by?: string | Actor): RoomAgent {
    const actor = this.actor(by);
    const agent = this.state.agents.find((entry) => entry.id === agentId);
    if (!agent) throw new Error(`no agent @${agentId} in this room`);
    const change: { model?: string | null; effort?: string | null } = {};
    if (patch.model !== undefined) {
      const model = typeof patch.model === "string" ? patch.model.trim() : patch.model;
      if (model !== null && typeof model !== "string") throw new Error("model must be a string or null");
      if (model && !validModel(model)) throw new Error(`"${model}" is not a model name the ${agent.kind} CLI could be given`);
      if ((model || null) !== (agent.model ?? null)) change.model = model || null;
    }
    if (patch.effort !== undefined) {
      const effort = typeof patch.effort === "string" ? patch.effort.trim() : patch.effort;
      if (effort !== null && typeof effort !== "string") throw new Error("effort must be a string or null");
      if (effort && !validEffort(effort)) throw new Error(`"${effort}" is not an effort level (like "high" or "xhigh")`);
      if ((effort || null) !== (agent.effort ?? null)) change.effort = effort || null;
    }
    const set = this.agentSettings(agent, patch, actor);
    const who = actorLabel(this.state, actor.by);
    if (Object.keys(change).length) {
      this.store.append({ type: "agent.changed", agent: agent.id, ...change, ...actorFields(actor) });
      const parts = [
        ...(change.model !== undefined ? [change.model ? `model ${change.model}` : "the CLI's default model"] : []),
        ...(change.effort !== undefined ? [change.effort ? `effort ${change.effort}` : "the CLI's default effort"] : []),
      ];
      this.postNote(actor, `${who} set ${agent.label} to ${parts.join(", ")}.`, { code: "agent.changed", by: who, agent: agent.label, ...change });
    }
    if (Object.keys(set).length) {
      this.store.append({ type: "agent.changed", agent: agent.id, ...set, ...actorFields(actor) });
      const handle = `${agent.label} (@${agent.id})`;
      const parts = [
        ...(set.label !== undefined ? [`renamed ${handle} to ${set.label}`] : []),
        ...(set.role !== undefined
          ? [set.role ? `gave ${set.label ?? agent.label} this role: "${set.role}"` : `took ${set.label ?? agent.label}'s role away — it acts as itself now`]
          : []),
        ...(set.profile !== undefined ? [set.profile ? `gave ${set.label ?? agent.label} their profile` : `stopped giving ${set.label ?? agent.label} their profile`] : []),
      ];
      this.postNote(actor, `${who} ${parts.join("; ")}.`, { code: "agent.set", by: who, agent: agent.label, ...set });
    }
    if (set.profile !== undefined || set.role !== undefined) this.notePresence();
    return this.state.agents.find((entry) => entry.id === agentId)!;
  }

  /** The part of a patch only the human sets (role, name, profile), checked; what differs from now. */
  private agentSettings(agent: RoomAgent, patch: AgentPatch, actor: Actor): { role?: string | null; label?: string; profile?: boolean } {
    const set: { role?: string | null; label?: string; profile?: boolean } = {};
    if (patch.role === undefined && patch.label === undefined && patch.profile === undefined) return set;
    if (!this.byHuman(actor)) throw new Error("only the human sets an agent's role, name or profile");
    if (patch.role !== undefined) {
      if (patch.role !== null && typeof patch.role !== "string") throw new Error("role must be text or null");
      const role = patch.role === null ? "" : cleanRole(patch.role);
      if (role.length > MAX_ROLE_CHARS) throw new Error(`a role is at most ${MAX_ROLE_CHARS} characters`);
      if ((role || null) !== (agent.role ?? null)) set.role = role || null;
    }
    if (patch.label !== undefined) {
      if (typeof patch.label !== "string") throw new Error("label must be text");
      const label = patch.label.replace(/\s+/g, " ").trim();
      if (!label || label.length > 40) throw new Error("an agent's name is 1–40 characters");
      if (this.state.agents.some((entry) => entry.id !== agent.id && entry.label.toLowerCase() === label.toLowerCase())) {
        throw new Error(`another agent is already called ${label}`);
      }
      if (label !== agent.label) set.label = label;
    }
    if (patch.profile !== undefined) {
      if (typeof patch.profile !== "boolean") throw new Error("profile must be true or false");
      if (patch.profile !== (agent.profile !== false)) set.profile = patch.profile;
    }
    return set;
  }

  /**
   * The human seats another agent. It wakes on what is said from now on; on its first turn it reads the
   * conversation so far (an agent that was here before resumes its own session, from where it left).
   */
  addAgent(raw: unknown, by?: string | Actor): RoomAgent {
    const actor = this.actor(by);
    if (!this.byHuman(actor)) throw new Error("only the human seats agents");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error('expected an agent like { "kind": "claude", "model": "opus" }');
    const fields = { ...(raw as Record<string, unknown>) };
    const kind = typeof fields.kind === "string" ? fields.kind : "";
    // No handle given: the kind's, or the kind's with a number when it is taken.
    if (fields.id === undefined && kind) {
      const taken = (id: string) => this.state.agents.some((entry) => entry.id === id) || this.state.former.some((entry) => entry.id === id && entry.kind !== kind);
      let n = 1;
      while (taken(n === 1 ? kind : `${kind}-${n}`)) n += 1;
      fields.id = n === 1 ? kind : `${kind}-${n}`;
      if (fields.label === undefined && n > 1) fields.label = `${kind[0]!.toUpperCase()}${kind.slice(1)} ${n}`;
    }
    const seated = this.state.agents.map(({ id, kind, label }) => ({ id, kind, label }));
    let agent: RoomAgent;
    try {
      agent = parseAgents([...seated, fields], "agent").at(-1)!;
    } catch (error) {
      throw new Error((error instanceof Error ? error.message : String(error)).replace(/^agent\[\d+\]: /, ""));
    }
    if (agent.id === this.state.human.toLowerCase()) throw new Error(`@${agent.id} is ${this.state.human}'s handle`);
    const before = this.state.former.find((entry) => entry.id === agent.id);
    if (before && before.kind !== agent.kind) throw new Error(`@${agent.id} was a ${before.kind} agent here: give this one another handle`);
    this.store.append({ type: "agent.added", agent, ...actorFields(actor) });
    const who = actorLabel(this.state, actor.by);
    const model = agent.model ? ` on ${agent.model}` : "";
    const role = agent.role ? `, with this role: "${agent.role}"` : "";
    this.postNote(actor, `${who} seated ${agent.label} (@${agent.id}, ${agent.kind} CLI${model}) in the room${role}.`, {
      code: "agent.added",
      by: who,
      agent: agent.label,
      handle: agent.id,
      cli: agent.kind,
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.role ? { role: agent.role } : {}),
    });
    this.notePresence();
    return agent;
  }

  /**
   * The human sends an agent out of the room: a turn it is in is stopped first. Its messages stay; it
   * can be seated again later and goes on with its own session. The last agent cannot leave.
   */
  async removeAgent(agentId: string, by?: string | Actor): Promise<void> {
    const actor = this.actor(by);
    if (!this.byHuman(actor)) throw new Error("only the human sends agents out of the room");
    const agent = this.state.agents.find((entry) => entry.id === agentId);
    if (!agent) throw new Error(`no agent @${agentId} in this room`);
    if (this.state.agents.length < 2) throw new Error("a room needs at least one agent");
    const turn = this.running.get(agent.id);
    this.leaving.add(agent.id);
    try {
      if (turn) {
        turn.controller.abort();
        await turn.done;
      }
    } finally {
      this.leaving.delete(agent.id);
    }
    // It may have been removed while its turn was stopping.
    if (!this.state.agents.some((entry) => entry.id === agent.id)) return;
    this.store.append({ type: "agent.removed", agent: agent.id, ...actorFields(actor) });
    this.closeLive(agent.id, "left the room");
    this.benched.delete(agent.id);
    const who = actorLabel(this.state, actor.by);
    this.postNote(actor, `${who} sent ${agent.label} (@${agent.id}) out of the room.`, { code: "agent.removed", by: who, agent: agent.label });
    this.notePresence();
    this.requestSchedule();
  }

  /** A new name for the room; it wakes nobody. */
  rename(name: string, by?: string | Actor): void {
    const actor = this.actor(by);
    const clean = name.replace(/\s+/g, " ").trim().slice(0, 120);
    if (!clean) throw new Error("a room needs a name");
    if (clean === this.state.name) return;
    this.store.append({ type: "room.renamed", name: clean, ...actorFields(actor) });
    if (!this.byHuman(actor)) {
      const who = actorLabel(this.state, actor.by);
      this.postNote(actor, `${who} renamed the room to "${clean}".`, { code: "room.renamed", by: who, name: clean });
    }
  }

  /**
   * "human": someone stopped the run (`by`, the human by default); "shutdown": Agoryx is closing the
   * room — with `by` when someone stopped the daemon.
   */
  async stop(reason: "human" | "shutdown" = "human", by?: string | Actor): Promise<void> {
    const actor = by === undefined && reason === "shutdown" ? undefined : this.actor(by);
    this.stopping = true;
    const turns = [...this.running.values()];
    for (const turn of turns) turn.controller.abort();
    await Promise.all(turns.map((turn) => turn.done));
    const run = activeRun(this.state);
    if (run) {
      this.store.append({ type: "run.ended", runId: run.id, reason: "stopped", turns: run.used, ...(actor ? actorFields(actor) : {}) });
      if (actor && this.byHuman(actor)) {
        if (reason === "human") this.postSystem(`${actor.by} stopped the run.`, { code: "run.stopped", by: actor.by }, false);
      } else if (actor) {
        const who = actorLabel(this.state, actor.by);
        if (reason === "human") this.postNote(actor, `${who} stopped the run.`, { code: "run.stopped", by: who });
        else this.postNote(actor, `${who} stopped the daemon, so the run was stopped.`, { code: "daemon.stopped", by: who });
      }
      this.checkpoint(run);
    }
    this.stopping = false;
    const held = this.heldWork;
    this.heldWork = null;
    if (held && reason === "human" && !this.closed) {
      this.startWork(held.trigger, held.minTurns, held.actor);
      return;
    }
    this.notifyIdle();
  }

  // -------------------------------------------------------------------------
  // Returning the folder to a checkpoint
  // -------------------------------------------------------------------------

  /** Why the folder cannot be returned right now (someone is at work in it), or null. */
  revertBusy(): string | null {
    if (this.running.size > 0 || activeRun(this.state) || this.stopping) return "agents are working in this room; stop the run first";
    const foreign = otherRoomTurns(this.state.workspace, this.state.id, Date.now()).filter((turn) => turn.endedAt === undefined);
    if (foreign.length) return `a turn of ${this.roomHandles(foreign).join(", ")} is running in this folder; wait for it, or stop it there`;
    return null;
  }

  /**
   * The human returns the folder to one of the room's checkpoints, or undoes such a return. Only files
   * change: the folder as it is is kept first (a commit under refs/agoryx/revert/…, never a stash), and
   * the messages and the table stay, since they are what was said. Nobody is woken; the agents read it
   * in their next turn, those of other rooms sharing the folder too. `tree`: the folder as the human's
   * preview saw it; if it moved on, nothing happens.
   */
  revertWorkspace(request: RevertRequest & { tree?: string }, by?: string | Actor): RevertEntry {
    const actor = this.actor(by);
    if (!this.byHuman(actor)) throw new RevertError("agent", "only the human returns the folder to a checkpoint");
    const target = revertTarget(this.state, request);
    const busy = this.revertBusy();
    if (busy) throw new RevertError("busy", busy);
    const ref = revertRef(this.state.id, this.state.reverts.length + 1);
    const what = target.undoOf ? `undoing return #${target.undoOf.seq}` : `returning it to ${target.sha.slice(0, 8)}`;
    const result = restoreWorkspace(this.state.workspace, target.source, ref, `agoryx(${this.state.name}): the folder before ${what}`, request.tree);
    if ("error" in result) throw new RevertError(result.error, REVERT_FAILURE[result.error]);
    this.store.append({
      type: "workspace.reverted",
      to: target.sha,
      undo: result.undo,
      ref,
      changes: result.changes.slice(0, MAX_REVERT_CHANGES),
      total: result.changes.length,
      by: actor.by,
      ...(target.undoOf ? { undoOf: target.undoOf.seq } : {}),
      ...(result.left.length ? { left: result.left.slice(0, MAX_REVERT_CHANGES) } : {}),
      ...(result.after ? { after: result.after } : {}),
    });
    const entry = this.state.reverts.at(-1)!;
    // The canonical file moved with the folder: a revision by whoever returned it, as any other edit.
    this.recordDoc(actor.by);
    // Other rooms in this folder: their agents' files may have moved too.
    markRevert(this.state.workspace, {
      room: this.state.id,
      name: this.state.name,
      seq: entry.seq,
      ts: entry.ts,
      to: entry.to,
      undo: entry.undo,
      changes: entry.changes,
      total: entry.total,
      ...(entry.undoOf !== undefined ? { undoOf: entry.undoOf } : {}),
      ...(entry.left ? { left: entry.left } : {}),
    });
    for (const peer of enginesHere.get(workspaceKey(this.state.workspace)) ?? []) if (peer !== this) peer.absorbForeignReverts();
    // With checkpoints on, the return is a checkpoint of its own, so the next run's is not credited with it.
    if (this.state.settings.autoCommit) {
      const shared = roomsSharingWorkspace(this.store).length > 1;
      const who = actorLabel(this.state, entry.by);
      const subject = `agoryx(${this.state.name}): ${entry.undoOf !== undefined ? `${who} undid return #${entry.undoOf} of the folder` : `${who} returned the folder to ${entry.to.slice(0, 8)}`}`;
      this.recordCheckpoint(subject, "", shared ? [...new Set(result.changes.map((change) => change.path))] : undefined);
    }
    return entry;
  }

  /**
   * Returns made from other rooms sharing this folder, recorded here once each (those made before this room
   * existed are not its business), so this room's agents learn of them in their next turn.
   */
  absorbForeignReverts(): void {
    const since = Date.parse(this.state.createdAt) || 0;
    let doc = false;
    for (const marker of revertMarkers(this.state.workspace, this.state.id)) {
      if ((Date.parse(marker.ts) || 0) < since) continue;
      if (this.state.reverts.some((entry) => entry.fromRoom?.room === marker.room && entry.fromRoom.seq === marker.seq)) continue;
      this.store.append({
        type: "workspace.reverted",
        to: marker.to,
        undo: marker.undo,
        ref: "",
        changes: marker.changes.slice(0, MAX_REVERT_CHANGES),
        total: marker.total,
        by: this.state.human,
        ...(marker.undoOf !== undefined ? { undoOf: marker.undoOf } : {}),
        ...(marker.left?.length ? { left: marker.left.slice(0, MAX_REVERT_CHANGES) } : {}),
        fromRoom: { room: marker.room, name: marker.name, seq: marker.seq },
      });
      doc ||= Boolean(this.state.settings.doc && marker.changes.some((change) => change.path === this.state.settings.doc));
    }
    if (doc) this.recordDoc(this.state.human);
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  private ensureRun(trigger: string | null, minTurns?: number, actor?: Actor): RunState {
    const budget = this.state.settings.budget;
    const wanted = minTurns ?? budget;
    const run = activeRun(this.state);
    if (run) {
      // A run without a limit has room for any number of turns: nothing to extend.
      if (run.budget === null || wanted === null) return run;
      const remaining = run.budget - run.used;
      if (remaining < wanted) {
        this.store.append({ type: "run.extended", runId: run.id, ...actorFields(actor ?? this.actor()), turns: wanted - remaining });
      }
      return run;
    }
    const runId = `r${(this.state.counters.r ?? 0) + 1}`;
    // "Another round" in a room without a limit is a run without one too: it ends when the room goes quiet.
    this.store.append({ type: "run.started", runId, trigger, budget: budget === null ? null : (minTurns ?? budget) });
    return activeRun(this.state)!;
  }

  private wakes(event: RoomEvent, agent: RoomAgent): boolean {
    return wakesAgent(this.state, event, agent);
  }

  /** What the human said to this agent alone (`@claude …`, no one else), when that is all that woke this turn; else null. */
  private askedAlone(agent: RoomAgent, turnId: string): RoomMessage[] | null {
    const turn = this.state.turns.find((entry) => entry.id === turnId);
    if (!turn) return null;
    const woke = this.store.since(turn.cursorBefore).filter((event) => event.seq <= turn.cursor && this.wakes(event, agent));
    const asked: RoomMessage[] = [];
    for (const event of woke) {
      if (event.type !== "message.posted" || event.message.kind !== "human" || event.message.author !== this.state.human) return null;
      const agents = event.message.mentions.filter((handle) => handle === "all" || this.state.agents.some((entry) => entry.id === handle));
      if (agents.length !== 1 || agents[0] !== agent.id) return null;
      asked.push(event.message);
    }
    return asked.length ? asked : null;
  }

  /**
   * An answer to the human alone wakes nobody; secondLook (Jev) may still judge another agent's look worth a
   * turn. Then Agoryx says so in the room, with how sure it is, and that agent is woken by that note.
   * Unreachable or unsure: nobody is woken. The run stays open until the answer is in.
   */
  private weighSecondLook(agent: RoomAgent, turnId: string, runId: string, asked: RoomMessage[], answer: RoomMessage, changes: FileChange[]): void {
    const others = this.state.agents.filter((entry) => entry.id !== agent.id && !this.benched.has(entry.id) && this.runners[entry.kind]);
    if (!this.secondLook || !others.length) return;
    this.consulting.add(turnId);
    const done = () => {
      this.consulting.delete(turnId);
      this.requestSchedule();
    };
    this.secondLook({
      question: asked.map((message) => message.text).join("\n\n"),
      answeredBy: agent.label,
      answer: answer.text,
      changed: changes.map((change) => `${change.path} +${change.added} −${change.removed}`),
      others: others.map((entry) => ({ id: entry.id, label: entry.label })),
    })
      .then((verdict) => {
        const worth = others.filter((entry) => (verdict.worth[entry.id] ?? 0) >= this.secondLookThreshold);
        const said = others.map((entry) => `${entry.id} ${verdict.worth[entry.id]?.toFixed(2) ?? "?"}`).join(", ");
        this.log(`${turnId} second look: ${said} (${verdict.ms} ms, ${verdict.tokens} tokens)${worth.length ? "" : " — nobody woken"}`);
        // The run it was for has ended (stopped): what it says no longer has a run to join.
        if (!worth.length || this.closed || this.stopping || activeRun(this.state)?.id !== runId) return;
        const names = worth.map((entry) => entry.label);
        const readers = worth.map((entry) => ({ label: entry.label, percent: Math.round(verdict.worth[entry.id]! * 100) }));
        const sure = readers.map((reader) => `${reader.label} ${reader.percent}%`).join(", ");
        this.postMessage({
          author: "agoryx",
          kind: "system",
          text: `Jev: a second look at ${agent.label}'s answer seems worth a turn (${sure}) — ${names.join(" and ")} ${names.length === 1 ? "takes" : "take"} a look.`,
          sys: { code: "jev.second_look", agent: agent.label, readers },
          mentions: worth.map((entry) => entry.id),
          wakes: true,
          turnId,
        });
      })
      .catch((error: unknown) => this.log(`${turnId} second look unavailable: ${error instanceof Error ? error.message : String(error)}`))
      .finally(done);
  }

  /**
   * Jev reads what an agent said: who it is meant for, @name or not, and which paragraphs take a position.
   * The reading is kept in the room (message.read) for the author's next delta and the others' gists. An agent
   * it is meant for that the message did not wake and that has not read it — an update or a reply in its own
   * session without @name, an answer that went back to the human — is woken by a note that says so. It only
   * ever adds wakes. When it wakes nobody, or Jev is out of reach, an answer to the human alone still gets
   * `then`, its second look.
   */
  private readPosted(message: MessageEntry, author: RoomAgent, then?: () => void): void {
    const others = this.state.agents.filter((entry) => entry.id !== author.id);
    if (!this.readMessage || !others.length) {
      then?.();
      return;
    }
    const key = `read:${message.id}`;
    this.consulting.add(key);
    this.beingRead.set(author.id, (this.beingRead.get(author.id) ?? 0) + 1);
    let woke = false;
    this.readMessage({ author: author.label, paragraphs: paragraphs(message.text), others: others.map((entry) => ({ id: entry.id, label: entry.label })) })
      .then((verdict) => {
        if (this.closed) return;
        this.store.append({ type: "message.read", messageId: message.id, by: "jev", addressed: verdict.addressed, stances: verdict.stances });
        const said = others.map((entry) => `${entry.id} ${verdict.addressed[entry.id]?.toFixed(2) ?? "?"}`).join(", ");
        const stances = verdict.stances.map((p) => (p === null ? "-" : p.toFixed(2))).join(" ");
        this.log(`${message.id} read: meant for ${said}; stances ${stances || "-"} (${verdict.ms} ms, ${verdict.tokens} tokens)`);
        const posted: RoomEvent = { type: "message.posted", message, seq: message.seq, ts: message.ts };
        const meant = others.filter(
          (entry) =>
            (verdict.addressed[entry.id] ?? 0) >= this.secondLookThreshold &&
            !this.benched.has(entry.id) &&
            this.runners[entry.kind] &&
            !this.wakes(posted, entry) &&
            (this.state.cursors[entry.id] ?? 0) < message.seq &&
            !(message.kind === "update" && this.inTurnAt(entry.id, message.seq)),
        );
        // The run the message was said in has ended (stopped): what it asked no longer has a run to join.
        if (!meant.length || this.stopping || (message.runId && activeRun(this.state)?.id !== message.runId)) return;
        const names = meant.map((entry) => entry.label);
        const readers = meant.map((entry) => ({ label: entry.label, percent: Math.round(verdict.addressed[entry.id]! * 100) }));
        const sure = readers.map((reader) => `${reader.label} ${reader.percent}%`).join(", ");
        const note = this.postMessage({
          author: "agoryx",
          kind: "system",
          text: `Jev: ${author.label}'s ${message.id} reads as meant for ${names.join(" and ")} (${sure}), with no @ — ${names.join(" and ")} ${names.length === 1 ? "is" : "are"} woken to answer it.`,
          sys: { code: "jev.meant_for", agent: author.label, message: message.id, readers },
          mentions: meant.map((entry) => entry.id),
          wakes: true,
          ...(message.turnId ? { turnId: message.turnId } : {}),
        });
        woke = true;
        if (!activeRun(this.state)) {
          this.benched.clear();
          this.ensureRun(note.id, undefined, { by: author.id });
        }
      })
      .catch((error: unknown) => this.log(`${message.id} read unavailable: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        if (!woke && !this.closed) then?.();
        this.consulting.delete(key);
        const left = (this.beingRead.get(author.id) ?? 1) - 1;
        if (left > 0) this.beingRead.set(author.id, left);
        else this.beingRead.delete(author.id);
        this.requestSchedule();
      });
  }

  private addressesOthers(mentions: string[], agent: RoomAgent): boolean {
    return mentions.some((handle) => handle === "all" || (handle !== agent.id && this.state.agents.some((entry) => entry.id === handle)));
  }

  /** Whether this agent was in a turn when event `seq` was posted (and so could read it with `read new`). */
  private inTurnAt(agentId: string, seq: number): boolean {
    return inTurnAt(this.state, agentId, seq);
  }

  /**
   * Whether an agent at work asked this one something while it sat idle — by @name, or so Jev reads it (its
   * note names the turn, still running): it answers now, not after.
   */
  private askedMidTurn(agent: RoomAgent): boolean {
    const cursor = this.state.cursors[agent.id] ?? 0;
    return this.store.since(cursor).some((event) => {
      if (event.type !== "message.posted" || !this.wakes(event, agent)) return false;
      const { message } = event;
      if (message.kind === "update") return true;
      return message.author === "agoryx" && message.kind === "system" && Boolean(message.turnId) && this.state.turns.some((turn) => turn.id === message.turnId && turn.status === "running");
    });
  }

  private pending(agent: RoomAgent): boolean {
    return this.firstWake(agent) !== null;
  }

  /** The oldest unseen event that wakes this agent, or null. */
  private firstWake(agent: RoomAgent): RoomEvent | null {
    const cursor = this.state.cursors[agent.id] ?? 0;
    return this.store.since(cursor).find((event) => this.wakes(event, agent)) ?? null;
  }

  /** Whether the human said something this agent has not answered yet. */
  private humanWaiting(agent: RoomAgent): boolean {
    const cursor = this.state.cursors[agent.id] ?? 0;
    return this.store
      .since(cursor)
      .some((event) => this.wakes(event, agent) && (event.type === "table.op" || (event.type === "message.posted" && event.message.author === this.state.human)));
  }

  requestSchedule(): void {
    if (this.scheduleQueued || this.closed) return;
    this.scheduleQueued = true;
    queueMicrotask(() => {
      this.scheduleQueued = false;
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.stopping || this.closed) return;
    // Read what was said in the agents' own sessions first, so every delta is current.
    this.syncNative();
    const run = activeRun(this.state);
    if (!run) {
      this.notifyIdle();
      return;
    }
    let blockedByBudget = false;
    let waitingOnNative = false;
    // One conversation, not two: the human's message is answered by everyone at once
    // (in parallel, from the same point); after that the agents take the floor one
    // at a time, and each sees what the other just said. Whoever has waited longest goes first.
    const candidates = this.state.agents
      .filter((agent) => !this.running.has(agent.id) && !this.beingRead.has(agent.id) && !this.benched.has(agent.id) && !this.leaving.has(agent.id) && this.runners[agent.kind])
      .map((agent) => ({ agent, wake: this.firstWake(agent) }))
      .filter((entry): entry is { agent: RoomAgent; wake: RoomEvent } => entry.wake !== null)
      .sort((a, b) => a.wake.seq - b.wake.seq);
    for (const { agent } of candidates) {
      if (this.running.size > 0 && !this.humanWaiting(agent) && !this.askedMidTurn(agent)) continue;
      if (run.budget !== null && run.used >= run.budget) {
        blockedByBudget = true;
        continue;
      }
      if (this.nativeBusy(agent)) {
        waitingOnNative = true;
        continue;
      }
      this.startTurn(agent, run);
    }
    if (this.running.size > 0) return;
    // An answer is being weighed for a second look: the run ends once that is decided.
    if (this.consulting.size > 0) return;
    if (waitingOnNative) {
      this.retrySoon();
      return;
    }
    // Quiescence: nothing running and nobody can act.
    this.store.append({
      type: "run.ended",
      runId: run.id,
      reason: blockedByBudget ? "budget" : "quiet",
      turns: run.used,
    });
    if (blockedByBudget) {
      const open = openOnTable(this.state.table);
      const count = (n: number, one: string, many: string) => (n ? [`${n} ${n === 1 ? one : many}`] : []);
      const left = [
        ...count(open.questions, "open question", "open questions"),
        ...count(open.options, "undecided proposal", "undecided proposals"),
        ...count(open.steps, "step to do", "steps to do"),
        ...count(open.disputes, "contested point", "contested points"),
      ];
      this.postSystem(
        left.length
          ? `Turn budget reached (${run.used} agent turns). Still open on the table: ${left.join(", ")} — write anything, or ask for another round, to continue.`
          : `Turn budget reached (${run.used} agent turns). Nothing is left open on the table — write anything to continue.`,
        { code: "run.budget", turns: run.used, open: { questions: open.questions, options: open.options, steps: open.steps, disputes: open.disputes } },
        false,
      );
    }
    this.checkpoint(run);
    this.notifyIdle();
  }

  private retrySoon(): void {
    if (this.retryTimer || this.closed) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.requestSchedule();
    }, Math.max(250, Math.min(this.nativePollMs || 2000, 2000)));
    this.retryTimer.unref();
  }

  private notifyIdle(): void {
    if (!this.isIdle()) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const waiter of waiters) waiter();
  }

  // -------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------

  /**
   * The environment of an agent's turn. For a process started for the turn: this turn's id, the messages it
   * has seen and the agent's key. For a live process, which keeps one environment across turns, none of those
   * (a stale turn or key must not outlive its turn): the tools find the current turn in AGORYX_TURN_FILE.
   */
  private agentEnv(agent: RoomAgent, turnId: string, live = false): NodeJS.ProcessEnv {
    const path = this.env.PATH ?? process.env.PATH ?? "";
    // Never another agent's key (or turn) inherited from where Agoryx was started: this agent's own, or none.
    const { [AGENT_KEY_ENV]: _inherited, [TURN_FILE_ENV]: _file, AGORYX_TURN: _turn, AGORYX_SEEN: _seen, ...env } = this.env;
    // Nor the daemon's Jev key: it is the daemon's, not something an agent's commands get to use.
    for (const name of JEV_ENV) delete env[name];
    const key = this.agentKey?.(agent.id);
    return {
      ...env,
      ...(key && !live ? { [AGENT_KEY_ENV]: key } : {}),
      PATH: this.shimDir ? `${this.shimDir}:${path}` : path,
      AGORYX_ROOM: this.state.id,
      AGORYX_ROOM_NAME: this.state.name,
      AGORYX_AGENT: agent.id,
      ...(live
        ? { [TURN_FILE_ENV]: this.turnFile(agent.id) }
        : {
            AGORYX_TURN: turnId,
            // The last message this turn's delta covers: `agoryx read new` prints what was said after it.
            AGORYX_SEEN: `m${this.state.counters.m ?? 0}`,
          }),
      AGORYX_OPS_DIR: this.ws.opsDir,
      AGORYX_TABLE: this.ws.tableFile,
      // Login shells may reorder PATH so another `agoryx` wins; env vars survive.
      ...(this.shimDir ? { AGORYX_CLI: join(this.shimDir, "agoryx") } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Live processes
  // -------------------------------------------------------------------------

  private turnFile(agentId: string): string {
    return turnContextPath(this.store.dir, agentId);
  }

  /** Take an agent's live process down (settings changed, a person spoke to its session, idle, closing). */
  private closeLive(agentId: string, why?: string): void {
    const entry = this.live.get(agentId);
    if (!entry) return;
    this.live.delete(agentId);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.proc.close();
    clearTurnContext(this.turnFile(agentId));
    if (why) this.log(`${agentId} live process closed (${why})`);
  }

  private closeAllLive(): void {
    for (const agentId of [...this.live.keys()]) this.closeLive(agentId, "room closed");
  }

  /**
   * One turn on the agent's live process, started (or restarted) as needed. `liveUnavailable` in the result
   * means nothing ran: the caller runs the turn with a process of its own.
   */
  private async runLive(agent: RoomAgent, runner: AgentRunner, request: TurnRequest, turnId: string, callbacks: Parameters<AgentRunner["run"]>[1]): Promise<TurnResult> {
    let entry = this.live.get(agent.id);
    const fingerprint = runner.liveFingerprint!(request);
    // Anything fixed when the process started that differs now, or another session than the one it holds.
    if (entry && (!entry.proc.alive || entry.proc.fingerprint !== fingerprint || (entry.proc.sessionId ?? null) !== request.sessionId)) {
      this.closeLive(agent.id, entry.proc.alive ? "settings or session changed" : "process gone");
      entry = undefined;
    }
    if (!entry) {
      try {
        entry = { proc: runner.openLive!(request), turns: 0 };
      } catch (error) {
        return {
          status: "error",
          text: "",
          sessionId: null,
          error: { kind: "unknown", message: error instanceof Error ? error.message : String(error) },
          liveUnavailable: true,
        };
      }
      this.live.set(agent.id, entry);
    }
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
    const proc = entry.proc;
    const file = this.turnFile(agent.id);
    const key = this.agentKey?.(agent.id);
    writeTurnContext(file, {
      room: this.state.id,
      agent: agent.id,
      turn: turnId,
      seen: `m${this.state.counters.m ?? 0}`,
      ...(key ? { key } : {}),
    });
    const reused = entry.turns > 0;
    entry.turns += 1;
    if (reused && entry.cwd !== undefined && agent.kind === "claude") this.shellCwds.set(turnId, entry.cwd);
    let result: TurnResult;
    try {
      result = await proc.runTurn(request, callbacks);
    } finally {
      // The turn is over: what names it (and the agent's key) goes with it.
      clearTurnContext(file);
      entry.cwd = this.shellAt(turnId);
    }
    if (result.liveUnavailable && reused && !request.signal.aborted && !this.closed) {
      // A process that had served turns died between them: that says nothing about live mode. Start another.
      this.closeLive(agent.id, "process died between turns");
      this.freshShell(turnId);
      return this.runLive(agent, runner, request, turnId, callbacks);
    }
    if (this.live.get(agent.id) !== entry) {
      // Closed while the turn ran (the room is closing): nothing to keep.
      proc.close();
    } else if (result.status !== "ok" || !proc.alive) {
      // Whatever went wrong, the process is in an unknown state: the next turn starts a clean one.
      this.closeLive(agent.id);
    } else if (this.liveIdleMs > 0) {
      entry.idleTimer = setTimeout(() => this.closeLive(agent.id, "idle"), this.liveIdleMs);
      entry.idleTimer.unref();
    } else {
      this.closeLive(agent.id);
    }
    return result;
  }

  /** Show the shim as plain `agoryx` in activity traces instead of its absolute path. */
  /** Rewrites of machine paths into what a reader recognises, longest first. */
  private tidyRules?: Array<[string, string]>;

  /** What each running turn's shell commands named as written, read from the whole command before its label is clipped. */
  private shellWrites = new Map<string, Set<string>>();
  /** Where a Claude turn's shell is after its last command ended: Claude Code keeps a `cd` for the commands after it; Codex starts each at the workspace. */
  private shellCwds = new Map<string, ShellCwd>();
  /** The commands already seen: a runner reports each when it starts and again when it ends. */
  private shellNoted = new Set<string>();
  /**
   * A Claude turn's commands that have been asked for and not ended, in the order they were. Each is read when it ends,
   * from where the shell is then: commands asked for in one message are reported together but run one after another,
   * and a `cd` holds only from a command that exited 0 in the shell, which is known only at its end.
   */
  private shellPending = new Map<string, { turnId: string; command: string; detached?: boolean }>();
  /** The workspace as a command may spell it: its path and its real path. */
  private roots?: string[];

  /** A turn's next try is a new process: its shell starts at the workspace, and its commands' ids may repeat the last one's. */
  private freshShell(turnId: string): void {
    this.shellCwds.delete(turnId);
    for (const key of [...this.shellNoted]) if (key.startsWith(`${turnId} `)) this.shellNoted.delete(key);
    for (const [key, entry] of [...this.shellPending]) if (entry.turnId === turnId) this.shellPending.delete(key);
  }

  /** Where a Claude turn's shell is now ("" its workspace, null not known). */
  private shellAt(turnId: string): ShellCwd {
    return this.shellCwds.has(turnId) ? this.shellCwds.get(turnId)! : "";
  }

  private workspaceRoots(): string[] {
    if (!this.roots) {
      let real = this.state.workspace;
      try { real = realpathSync(real); } catch { /* keep as given */ }
      this.roots = [...new Set([this.state.workspace, real])];
    }
    return this.roots;
  }

  /** A command read from `from`: the files it names as written, and where it leaves the shell (null: not known). */
  private readShell(turnId: string, command: string, from: ShellCwd, quiet = false): { targets: string[]; cwd: ShellCwd } {
    try {
      // Read as written: `cd <workspace>/ui` goes to ui from wherever the shell was, not from there into ./ui.
      const { targets, cwd } = shellWrites(command, from, this.workspaceRoots());
      // Claude Code takes its shell back to the workspace after a command that left it.
      return { targets, cwd: cwd !== null && (cwd.startsWith("/") || cwd === ".." || cwd.startsWith("../")) ? "" : cwd };
    } catch (error) {
      if (!quiet) this.log(`${turnId}: command not read for written files: ${error instanceof Error ? error.message : String(error)}`);
      // Not read: where the shell is from here is not known either.
      return { targets: [], cwd: null };
    }
  }

  /**
   * What a Claude turn's commands that have not ended may have written so far, each read from where its shell is: none of
   * them has moved it. Of its own commands only the first asked for has started (the others in its message wait for it);
   * a subagent's or one in the background runs beside them.
   */
  private pendingWrites(turnId: string): string[] {
    const found: string[] = [];
    const at = this.shellAt(turnId);
    let waiting = false;
    for (const entry of this.shellPending.values()) {
      if (entry.turnId !== turnId || (waiting && !entry.detached)) continue;
      if (!entry.detached) waiting = true;
      found.push(...this.readShell(turnId, entry.command, at, true).targets);
    }
    return found;
  }

  private addShellWrites(turnId: string, targets: readonly string[]): void {
    if (targets.length === 0) return;
    const known = this.shellWrites.get(turnId) ?? new Set<string>();
    for (const target of targets) known.add(target);
    this.shellWrites.set(turnId, known);
  }

  private noteShellWrites(turnId: string, activity: Activity, carriesCwd: boolean): void {
    const key = `${turnId} ${activity.id}`;
    const pending = this.shellPending.get(key);
    if (this.shellNoted.has(key) && (!pending || activity.status === "running")) return;
    this.shellNoted.add(key);
    const command = activity.command ?? pending?.command ?? activity.label;
    if (carriesCwd && activity.status === "running") {
      // Claude's: read when it ends, from where the commands before it left the shell.
      this.shellPending.set(key, { turnId, command, ...(activity.detached ? { detached: true } : {}) });
      return;
    }
    this.shellPending.delete(key);
    // Claude's shell is where its last command left it; Codex's at the workspace, or in the folder it named for the command.
    const from = carriesCwd ? this.shellAt(turnId) : activity.cwd ? fromWorkspace(activity.cwd, this.workspaceRoots()) : "";
    const { targets, cwd } = this.readShell(turnId, command, from);
    // Its `cd` holds only if it exited 0 in the shell (Claude Code reads the shell's folder after `<command> &&`): not
    // if it failed, exited 1 to a grep, went on in the background, or was a subagent's.
    if (carriesCwd && activity.status !== "fail" && !activity.detached) this.shellCwds.set(turnId, cwd);
    this.addShellWrites(turnId, targets);
  }

  /** A turn is over: its commands that had started and never said they ended are read as they stand, and move its shell nowhere. */
  private flushShell(turnId: string): void {
    this.addShellWrites(turnId, this.pendingWrites(turnId));
    for (const [key, entry] of [...this.shellPending]) if (entry.turnId === turnId) this.shellPending.delete(key);
  }

  private tidyText(text: string): string {
    if (!this.tidyRules) {
      const variants = (path: string) => {
        let real = path;
        try { real = realpathSync(path); } catch { /* keep as given */ }
        return [...new Set([path, real])];
      };
      const rules: Array<[string, string]> = [];
      if (this.shimDir) {
        for (const dir of variants(this.shimDir)) {
          rules.push([`"${join(dir, "agoryx")}"`, "agoryx"], [join(dir, "agoryx"), "agoryx"]);
        }
      }
      for (const root of variants(this.state.workspace)) rules.push([`${root}/`, ""], [root, "."]);
      this.tidyRules = rules.sort((a, b) => b[0].length - a[0].length);
    }
    return this.tidyRules!.reduce((acc, [from, to]) => acc.split(from).join(to), text);
  }

  private tidyActivity({ command: _command, cwd: _cwd, detached: _detached, ...activity }: Activity): Activity {
    // Runners keep labels long enough for this to see whole paths; clip afterwards.
    const tidy = (text: string, max: number) => truncate(this.tidyText(text), max);
    return {
      ...activity,
      label: tidy(activity.label, 200),
      ...(activity.detail ? { detail: tidy(activity.detail, 240) } : {}),
    };
  }

  private agentCliHint(): { command: string; path?: string } {
    return this.shimDir ? { command: "agoryx", path: join(this.shimDir, "agoryx") } : { command: this.agentCli };
  }

  private startTurn(agent: RoomAgent, run: RunState): void {
    // A return made from another room (of another process) since: in this turn's delta.
    this.absorbForeignReverts();
    const runner = this.runners[agent.kind]!;
    const turnId = `t${(this.state.counters.t ?? 0) + 1}`;
    const fromSeq = this.state.cursors[agent.id] ?? 0;
    const cursor = this.state.seq;
    const sessionId = this.state.sessions[agent.id]?.sessionId ?? null;
    const turnsLeft = run.budget === null ? null : run.budget - run.used - 1;
    // Read once per turn: the version given is the version recorded. An agent it is off for never gets a word of it.
    const profile = seesProfile(agent) ? readProfile(this.profilePath) : null;
    const held = this.state.profiles[agent.id] ?? "";
    const promptFor = (fresh: boolean, rejoin: boolean) =>
      buildTurnPrompt({
        state: this.state,
        agent,
        agentCli: this.agentCliHint(),
        env: this.env,
        events: this.store.since(rejoin ? 0 : fromSeq).filter((event) => event.seq <= cursor),
        turnsLeft,
        fresh,
        rejoin,
        doc: this.docDelta(agent, fromSeq, fresh),
        profile: fresh ? (profile ? profileBriefing(profile, this.state.human) : null) : profileUpdate(profile, held, this.state.human),
        tracking: fresh ? workspaceTracking(this.state.workspace) : undefined,
      });
    const prompt = promptFor(!sessionId, false);

    this.store.append({
      type: "turn.started",
      turnId,
      agent: agent.id,
      runId: run.id,
      cursor,
      resume: Boolean(sessionId),
      sessionId,
      promptChars: prompt.length,
      ...(profile ? { profile: profile.hash } : {}),
    });

    const controller = new AbortController();
    const startedAt = Date.now();
    // Announced before the snapshot: another room's turn ending after this sees it overlapped.
    markTurnLive(this.state.workspace, { room: this.state.id, turn: turnId, pid: process.pid, startedAt });
    const snapshot = snapshotChanges(this.state.workspace);
    const tree = snapshot && snapshot.size <= MAX_TREE_SNAPSHOT_DIRTY ? snapshotTree(this.state.workspace) : null;
    const env = this.agentEnv(agent, turnId);

    const callbacks = {
      onSession: (id: string) => {
        if (this.state.sessions[agent.id]?.sessionId !== id) {
          this.store.append({ type: "session.bound", agent: agent.id, sessionId: id });
        }
      },
      onText: (text: string, reset?: boolean) => {
        this.store.emit({ type: "turn.stream", turnId, agent: agent.id, text, ...(reset ? { reset } : {}) });
      },
      onShellLost: () => this.shellCwds.set(turnId, null),
      onActivity: (activity: Activity) => {
        if (activity.kind === "command") this.noteShellWrites(turnId, activity, agent.kind === "claude");
        this.store.append({ type: "turn.activity", turnId, agent: agent.id, activity: this.tidyActivity(activity) });
      },
      onLimits: (report: LimitReport, source: LimitSnapshot["source"]) => {
        if (!this.onLimits) return;
        try {
          this.onLimits({ ...report, kind: agent.kind, account: limitAccount(agent.kind, env), source, at: new Date().toISOString() });
        } catch (error) {
          this.log(`${turnId} limits not kept: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    };

    const execute = async (): Promise<TurnResult> => {
      const request = {
        prompt,
        cwd: this.state.workspace,
        sessionId,
        roomName: this.state.name,
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.effort ? { effort: agent.effort } : {}),
        settings: this.state.settings,
        env,
        signal: controller.signal,
      };
      const canLive = this.liveOn && !this.liveOff.has(agent.id) && Boolean(runner.openLive && runner.liveFingerprint);
      const liveEnv = canLive ? this.agentEnv(agent, turnId, true) : env;
      const runOnce = async (req: TurnRequest): Promise<TurnResult> => {
        this.freshShell(turnId);
        if (canLive && !this.liveOff.has(agent.id) && !this.closed) {
          const result = await this.runLive(agent, runner, { ...req, env: liveEnv }, turnId, callbacks);
          if (!result.liveUnavailable) return result;
          // It could not take the turn (did not start, or died before the turn began): one process per turn from here on.
          this.liveOff.add(agent.id);
          this.closeLive(agent.id);
          this.log(`${agent.id} live mode unavailable (${result.error?.message ?? "unknown"}); using one process per turn`);
          this.freshShell(turnId);
        }
        return runner.run(req, callbacks);
      };
      let result = await runOnce(request);
      if (result.status === "error" && result.error?.kind === "session" && sessionId && !controller.signal.aborted) {
        callbacks.onActivity({ id: "session-rejoin", kind: "note", label: "previous native session could not be resumed — rejoining with a fresh one", status: "ok" });
        result = await runOnce({ ...request, sessionId: null, prompt: promptFor(true, true) });
      }
      return result;
    };

    const done = execute()
      .catch((error: unknown): TurnResult => ({
        status: "error",
        text: "",
        sessionId: null,
        error: { kind: "unknown", message: error instanceof Error ? error.message : String(error) },
      }))
      .then((result) => this.finishTurn(agent, turnId, run.id, result, snapshot, tree, startedAt));

    this.running.set(agent.id, { turnId, agent, controller, snapshot, tree, startedAt, done });
    this.notePresence();
    this.ensureOpsPolling();
    this.log(`${agent.id} ${turnId} started (${sessionId ? "resume" : "fresh"}, ${prompt.length} chars)`);
  }

  private finishTurn(
    agent: RoomAgent,
    turnId: string,
    runId: string,
    result: TurnResult,
    snapshot: ChangeSnapshot | null,
    tree: string | null,
    startedAt: number,
  ): void {
    // Sweep the inbox while this turn still counts as running, so its ops are attributed to it.
    this.ingestOps();
    this.flushShell(turnId);
    const { outsideDoc, handoff } = this.running.get(agent.id) ?? {};
    this.running.delete(agent.id);
    this.notePresence();
    markTurnLive(this.state.workspace, { room: this.state.id, turn: turnId, pid: process.pid, startedAt, endedAt: Date.now() });
    // Turns of other rooms that ran in this workspace while this one did (in this process or another).
    const foreign = otherRoomTurns(this.state.workspace, this.state.id, startedAt);
    // Every turn alongside it has ended, and the handoff is from after the last of them.
    const alone = this.running.size === 0 && foreign.every((entry) => entry.endedAt !== undefined && handoff !== undefined && entry.endedAt <= handoff.at);
    // Taken before the snapshot: a turn of another process that ends while it is taken ends after this handoff.
    const snappedAt = Date.now();
    const dirty = snapshotChanges(this.state.workspace);
    const after = tree && !(dirty && dirty.size > MAX_TREE_SNAPSHOT_DIRTY) ? snapshotTree(this.state.workspace) : null;
    // Work the agent committed during the turn is gone from `git status`, but not from the trees.
    const committed = tree && after ? (treeChangedPaths(this.state.workspace, tree, after) ?? []) : [];
    const doc = this.state.settings.doc;
    // The human saved the canonical file during this turn and it is still exactly that save: the
    // change is theirs (already recorded as their revision), not the agent's.
    const humanDoc = Boolean(doc && outsideDoc && readDoc(this.state.workspace, doc)?.hash === outsideDoc);
    const seen = [...new Set([...diffSnapshots(snapshot, dirty), ...committed])].filter((file) => !(humanDoc && file === doc)).sort();
    // The turns that ran alongside this one have all ended: a file that changed since the last of them
    // did is this turn's, whatever tool changed it. Its patch starts from where that turn left the file.
    const late = handoff && handoff.dirty && dirty && alone ? seen.filter((file) => handoff.dirty!.get(file) !== dirty.get(file)) : [];
    let files = this.attributeFiles(turnId, seen, late, foreign.map((entry) => `${entry.room}/${entry.turn}`));
    // A late file this turn wrote itself all along, and no parallel turn claims, is its whole change from the turn's start;
    // only one another turn may have shaped too starts from where the last of them left it.
    const self = this.state.turns.find((entry) => entry.id === turnId);
    const handedOver = late.filter(
      (file) => foreign.length > 0 || !self || !this.claimsFile(self, file) || this.overlapping(turnId).some((entry) => this.claimsFile(entry, file)),
    );
    // A file a parallel turn of this room also wrote while this one ran is not this turn's alone: its change says so.
    const sharedWith = (file: string) =>
      self && this.claimsFile(self, file) ? [...new Set(this.overlapping(turnId).filter((entry) => this.claimsFile(entry, file)).map((entry) => entry.agent))] : [];
    const changed = this.turnChanges(agent, turnId, tree, after, files, handedOver.length && handoff?.tree ? { tree: handoff.tree, files: handedOver } : undefined, sharedWith);
    // Every parallel turn has ended: nothing needs their shell writes any more.
    if (this.running.size === 0) {
      this.shellWrites.clear();
      this.shellCwds.clear();
      this.shellNoted.clear();
      this.shellPending.clear();
    }
    // A file only touched (same content) is not a change.
    if (changed) files = files.filter((file) => changed.changes.some((change) => change.path === file));
    // Hand what the workspace looks like now to the turns still running, here and in the other rooms of this process.
    for (const engine of enginesHere.get(workspaceKey(this.state.workspace)) ?? [this]) {
      for (const other of engine.running.values()) other.handoff = { dirty, tree: after, at: snappedAt };
    }
    // Credited by git status, or — without git to tell — changed while this was the only turn.
    if (doc && (files.includes(doc) || (!snapshot && this.running.size === 0 && foreign.length === 0))) this.recordDoc(agent.id, { turnId });
    // Changed during parallel turns and credited to none: record it as theirs, not as the human's.
    else if (doc && seen.includes(doc) && this.running.size === 0) {
      const among = [...new Set([agent.id, ...this.overlapping(turnId).map((entry) => entry.agent), ...this.roomHandles(foreign)])];
      if (among.length > 1) this.recordDoc(among.join(" or "), { among });
    }

    let messageId: string | undefined;
    let status: "ok" | "pass" | "error" | "interrupted" = result.status;
    if (result.status === "ok") {
      // Images Codex's image_gen made stay where Codex saved them; the message embeds them from there.
      const images = result.images ?? [];
      const pass = passNote(result.text);
      // An agent that only made an image still said something: show it, with the pass note (if any) as the caption.
      const note = images.length ? null : pass;
      const said = images.length && pass !== null ? pass : result.text.trim();
      if (note !== null) {
        status = "pass";
        messageId = this.postMessage({ author: agent.id, kind: "pass", text: note, mentions: [], wakes: false, turnId, runId }).id;
      } else {
        const handles = [...this.state.agents.map((entry) => entry.id), this.state.human.toLowerCase()];
        const asked = this.askedAlone(agent, turnId);
        const message = this.postMessage({
          author: agent.id,
          kind: "agent",
          text: [said, ...images.filter((path) => !mediaRefs(said).includes(path)).map(embed)].filter(Boolean).join("\n\n"),
          mentions: parseMentions(said, handles),
          // An answer to what the human put to this agent alone goes back to the human: the others hear
          // it in their next delta, and it wakes one of them only if it says @name.
          wakes: !asked || this.addressesOthers(parseMentions(said, handles), agent),
          turnId,
          runId,
        });
        messageId = message.id;
        const secondLook = asked && !message.wakes ? () => this.weighSecondLook(agent, turnId, runId, asked, message, changed?.changes ?? []) : undefined;
        this.readPosted(message, agent, secondLook);
      }
    } else if (result.status === "error") {
      const error = result.error ?? { kind: "unknown", message: "failed" };
      if (error.kind === "spawn" || error.kind === "auth") this.benched.add(agent.id);
      const hint =
        error.kind === "rate_limit"
          ? " (rate limit — it will retry on the next message)"
          : error.kind === "auth"
            ? ` (not logged in — run \`${agent.kind} login\`)`
            : error.kind === "spawn"
              ? ` (is \`${agent.kind}\` installed and on PATH?)`
              : "";
      this.postSystem(
        `${agent.label} could not finish its turn: ${error.message}${hint}`,
        { code: "turn.failed", agent: agent.label, cli: agent.kind, error: error.kind, message: error.message },
        false,
        turnId,
      );
    }

    this.store.append({
      type: "turn.ended",
      turnId,
      agent: agent.id,
      status,
      sessionId: result.sessionId ?? this.state.sessions[agent.id]?.sessionId ?? null,
      ...(messageId ? { messageId } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.error ? { error: result.error } : {}),
      durationMs: Date.now() - startedAt,
      ...(files.length > 0 ? { files } : {}),
      ...(changed && changed.changes.length > 0 ? changed : {}),
    });
    this.log(`${agent.id} ${turnId} ${status}`);
    // With native sync on, the inbox stays watched between turns (ops from the agents' own sessions).
    if (this.running.size === 0 && this.opsTimer && this.nativePollMs <= 0) {
      clearInterval(this.opsTimer);
      this.opsTimer = undefined;
    }
    this.requestSchedule();
  }

  /**
   * Exactly what a turn changed: the diff between the trees taken at its start and
   * end, limited to the files credited to it. Counts go into the event; the patch
   * goes to .agoryx/turns/<turn>.patch, where anyone in the room can read it.
   */
  private turnChanges(
    agent: RoomAgent,
    turnId: string,
    before: string | null,
    after: string | null,
    files: string[],
    late?: { tree: string; files: string[] },
    sharedWith: (file: string) => string[] = () => [],
  ): { changes: FileChange[]; trees: { before: string; after: string } } | null {
    if (!before || !after || files.length === 0) return null;
    const early = late ? files.filter((file) => !late.files.includes(file)) : files;
    const parts = [treeChanges(this.state.workspace, before, after, early), ...(late ? [treeChanges(this.state.workspace, late.tree, after, late.files)] : [])];
    if (parts.some((part) => !part)) return null;
    const diff = {
      changes: parts
        .flatMap((part) => part!.changes)
        .map((change) => {
          const others = sharedWith(change.path).filter((id) => id !== agent.id);
          return others.length ? { ...change, with: others } : change;
        })
        .sort((a, b) => a.path.localeCompare(b.path)),
      patch: parts.map((part) => part!.patch).filter(Boolean).join(""),
    };
    if (diff.changes.length > 0) {
      writeTurnPatch(this.ws, { id: turnId, author: agent.label, ts: new Date().toISOString() }, diff.changes, diff.patch);
    }
    return { changes: diff.changes, trees: { before, after } };
  }

  /** The patch a turn made (for the UI and the CLI); null when it changed nothing git could see. */
  turnPatch(turnId: string): { patch: string; truncated: boolean } | null {
    return roomTurnPatch(this.store, turnId);
  }

  /**
   * Turns run in parallel in one workspace, so a git diff alone would credit
   * a file to everyone who was running. A file another overlapping turn
   * reported editing (and this one did not) belongs to that turn.
   */
  private attributeFiles(turnId: string, files: string[], late: string[] = [], foreign: string[] = []): string[] {
    if (files.length === 0) return files;
    const turn = this.state.turns.find((entry) => entry.id === turnId);
    if (!turn) return files;
    const claims = (entry: TurnState, file: string) => this.claimsFile(entry, file);
    if (this.overlapping(turnId).length === 0 && foreign.length === 0) return files;
    // Another turn — of this room or of another room sharing the workspace — ran at the same time: a file this turn's own edit tool
    // touched, or its own shell command named as written (`> file`, `sed -i … file`, `open('file', 'w')`), is its (both, if both did),
    // and so is one changed after the others had ended. One a command changed without naming it could be either's: credited to nobody.
    const mine = files.filter((file) => claims(turn, file) || late.includes(file));
    const unclaimed = files.filter((file) => !mine.includes(file));
    if (unclaimed.length > 0) this.log(`${turnId}: not credited (parallel turns${foreign.length ? `, other rooms: ${foreign.join(", ")}` : ""}): ${unclaimed.join(", ")}`);
    return mine;
  }

  /** Whether a turn's own trace says it wrote the file: its edit tool, a shell command naming it as written, or a doc revision. */
  private claimsFile(entry: TurnState, file: string): boolean {
    return (
      entry.activity.some(
        (activity) =>
          (activity.kind === "edit" && activity.label.includes(file)) ||
          // One read as it ran (whole, and from where its shell was) is in shellWrites; only one that was not is read from its label.
          (activity.kind === "command" && !this.shellNoted.has(`${entry.id} ${activity.id}`) && labelWrites(activity.label).some((target) => namesFile(target, file))),
      ) ||
      [...(this.shellWrites.get(entry.id) ?? []), ...this.pendingWrites(entry.id)].some((target) => namesFile(target, file)) ||
      this.state.docRevisions.some((revision) => revision.turnId === entry.id && revision.path === file)
    );
  }

  /** The other turns that ran at some point while this one did. */
  private overlapping(turnId: string): TurnState[] {
    const turn = this.state.turns.find((entry) => entry.id === turnId);
    if (!turn) return [];
    return this.state.turns.filter(
      (entry) => entry.id !== turnId && (entry.status === "running" || (entry.endedAt !== undefined && entry.endedAt >= turn.startedAt)),
    );
  }

  // -------------------------------------------------------------------------
  // The canonical file
  // -------------------------------------------------------------------------

  /** Revisions of the current canonical file, oldest first. */
  private docRevisions(path = this.state.settings.doc): DocRevision[] {
    return path ? this.state.docRevisions.filter((revision) => revision.path === path) : [];
  }

  /** The full text recorded with a revision; undefined when it was too big to keep. */
  revisionText(seq: number): string | null | undefined {
    const event = this.store.events.find((entry) => entry.seq === seq);
    return event?.type === "doc.revised" ? event.text : undefined;
  }

  /**
   * Record the file as it is now, if it differs from the last revision.
   * `by` is who changed it; "agoryx" marks the version the room started from.
   */
  private recordDoc(by: string, extra: { turnId?: string; native?: boolean; among?: string[]; from?: Actor["from"] } = {}): boolean {
    const path = this.state.settings.doc;
    if (!path) return false;
    const now = readDoc(this.state.workspace, path);
    const last = this.docRevisions(path).at(-1);
    const stat = statDoc(this.state.workspace, path);
    this.docWatch = stat ? `${stat.size}:${stat.mtimeMs}` : "gone";
    this.docWatchAt = Date.now();
    if (!now) {
      if (!last || last.deleted) return false;
      const before = this.revisionText(last.seq) ?? "";
      this.store.append({ type: "doc.revised", path, by, ...extra, hash: docHash(""), text: null, added: 0, removed: diffStats(diffLines(before, "")).removed });
      return true;
    }
    if (last && !last.deleted && last.hash === now.hash) return false;
    const truncated = Boolean(now.truncated);
    const before = last && !last.deleted ? (this.revisionText(last.seq) ?? "") : "";
    const stats = truncated ? { added: now.text.split("\n").length, removed: 0 } : diffStats(diffLines(before, now.text));
    this.store.append({
      type: "doc.revised",
      path,
      by,
      ...extra,
      hash: now.hash,
      ...(truncated ? { truncated: true } : { text: now.text }),
      ...stats,
    });
    return true;
  }

  /** The version the room found (or started) the file in, so later diffs have a base. */
  private recordDocBaseline(): void {
    const path = this.state.settings.doc;
    if (!path || this.docRevisions(path).length > 0) return;
    const baseline = baselineRevision(this.state.workspace, path);
    if (baseline) this.store.append(baseline);
    const stat = statDoc(this.state.workspace, path);
    this.docWatch = stat ? `${stat.size}:${stat.mtimeMs}` : "gone";
    this.docWatchAt = Date.now();
  }

  /** Between turns: pick up edits made in an editor, in the UI or in an agent's own session. */
  private syncDoc(): void {
    const path = this.state.settings.doc;
    if (!path || this.running.size > 0 || this.closed) return;
    const stat = statDoc(this.state.workspace, path);
    const key = stat ? `${stat.size}:${stat.mtimeMs}` : "gone";
    if (key === this.docWatch) {
      this.docWatchAt = Date.now();
      return;
    }
    // Another room's turn ran in this workspace since the file was last seen: its agent may have made
    // the change. While it runs, wait (its own room may credit it); after, the change is theirs or ours.
    const foreign = otherRoomTurns(this.state.workspace, this.state.id, this.docWatchAt);
    if (foreign.some((entry) => entry.endedAt === undefined)) return;
    const author = this.outsideAuthor();
    if (foreign.length > 0) {
      const among = [author.id, ...this.roomHandles(foreign)];
      this.recordDoc(among.join(" or "), { among });
      return;
    }
    this.recordDoc(author.id, author.native ? { native: true } : {});
  }

  /** Other rooms whose turns ran here, as handles for a revision's `among`: their names, marked as rooms. */
  private roomHandles(turns: Array<{ room: string }>): string[] {
    const names = new Map(roomsSharingWorkspace(this.store).map((room) => [room.id, room.name]));
    return [...new Set(turns.map((turn) => `room "${names.get(roomDirName(turn.room) ?? "") ?? turn.room}"`))];
  }

  /** Who changed the workspace outside a room turn: the one agent just talked to in its own session, else the human. */
  private outsideAuthor(): { id: string; native: boolean } {
    const now = Date.now();
    const recent = this.state.agents.filter((agent) => {
      const tracker = this.native.get(agent.id);
      return this.nativeOpen(agent) || (tracker?.nativeAt !== undefined && now - tracker.nativeAt < NATIVE_EDIT_MS);
    });
    return recent.length === 1 ? { id: recent[0]!.id, native: true } : { id: this.state.human, native: false };
  }

  /** The canonical file now, for readers (UI, CLI). */
  readDocument(): { path: string; text: string; hash: string; exists: boolean; truncated: boolean } | null {
    const path = this.state.settings.doc;
    if (!path) return null;
    const now = readDoc(this.state.workspace, path);
    return { path, text: now?.text ?? "", hash: now?.hash ?? docHash(""), exists: Boolean(now), truncated: Boolean(now?.truncated) };
  }

  /**
   * The human edits the canonical file. `base` is the hash they started from;
   * if the file moved on meanwhile, nothing is written and the current version is returned in the error.
   * Like a side conversation, an edit wakes nobody: agents see the diff in their next turn.
   */
  writeDocument(text: string, base: string, author?: string | Actor): DocRevision | null {
    const actor = this.actor(author);
    const path = this.state.settings.doc;
    if (!path) throw new Error("this room has no canonical file");
    const current = readDoc(this.state.workspace, path);
    if ((current?.hash ?? docHash("")) !== base) throw new DocConflictError(current ? { text: current.text, hash: current.hash } : { text: "", hash: docHash("") });
    // Only a preview of a file this big was ever shown; saving it would cut the file.
    if (current?.truncated) throw new DocTooLargeError();
    // Something changed on disk before this edit and was never recorded: credit it first.
    if (current && this.docRevisions(path).at(-1)?.hash !== current.hash) {
      const outside = this.outsideAuthor();
      this.recordDoc(outside.id, outside.native ? { native: true } : {});
    }
    // No writing through a symlink, or creating folders, anywhere outside the workspace.
    const full = join(this.state.workspace, path);
    if (!docWritable(this.state.workspace, path)) throw new Error("the canonical file must stay inside the workspace");
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
    // Turns running now will see this file changed; it must not be credited to them.
    const saved = readDoc(this.state.workspace, path)?.hash;
    for (const turn of this.running.values()) turn.outsideDoc = saved;
    return this.recordDoc(actor.by, actor.from ? { from: actor.from } : {}) ? (this.docRevisions(path).at(-1) ?? null) : null;
  }

  /** What changed in the canonical file since this agent last looked, as a delta block. */
  private docDelta(agent: RoomAgent, seen: number, fresh: boolean): string | null {
    const path = this.state.settings.doc;
    const revisions = this.docRevisions(path ?? undefined);
    if (!path || revisions.length === 0) return null;
    const latest = revisions.at(-1)!;
    if (fresh) {
      if (latest.deleted) return `── ${path} (the room's canonical file) does not exist right now.`;
      const text = this.revisionText(latest.seq);
      const lines = text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
      return `── ${path} (the room's canonical file)${lines ? `: ${lines} line${lines === 1 ? "" : "s"}` : ""}, last changed by ${latest.by === "agoryx" ? "nobody yet" : this.handleName(latest.by)}. Read it before you edit it.`;
    }
    let base = -1;
    revisions.forEach((revision, index) => {
      if (revision.seq <= seen || revision.by === agent.id) base = index;
    });
    const changes = revisions.slice(base + 1).filter((revision) => revision.by !== agent.id);
    if (changes.length === 0) return null;
    const authors = new Map<string, { added: number; removed: number; native: boolean }>();
    for (const change of changes) {
      const name = change.among ? `${change.among.map((id) => this.handleName(id)).join(" or ")} (parallel turns, whose is not known)` : this.handleName(change.by);
      const entry = authors.get(name) ?? { added: 0, removed: 0, native: false };
      entry.added += change.added;
      entry.removed += change.removed;
      entry.native ||= Boolean(change.native);
      authors.set(name, entry);
    }
    const who = [...authors.entries()]
      .map(([name, stats]) => `${name}${stats.native ? " (in its own session)" : ""} +${stats.added} −${stats.removed}`)
      .join(", ");
    const header = `── ${path} (the room's canonical file) changed since your last turn — ${who}`;
    if (latest.deleted) return `${header}\nThe file was deleted.`;
    const before = base >= 0 && !revisions[base]!.deleted ? this.revisionText(revisions[base]!.seq) : "";
    const after = this.revisionText(latest.seq);
    if (before === undefined || after === undefined || after === null) return `${header}\n(too large to show here — read the file)`;
    let diff = renderDiff(before ?? "", after);
    if (!diff) return null;
    // The delta stays thin: a big rewrite is pointed at, and the agent reads the file itself.
    if (diff.length > MAX_DOC_DELTA_CHARS) {
      const cut = diff.lastIndexOf("\n", MAX_DOC_DELTA_CHARS);
      diff = `${diff.slice(0, cut > 0 ? cut : MAX_DOC_DELTA_CHARS)}\n… the rest of this diff is cut (${diff.length} chars in all) — read ${path} for the whole file`;
    }
    // A longer fence than any the file is likely to contain.
    return `${header}\n~~~~diff\n${diff}\n~~~~`;
  }

  private handleName(handle: string): string {
    const agent = this.state.agents.find((entry) => entry.id === handle);
    if (agent) return agent.label;
    if (handle === this.state.human) return `${handle} (human)`;
    const guest = this.state.guests[handle];
    return guest ? originName(guest) : handle;
  }

  // -------------------------------------------------------------------------
  // Native sessions: turns the human took in the agents' own apps
  // -------------------------------------------------------------------------

  /**
   * Reads new exchanges from each idle agent's native session file and posts
   * the ones that did not come from Agoryx. Cheap when nothing changed (a stat).
   */
  syncNative(): void {
    if (this.closed) return;
    for (const agent of this.state.agents) {
      // A running Agoryx turn is writing this file right now; read it once the turn is over.
      if (this.running.has(agent.id)) continue;
      const session = this.state.sessions[agent.id];
      if (!session) continue;
      let tracker = this.native.get(agent.id);
      if (!tracker || tracker.sessionId !== session.sessionId) {
        tracker = { sessionId: session.sessionId, file: null, offset: 0, lastAgoryx: true, size: -1, mtimeMs: 0, openNative: false, nextLocateAt: 0 };
        this.native.set(agent.id, tracker);
      }
      if (!tracker.file) {
        if (Date.now() < tracker.nextLocateAt) continue;
        tracker.file = locateNativeSession(agent.kind, session.sessionId, this.state.workspace, this.env);
        if (!tracker.file) {
          tracker.nextLocateAt = Date.now() + NATIVE_RELOCATE_MS;
          continue;
        }
      }
      let size: number;
      let mtimeMs: number;
      try {
        ({ size, mtimeMs } = statSync(tracker.file));
      } catch {
        tracker.file = null;
        continue;
      }
      if (size === tracker.size && mtimeMs === tracker.mtimeMs) continue;
      try {
        const scan = scanNativeSession(agent.kind, tracker.file, tracker.offset, tracker.lastAgoryx);
        tracker.offset = scan.offset;
        tracker.lastAgoryx = scan.lastAgoryx;
        tracker.openNative = scan.openNative;
        if (scan.openNative || scan.exchanges.length > 0) {
          tracker.nativeAt = Date.now();
          // Someone talked to this session outside the room: a process that kept the session in memory no longer has all of it.
          this.closeLive(agent.id, "the session was used outside the room");
        }
        tracker.size = size;
        tracker.mtimeMs = mtimeMs;
        for (const exchange of scan.exchanges) this.importNative(agent, exchange);
        for (const compaction of scan.compactions) this.noteCompaction(agent, compaction);
      } catch (error) {
        this.log(`could not read ${agent.id}'s native session: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // An exchange that started, finished or went stale changes who looks busy.
    this.notePresence();
    this.syncDoc();
  }

  /** Someone is mid-exchange with this agent in its own session. */
  private nativeOpen(agent: RoomAgent): boolean {
    const tracker = this.native.get(agent.id);
    return Boolean(tracker?.openNative && Date.now() - tracker.mtimeMs < NATIVE_BUSY_MS);
  }

  private nativeBusy(agent: RoomAgent): boolean {
    const busy = this.nativeOpen(agent);
    if (!busy) {
      this.nativeBusyNoted.delete(agent.id);
      return false;
    }
    if (!this.nativeBusyNoted.has(agent.id)) {
      this.nativeBusyNoted.add(agent.id);
      this.postSystem(
        `${agent.label} is busy in its own session (someone is talking to it there). Its turn here starts when that exchange ends.`,
        { code: "agent.busy", agent: agent.label },
        false,
      );
    }
    return true;
  }

  /**
   * The agent's CLI compacted its context: a quiet line for the human (its next answers may have lost detail),
   * once per compaction (a rescan from an unfinished exchange returns it again). Ones from before the room's last
   * event when this engine opened are history; ones after it are news, even if they happened while no engine ran.
   */
  private noteCompaction(agent: RoomAgent, compaction: NativeCompaction): void {
    const at = Date.parse(compaction.at);
    if (!Number.isFinite(at) || at < this.compactedSince) return;
    this.compactedKeys ??= new Set(
      this.state.messages.flatMap((message) => (message.sys?.code === "agent.compacted" ? [`${message.sys.handle}:${message.sys.key}`] : [])),
    );
    const key = `${agent.id}:${compaction.key}`;
    if (this.compactedKeys.has(key)) return;
    this.compactedKeys.add(key);
    const time = new Date(at);
    const hhmm = `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
    this.postSystem(`${agent.label}'s context was compacted at ${hhmm}.`, { code: "agent.compacted", agent: agent.label, handle: agent.id, key: compaction.key, at: compaction.at }, false);
  }

  private importNative(agent: RoomAgent, exchange: NativeExchange): void {
    // Each half of an exchange is its own message and deduped on its own: a crash between the two
    // appends must not leave the reply behind for good.
    const half = (kind: MessageKind) => (kind === "human" ? "prompt" : "reply");
    this.nativeKeys ??= new Set(
      this.state.messages.filter((message) => message.native).map((message) => `${message.native!.agent}:${message.native!.key}:${half(message.kind)}`),
    );
    const native = { agent: agent.id, key: exchange.key, ...(exchange.at ? { at: exchange.at } : {}) };
    const handles = [...this.state.agents.map((entry) => entry.id), this.state.human.toLowerCase()];
    const fresh = (kind: MessageKind): boolean => {
      const key = `${agent.id}:${exchange.key}:${half(kind)}`;
      if (this.nativeKeys!.has(key)) return false;
      this.nativeKeys!.add(key);
      return true;
    };
    let trigger: string | null = null;
    let triggeredBy: Actor | undefined;
    let imported = false;
    if (exchange.prompt && fresh("human")) {
      const mentions = parseMentions(exchange.prompt, handles);
      const wakes = this.addressesOthers(mentions, agent);
      const message = this.postMessage({ author: this.state.human, kind: "human", text: exchange.prompt, mentions, wakes, native });
      if (wakes && !trigger) {
        trigger = message.id;
        triggeredBy = { by: this.state.human };
      }
      imported = true;
    }
    if (exchange.reply && passNote(exchange.reply) === null && fresh("agent")) {
      const mentions = parseMentions(exchange.reply, handles);
      const wakes = this.addressesOthers(mentions, agent);
      const message = this.postMessage({ author: agent.id, kind: "agent", text: exchange.reply.trim(), mentions, wakes, native });
      this.readPosted(message, agent);
      if (wakes && !trigger) {
        trigger = message.id;
        triggeredBy = { by: agent.id };
      }
      imported = true;
    }
    if (!imported) return;
    this.log(`imported ${agent.id} native exchange ${exchange.key}`);
    if (trigger) {
      this.benched.clear();
      this.ensureRun(trigger, undefined, triggeredBy);
      this.requestSchedule();
    }
  }

  // -------------------------------------------------------------------------
  // Messages, table, commits
  // -------------------------------------------------------------------------

  private postMessage(input: Omit<RoomMessage, "id"> & { kind: MessageKind }): MessageEntry {
    const id = `m${(this.state.counters.m ?? 0) + 1}`;
    this.store.append({ type: "message.posted", message: { id, ...input } });
    const entry = this.state.messages[this.state.messages.length - 1]!;
    if (!forHumanOnly(entry)) writeRoomMessage(this.ws, this.state.id, entry);
    return entry;
  }

  /** Rooms from before .agoryx/messages/ existed, or a workspace that lost it: agents read messages from there. */
  private writeMissingMessages(): void {
    for (const message of this.state.messages) {
      const target = messagePath(this.ws, this.state.id, message.id);
      if (target && !existsSync(target) && !forHumanOnly(message)) writeRoomMessage(this.ws, this.state.id, message);
    }
  }

  /** A line by Agoryx itself: `text` in English, `sys` what it means (see SystemNote). */
  private postSystem(text: string, sys: SystemNote, wakes: boolean, turnId?: string): MessageEntry {
    return this.postMessage({ author: "agoryx", kind: "system", text, sys, mentions: [], wakes, ...(turnId ? { turnId } : {}) });
  }

  private applyTableOp(raw: unknown, actor: Actor, isHuman: boolean, turnId: string | undefined): TableOp {
    const by = actor.by;
    const prepared = prepareTableOp(this.state.table, raw, by, isHuman);
    const op: TableOp = { ...prepared, ...(turnId ? { turnId } : {}), ...(actor.from ? { from: actor.from } : {}) };
    this.store.append({ type: "table.op", op });
    this.writeTableFile();
    if (op.op === "decide") {
      const decision = this.state.table.decisions[this.state.table.decisions.length - 1]!;
      const option = this.state.table.options.find((entry) => entry.id === decision.option);
      const who = actorLabel(this.state, by);
      this.postMessage({
        author: by,
        kind: "decision",
        text: `Decision №${decision.n}: ${option?.id} «${option?.title}»${decision.note ? ` — ${decision.note}` : ""} (decided by ${who})`,
        sys: {
          code: "decision",
          n: decision.n,
          option: option?.id ?? decision.option,
          title: option?.title ?? "",
          ...(decision.note ? { note: decision.note } : {}),
          by: who,
        },
        mentions: [],
        // A human decision is news for the agents; an agent's decision rides on its own reply
        // (one from another room has none here).
        wakes: isHuman || Boolean(actor.from),
        ...(actor.from ? { from: actor.from } : {}),
        refs: [decision.id, decision.option],
        ...(turnId ? { turnId } : {}),
      });
    }
    return op;
  }

  private writeTableFile(): void {
    try {
      writeFileSync(this.ws.tableFile, renderTableMarkdown(this.state.table, this.state.name));
    } catch {
      // the workspace may be gone; the table still lives in the event log
    }
  }

  private ensureOpsPolling(): void {
    if (this.opsTimer) return;
    this.opsTimer = setInterval(() => this.ingestOps(), this.opsPollMs);
    this.opsTimer.unref();
  }

  /**
   * Which room agent wrote an inbox op. The shim signs it with the agent's id, or with
   * "kind.<cli>" when only its environment hints at which CLI wrote it. A hint names an
   * agent only when the room has one agent of that kind; otherwise (and for an unsigned
   * op) it is the only such agent working right now, in a room turn or in its own session.
   */
  private opAuthor(signed: string): RoomAgent | undefined {
    const hint = /^kind\.(.+)$/.exec(signed)?.[1];
    let agents = this.state.agents;
    if (hint === undefined) {
      const byId = agents.find((entry) => entry.id === signed);
      if (byId) return byId;
    }
    // A bare kind is what shims before "kind." wrote; it is read as the hint it was.
    const kind = hint ?? (agents.some((entry) => entry.kind === signed) ? signed : undefined);
    if (kind !== undefined) {
      agents = agents.filter((entry) => entry.kind === kind);
      if (agents.length === 1) return agents[0];
    }
    const active = () => agents.filter((entry) => this.running.has(entry.id) || this.nativeOpen(entry));
    let candidates = active();
    if (candidates.length !== 1) {
      this.syncNative();
      candidates = active();
    }
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  /** The table op already in the log under this client nonce, if any. */
  private appliedOp(nonce: string): TableOp | undefined {
    for (let index = this.store.events.length - 1; index >= 0; index -= 1) {
      const event = this.store.events[index]!;
      if (event.type === "table.op" && event.op.nonce === nonce) return event.op;
    }
    return undefined;
  }

  /** Pull table ops agents wrote via the `agoryx table` shim and ack them. */
  ingestOps(): void {
    this.drainInbox(this.ws);
    // The inbox straight under .agoryx/ is where shims before per-room directories queued ops (and
    // where an op waits that was queued before this room first opened with them). It is this room's
    // only when no other room lives in the workspace; otherwise nobody can tell whose an op is.
    const legacy = workspacePaths(this.state.workspace);
    if (!existsSync(legacy.opsDir) || !readdirSync(legacy.opsDir).some((name) => /\.(?:jsonl|op)(\.\d+\.\d+\.taking)?$/.test(name))) return;
    const rooms = roomsSharingWorkspace(this.store);
    if (rooms.length === 1) {
      this.drainInbox(legacy);
      return;
    }
    const ids = rooms.map((room) => room.id).join(", ");
    drainOpsInbox(legacy, ({ agent, raw }) => {
      const nonce = typeof raw.nonce === "string" ? raw.nonce : undefined;
      if (nonce) writeAck(legacy, nonce, { ok: false, error: `${rooms.length} rooms share this workspace (${ids}) — run it again with --room <id>` });
      this.log(`rejected table op from ${agent} in the shared inbox: ${rooms.length} rooms share the workspace`);
    });
  }

  /**
   * Name every room of this workspace in .agoryx/rooms/<id>/room.json, those not opened since rooms got
   * their own directories too: the agent tool sees only the workspace, and must know when to ask for --room.
   */
  private publishSharingRooms(): void {
    for (const room of roomsSharingWorkspace(this.store)) {
      const info = join(this.ws.agoryxDir, "rooms", room.id, "room.json");
      if (existsSync(info)) continue;
      try {
        mkdirSync(dirname(info), { recursive: true });
        writeFileSync(info, `${JSON.stringify(room)}\n`);
      } catch {
        // the agent tool falls back to what it can see
      }
    }
  }

  private drainInbox(inbox: WorkspacePaths): void {
    drainOpsInbox(inbox, ({ agent, raw }) => {
      const member = this.opAuthor(agent);
      const nonce = typeof raw.nonce === "string" ? raw.nonce : undefined;
      if (!member) {
        const kind = /^kind\.(.+)$/.exec(agent)?.[1];
        const same = this.state.agents.filter((entry) => entry.kind === kind);
        const ids = (same.length > 1 ? same : this.state.agents).map((entry) => entry.id).join(" or --as ");
        if (nonce) writeAck(inbox, nonce, { ok: false, error: `can't tell which agent wrote this — add --as ${ids}` });
        this.log(`rejected unsigned table op (${agent})`);
        return;
      }
      const by = member.id;
      const turnId = this.running.get(member.id)?.turnId;
      if (raw.op === "say") {
        this.postUpdate(inbox, member, raw, nonce, turnId);
        return;
      }
      // An inbox file recovered after a crash may hold ops already applied: the nonce in the log says so.
      const applied = nonce ? this.appliedOp(nonce) : undefined;
      if (applied) {
        writeAck(inbox, nonce!, { ok: true, id: applied.id ?? applied.op, text: `${applied.id ? `${applied.id} · ` : ""}${describeTableOp(applied, this.state.table)}` });
        this.log(`skipped table op ${nonce} from ${agent}: already applied`);
        return;
      }
      try {
        const op = this.applyTableOp(raw, { by }, false, turnId);
        if (nonce) writeAck(inbox, nonce, { ok: true, id: op.id ?? op.op, text: `${op.id ? `${op.id} · ` : ""}${describeTableOp(op, this.state.table)}` });
      } catch (error) {
        const message = error instanceof TableOpError ? error.message : error instanceof Error ? error.message : String(error);
        if (nonce) writeAck(inbox, nonce, { ok: false, error: message });
        this.log(`rejected table op from ${agent}: ${message}`);
      }
    });
  }

  /**
   * `agoryx say`: what an agent is doing, posted while it works. As many as it likes — not a turn, and not
   * counted against the budget. It wakes nobody (the turn's reply does that), except an agent it @addresses
   * that is not in a turn: a question asked mid-turn must not wait for a reply that is waiting on it. That
   * agent starts at once, beside the one that asked. Only during a room turn: in its own session an
   * agent's answer is read back into the room anyway.
   */
  private postUpdate(inbox: WorkspacePaths, member: RoomAgent, raw: Record<string, unknown>, nonce: string | undefined, turnId: string | undefined): void {
    const ack = (result: { ok: true; id: string; text: string } | { ok: false; error: string }) => {
      if (nonce) writeAck(inbox, nonce, result);
    };
    const posted = nonce ? this.state.messages.find((entry) => entry.nonce === nonce) : undefined;
    if (posted) {
      ack({ ok: true, id: posted.id, text: `${posted.id} · posted` });
      return;
    }
    const text = typeof raw.text === "string" ? raw.text.trim() : "";
    if (!text) {
      ack({ ok: false, error: "'say' needs text" });
      return;
    }
    if (!turnId) {
      ack({ ok: false, error: "'say' is for while you work in a room turn — outside one, just answer here: your reply is read back into the room" });
      this.log(`rejected update from ${member.id}: not in a room turn`);
      return;
    }
    const handles = [...this.state.agents.map((entry) => entry.id), this.state.human.toLowerCase()];
    const runId = this.state.turns.find((turn) => turn.id === turnId)?.runId;
    const mentions = parseMentions(text, handles);
    // Those at work read it with `read new`; only an addressed agent sitting idle needs waking.
    const wakes = this.state.agents.some(
      (entry) => entry.id !== member.id && (mentions.includes("all") || mentions.includes(entry.id)) && !this.running.has(entry.id),
    );
    const message = this.postMessage({
      author: member.id,
      kind: "update",
      text,
      mentions,
      wakes,
      turnId,
      ...(runId ? { runId } : {}),
      ...(nonce ? { nonce } : {}),
    });
    ack({ ok: true, id: message.id, text: `${message.id} · posted to the room` });
    if (wakes) this.requestSchedule();
    this.readPosted(message, member);
  }

  private checkpoint(run: RunState): void {
    if (!this.state.settings.autoCommit) return;
    const turns = this.state.turns.filter((turn) => turn.runId === run.id && turn.files?.length);
    const lines = turns.map((turn) => {
      const message = this.state.messages.find((entry) => entry.id === turn.messageId);
      const first = message?.text.split("\n")[0]?.slice(0, 90) ?? turn.status;
      return `${turn.id} ${turn.agent}: ${first} [${turn.files!.length} files]`;
    });
    const trigger = this.state.messages.find((entry) => entry.id === run.trigger);
    const subject = `agoryx(${this.state.name}): ${trigger ? trigger.text.split("\n")[0]!.slice(0, 60) : `run ${run.id}`}`;
    // Only what the run's turns were credited with: not another room's work, not anyone's staged changes.
    const files = [...new Set(turns.flatMap((turn) => turn.files ?? []))];
    const expectedTrees = new Map<string, string>();
    // The last completed credited turn supplies each file's checkpoint version.
    const turnIds = new Set(turns.map((turn) => turn.id));
    for (const event of this.store.events) {
      if (event.type !== "turn.ended" || !turnIds.has(event.turnId)) continue;
      for (const file of event.files ?? []) {
        if (event.trees) expectedTrees.set(file, event.trees.after);
        else expectedTrees.delete(file);
      }
    }
    // Alone in the directory, and no other room's turn ran during this run: everything, as always.
    const started = Date.parse(this.state.turns.find((turn) => turn.runId === run.id)?.startedAt ?? "") || 0;
    const shared = roomsSharingWorkspace(this.store).length > 1 || otherRoomTurns(this.state.workspace, this.state.id, started).length > 0;
    this.recordCheckpoint(subject, lines.join("\n"), shared ? files : undefined, shared ? expectedTrees : undefined);
  }

  /** A checkpoint commit (all of the folder, or only `files` in a shared one), and the whole folder at it, to return to. */
  private recordCheckpoint(subject: string, body: string, files?: string[], expectedTrees?: ReadonlyMap<string, string>): void {
    const commit = checkpointCommit(this.state.workspace, subject, body, files, expectedTrees);
    if (!commit) return;
    const folder = checkpointFolder(this.state.workspace, commit.sha, checkpointRef(this.state.id, commit.sha));
    this.store.append({ type: "commit.created", sha: commit.sha, subject, files: commit.files, ...(folder && folder !== commit.sha ? { folder } : {}) });
  }
}
