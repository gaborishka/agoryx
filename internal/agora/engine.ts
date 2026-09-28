import { closeSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { baselineRevision, diffLines, diffStats, docHash, docWritable, MAX_DOC_TEXT, normalizeDocPath, readDoc, renderDiff, statDoc } from "./doc.js";
import { embed } from "./media.js";
import { locateNativeSession, scanNativeSession, type NativeExchange } from "./native.js";
import { activeRun } from "./projection.js";
import { buildTurnPrompt, parseMentions, passNote } from "./prompts.js";
import { truncate, type AgentRunner, type TurnResult } from "./runners/types.js";
import type { RoomStore } from "./store.js";
import { describeTableOp, openOnTable, prepareTableOp, renderTableMarkdown, TableOpError } from "./table.js";
import type {
  Activity,
  AgentKind,
  AgentPresence,
  DocRevision,
  FileChange,
  MessageEntry,
  MessageKind,
  RoomAgent,
  RoomEvent,
  RoomMessage,
  RoomSettings,
  RunState,
  TableOp,
  TurnState,
} from "./types.js";
import {
  checkpointCommit,
  clearStaleAcks,
  diffSnapshots,
  drainOpsInbox,
  MAX_TREE_SNAPSHOT_DIRTY,
  prepareWorkspace,
  readTurnPatch,
  snapshotChanges,
  snapshotTree,
  treeChangedPaths,
  treeChanges,
  workspacePaths,
  writeAck,
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
  opsPollMs?: number;
  /** How often to read the agents' native sessions for turns taken outside the room (0 = never). */
  nativePollMs?: number;
  log?: (message: string) => void;
}

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
}

const LOCK_FILE = "engine.lock";

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
  return readTurnPatch(workspacePaths(store.state.workspace), turnId, {
    ...(trees ? { trees } : {}),
    files: turn.changes.map((change) => change.path),
  });
};

/**
 * Drives one room. There is no orchestrator deciding who speaks: every new
 * message wakes the agents that have not seen it, each agent gets a turn with
 * only what is new for it, a pass is silence, and a run ends when nobody has
 * anything unseen (quiet) or the turn budget is spent.
 */
export class RoomEngine {
  readonly store: RoomStore;
  readonly ws: WorkspacePaths;
  private readonly runners: Partial<Record<AgentKind, AgentRunner>>;
  private readonly shimDir?: string;
  private readonly agentCli: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly opsPollMs: number;
  private readonly nativePollMs: number;
  private readonly native = new Map<string, NativeTracker>();
  private nativeKeys?: Set<string>;
  private nativeTimer: NodeJS.Timeout | undefined;
  private lastPresence = "";
  /** Last stat of the canonical file, so the sync tick reads it only when it changed. */
  private docWatch = "";
  private retryTimer: NodeJS.Timeout | undefined;
  /** Agents already announced as busy in their own session (cleared when they are free). */
  private readonly nativeBusyNoted = new Set<string>();
  private readonly log: (message: string) => void;
  private readonly running = new Map<string, RunningTurn>();
  /** Agents that failed hard (spawn/auth) sit out until the next human message. */
  private readonly benched = new Set<string>();
  private idleWaiters: Array<() => void> = [];
  private opsTimer: NodeJS.Timeout | undefined;
  private scheduleQueued = false;
  private stopping = false;
  private heldWork: { trigger: string | null; minTurns: number | undefined } | null = null;
  private closed = false;
  private lockHeld = false;

  constructor(options: EngineOptions) {
    this.store = options.store;
    this.runners = options.runners;
    this.shimDir = options.shimDir;
    this.agentCli = options.agentCli ?? "agoryx";
    this.env = options.env ?? process.env;
    this.opsPollMs = options.opsPollMs ?? 250;
    this.nativePollMs = options.nativePollMs ?? 2000;
    this.log = options.log ?? (() => {});
    this.acquireLock();
    try {
      this.ws = prepareWorkspace(this.state.workspace, { initGit: this.state.createdWorkspace });
      clearStaleAcks(this.ws);
      this.writeTableFile();
      this.recover();
      this.recordDocBaseline();
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
      this.postSystem("Agoryx restarted in the middle of a run, so the run was stopped. Write anything, or ask for another round, to continue.", false);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.stop("shutdown");
    this.closed = true;
    if (this.opsTimer) clearInterval(this.opsTimer);
    if (this.nativeTimer) clearInterval(this.nativeTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
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

  /** "One more round": every agent gets another turn even with nothing new. */
  continueRun(by = this.state.human): void {
    this.benched.clear();
    const message = this.postMessage({
      author: by,
      kind: "system",
      text: `${by} asked for another round.`,
      mentions: [],
      wakes: true,
    });
    this.startWork(message.id, this.state.agents.length);
  }

  tableOp(raw: unknown, by = this.state.human): TableOp {
    const isHuman = !this.state.agents.some((agent) => agent.id === by);
    const op = this.applyTableOp(raw, by, isHuman, undefined);
    if (isHuman) {
      this.benched.clear();
      this.startWork(null);
    }
    return op;
  }

  /**
   * Starts or extends the run for something the human did. While a stop is under way the run being
   * stopped must not absorb it, so the work is held and started as a fresh run once the stop is done.
   */
  private startWork(trigger: string | null, minTurns?: number): void {
    if (this.stopping) {
      const held = this.heldWork;
      this.heldWork = { trigger: held?.trigger ?? trigger, minTurns: Math.max(held?.minTurns ?? 0, minTurns ?? 0) || undefined };
      return;
    }
    this.ensureRun(trigger, minTurns);
    this.requestSchedule();
  }

  updateSettings(patch: Partial<RoomSettings>): void {
    const clean: Partial<RoomSettings> = {};
    if (typeof patch.budget === "number" && patch.budget >= 1 && patch.budget <= 100) clean.budget = Math.round(patch.budget);
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
    this.store.append({ type: "settings.changed", patch: clean });
    if (clean.doc !== undefined) {
      this.recordDocBaseline();
      this.postSystem(clean.doc ? `The room's canonical file is now ${clean.doc}.` : "The room no longer has a canonical file.", false);
    }
  }

  /** A new name for the room; it wakes nobody. */
  rename(name: string): void {
    const clean = name.replace(/\s+/g, " ").trim().slice(0, 120);
    if (!clean) throw new Error("a room needs a name");
    if (clean === this.state.name) return;
    this.store.append({ type: "room.renamed", name: clean });
  }

  async stop(reason: "human" | "shutdown" = "human"): Promise<void> {
    this.stopping = true;
    const turns = [...this.running.values()];
    for (const turn of turns) turn.controller.abort();
    await Promise.all(turns.map((turn) => turn.done));
    const run = activeRun(this.state);
    if (run) {
      this.store.append({ type: "run.ended", runId: run.id, reason: "stopped", turns: run.used });
      if (reason === "human") this.postSystem(`${this.state.human} stopped the run.`, false);
      this.checkpoint(run);
    }
    this.stopping = false;
    const held = this.heldWork;
    this.heldWork = null;
    if (held && reason === "human" && !this.closed) {
      this.startWork(held.trigger, held.minTurns);
      return;
    }
    this.notifyIdle();
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  private ensureRun(trigger: string | null, minTurns?: number): RunState {
    const budget = this.state.settings.budget;
    const wanted = minTurns ?? budget;
    const run = activeRun(this.state);
    if (run) {
      const remaining = run.budget - run.used;
      if (remaining < wanted) {
        this.store.append({ type: "run.extended", runId: run.id, by: this.state.human, turns: wanted - remaining });
      }
      return run;
    }
    const runId = `r${(this.state.counters.r ?? 0) + 1}`;
    this.store.append({ type: "run.started", runId, trigger, budget: minTurns ?? budget });
    return activeRun(this.state)!;
  }

  private wakes(event: RoomEvent, agent: RoomAgent): boolean {
    if (event.type === "message.posted") {
      const message = event.message;
      if (message.author === agent.id || !message.wakes) return false;
      // Said in someone's own session: wakes only who it explicitly addresses, never that session's agent.
      if (message.native) {
        return message.native.agent !== agent.id && (message.mentions.includes("all") || message.mentions.includes(agent.id));
      }
      if (message.kind === "human" && message.mentions.length > 0) {
        const agentMentions = message.mentions.filter((handle) => handle === "all" || this.state.agents.some((entry) => entry.id === handle));
        if (agentMentions.length > 0 && !agentMentions.includes("all") && !agentMentions.includes(agent.id)) return false;
      }
      return true;
    }
    if (event.type === "table.op") {
      return event.op.by === this.state.human && !event.op.turnId;
    }
    return false;
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
    // (blind, so the views stay independent); after that the agents take the floor one
    // at a time, and each sees what the other just said. Whoever has waited longest goes first.
    const candidates = this.state.agents
      .filter((agent) => !this.running.has(agent.id) && !this.benched.has(agent.id) && this.runners[agent.kind])
      .map((agent) => ({ agent, wake: this.firstWake(agent) }))
      .filter((entry): entry is { agent: RoomAgent; wake: RoomEvent } => entry.wake !== null)
      .sort((a, b) => a.wake.seq - b.wake.seq);
    for (const { agent } of candidates) {
      if (this.running.size > 0 && !this.humanWaiting(agent)) continue;
      if (run.used >= run.budget) {
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
      ];
      this.postSystem(
        left.length
          ? `Turn budget reached (${run.used} agent turns). Still open on the table: ${left.join(", ")} — write anything, or ask for another round, to continue.`
          : `Turn budget reached (${run.used} agent turns). Nothing is left open on the table — write anything to continue.`,
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

  private agentEnv(agent: RoomAgent, turnId: string): NodeJS.ProcessEnv {
    const path = this.env.PATH ?? process.env.PATH ?? "";
    return {
      ...this.env,
      PATH: this.shimDir ? `${this.shimDir}:${path}` : path,
      AGORYX_ROOM: this.state.id,
      AGORYX_ROOM_NAME: this.state.name,
      AGORYX_AGENT: agent.id,
      AGORYX_TURN: turnId,
      AGORYX_OPS_DIR: this.ws.opsDir,
      AGORYX_TABLE: this.ws.tableFile,
      // Login shells may reorder PATH so another `agoryx` wins; env vars survive.
      ...(this.shimDir ? { AGORYX_CLI: join(this.shimDir, "agoryx") } : {}),
    };
  }

  /** Show the shim as plain `agoryx` in activity traces instead of its absolute path. */
  /** Rewrites of machine paths into what a reader recognises, longest first. */
  private tidyRules?: Array<[string, string]>;

  private tidyActivity(activity: Activity): Activity {
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
    // Runners keep labels long enough for this to see whole paths; clip afterwards.
    const tidy = (text: string, max: number) =>
      truncate(this.tidyRules!.reduce((acc, [from, to]) => acc.split(from).join(to), text), max);
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
    const runner = this.runners[agent.kind]!;
    const turnId = `t${(this.state.counters.t ?? 0) + 1}`;
    const fromSeq = this.state.cursors[agent.id] ?? 0;
    const cursor = this.state.seq;
    const sessionId = this.state.sessions[agent.id]?.sessionId ?? null;
    const turnsLeft = run.budget - run.used - 1;
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
    });

    const controller = new AbortController();
    const snapshot = snapshotChanges(this.state.workspace);
    const tree = snapshot && snapshot.size <= MAX_TREE_SNAPSHOT_DIRTY ? snapshotTree(this.state.workspace) : null;
    const startedAt = Date.now();
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
      onActivity: (activity: Activity) => {
        this.store.append({ type: "turn.activity", turnId, agent: agent.id, activity: this.tidyActivity(activity) });
      },
    };

    const execute = async (): Promise<TurnResult> => {
      const request = {
        prompt,
        cwd: this.state.workspace,
        sessionId,
        roomName: this.state.name,
        ...(agent.model ? { model: agent.model } : {}),
        settings: this.state.settings,
        env,
        signal: controller.signal,
      };
      let result = await runner.run(request, callbacks);
      if (result.status === "error" && result.error?.kind === "session" && sessionId && !controller.signal.aborted) {
        callbacks.onActivity({ id: "session-rejoin", kind: "note", label: "previous native session could not be resumed — rejoining with a fresh one", status: "ok" });
        result = await runner.run({ ...request, sessionId: null, prompt: promptFor(true, true) }, callbacks);
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
    const outsideDoc = this.running.get(agent.id)?.outsideDoc;
    this.running.delete(agent.id);
    this.notePresence();
    const dirty = snapshotChanges(this.state.workspace);
    const after = tree && !(dirty && dirty.size > MAX_TREE_SNAPSHOT_DIRTY) ? snapshotTree(this.state.workspace) : null;
    // Work the agent committed during the turn is gone from `git status`, but not from the trees.
    const committed = tree && after ? (treeChangedPaths(this.state.workspace, tree, after) ?? []) : [];
    const doc = this.state.settings.doc;
    // The human saved the canonical file during this turn and it is still exactly that save: the
    // change is theirs (already recorded as their revision), not the agent's.
    const humanDoc = Boolean(doc && outsideDoc && readDoc(this.state.workspace, doc)?.hash === outsideDoc);
    const seen = [...new Set([...diffSnapshots(snapshot, dirty), ...committed])].filter((file) => !(humanDoc && file === doc)).sort();
    let files = this.attributeFiles(turnId, seen);
    const changed = this.turnChanges(agent, turnId, tree, after, files);
    // A file only touched (same content) is not a change.
    if (changed) files = files.filter((file) => changed.changes.some((change) => change.path === file));
    // Credited by git status, or — without git to tell — changed while this was the only turn.
    if (doc && (files.includes(doc) || (!snapshot && this.running.size === 0))) this.recordDoc(agent.id, { turnId });

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
        messageId = this.postMessage({
          author: agent.id,
          kind: "agent",
          text: [said, ...images.filter((path) => !said.includes(path) && !said.includes(encodeURI(path))).map(embed)].filter(Boolean).join("\n\n"),
          mentions: parseMentions(said, handles),
          wakes: true,
          turnId,
          runId,
        }).id;
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
      this.postSystem(`${agent.label} could not finish its turn: ${error.message}${hint}`, false, turnId);
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
  ): { changes: FileChange[]; trees: { before: string; after: string } } | null {
    if (!before || !after || files.length === 0) return null;
    const diff = treeChanges(this.state.workspace, before, after, files);
    if (!diff) return null;
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
  private attributeFiles(turnId: string, files: string[]): string[] {
    if (files.length === 0) return files;
    const turn = this.state.turns.find((entry) => entry.id === turnId);
    if (!turn) return files;
    const claims = (entry: TurnState, file: string) =>
      entry.activity.some((activity) => activity.kind === "edit" && activity.label.includes(file)) ||
      this.state.docRevisions.some((revision) => revision.turnId === entry.id && revision.path === file);
    const overlapping = this.state.turns.filter(
      (entry) => entry.id !== turnId && (entry.status === "running" || (entry.endedAt !== undefined && entry.endedAt >= turn.startedAt)),
    );
    if (overlapping.length === 0) return files;
    // Another turn ran at the same time in the same workspace: a file only this turn's own edit tool
    // touched is its (both, if both edited it). One changed only by a shell command could be either's,
    // so it is credited to nobody.
    const mine = files.filter((file) => claims(turn, file));
    const unclaimed = files.filter((file) => !mine.includes(file));
    if (unclaimed.length > 0) this.log(`${turnId}: not credited (parallel turns): ${unclaimed.join(", ")}`);
    return mine;
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
  private recordDoc(by: string, extra: { turnId?: string; native?: boolean } = {}): boolean {
    const path = this.state.settings.doc;
    if (!path) return false;
    const now = readDoc(this.state.workspace, path);
    const last = this.docRevisions(path).at(-1);
    const stat = statDoc(this.state.workspace, path);
    this.docWatch = stat ? `${stat.size}:${stat.mtimeMs}` : "gone";
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
  }

  /** Between turns: pick up edits made in an editor, in the UI or in an agent's own session. */
  private syncDoc(): void {
    const path = this.state.settings.doc;
    if (!path || this.running.size > 0 || this.closed) return;
    const stat = statDoc(this.state.workspace, path);
    const key = stat ? `${stat.size}:${stat.mtimeMs}` : "gone";
    if (key === this.docWatch) return;
    const author = this.outsideAuthor();
    this.recordDoc(author.id, author.native ? { native: true } : {});
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
  writeDocument(text: string, base: string, author = this.state.human): DocRevision | null {
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
    return this.recordDoc(author) ? (this.docRevisions(path).at(-1) ?? null) : null;
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
      const entry = authors.get(change.by) ?? { added: 0, removed: 0, native: false };
      entry.added += change.added;
      entry.removed += change.removed;
      entry.native ||= Boolean(change.native);
      authors.set(change.by, entry);
    }
    const who = [...authors.entries()]
      .map(([by, stats]) => `${this.handleName(by)}${stats.native ? " (in its own session)" : ""} +${stats.added} −${stats.removed}`)
      .join(", ");
    const header = `── ${path} (the room's canonical file) changed since your last turn — ${who}`;
    if (latest.deleted) return `${header}\nThe file was deleted.`;
    const before = base >= 0 && !revisions[base]!.deleted ? this.revisionText(revisions[base]!.seq) : "";
    const after = this.revisionText(latest.seq);
    if (before === undefined || after === undefined || after === null) return `${header}\n(too large to show here — read the file)`;
    const diff = renderDiff(before ?? "", after);
    // A longer fence than any the file is likely to contain.
    return diff ? `${header}\n~~~~diff\n${diff}\n~~~~` : null;
  }

  private handleName(handle: string): string {
    const agent = this.state.agents.find((entry) => entry.id === handle);
    if (agent) return agent.label;
    return handle === this.state.human ? `${handle} (human)` : handle;
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
        if (scan.openNative || scan.exchanges.length > 0) tracker.nativeAt = Date.now();
        tracker.size = size;
        tracker.mtimeMs = mtimeMs;
        for (const exchange of scan.exchanges) this.importNative(agent, exchange);
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
      this.postSystem(`${agent.label} is busy in its own session (someone is talking to it there). Its turn here starts when that exchange ends.`, false);
    }
    return true;
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
    const addressesOthers = (mentions: string[]) =>
      mentions.some((handle) => handle === "all" || (handle !== agent.id && this.state.agents.some((entry) => entry.id === handle)));
    const fresh = (kind: MessageKind): boolean => {
      const key = `${agent.id}:${exchange.key}:${half(kind)}`;
      if (this.nativeKeys!.has(key)) return false;
      this.nativeKeys!.add(key);
      return true;
    };
    let trigger: string | null = null;
    let imported = false;
    if (exchange.prompt && fresh("human")) {
      const mentions = parseMentions(exchange.prompt, handles);
      const wakes = addressesOthers(mentions);
      const message = this.postMessage({ author: this.state.human, kind: "human", text: exchange.prompt, mentions, wakes, native });
      if (wakes) trigger ??= message.id;
      imported = true;
    }
    if (exchange.reply && passNote(exchange.reply) === null && fresh("agent")) {
      const mentions = parseMentions(exchange.reply, handles);
      const wakes = addressesOthers(mentions);
      const message = this.postMessage({ author: agent.id, kind: "agent", text: exchange.reply.trim(), mentions, wakes, native });
      if (wakes) trigger ??= message.id;
      imported = true;
    }
    if (!imported) return;
    this.log(`imported ${agent.id} native exchange ${exchange.key}`);
    if (trigger) {
      this.benched.clear();
      this.ensureRun(trigger);
      this.requestSchedule();
    }
  }

  // -------------------------------------------------------------------------
  // Messages, table, commits
  // -------------------------------------------------------------------------

  private postMessage(input: Omit<RoomMessage, "id"> & { kind: MessageKind }): MessageEntry {
    const id = `m${(this.state.counters.m ?? 0) + 1}`;
    this.store.append({ type: "message.posted", message: { id, ...input } });
    return this.state.messages[this.state.messages.length - 1]!;
  }

  private postSystem(text: string, wakes: boolean, turnId?: string): MessageEntry {
    return this.postMessage({ author: "agoryx", kind: "system", text, mentions: [], wakes, ...(turnId ? { turnId } : {}) });
  }

  private applyTableOp(raw: unknown, by: string, isHuman: boolean, turnId: string | undefined): TableOp {
    const prepared = prepareTableOp(this.state.table, raw, by, isHuman);
    const op: TableOp = { ...prepared, ...(turnId ? { turnId } : {}) };
    this.store.append({ type: "table.op", op });
    this.writeTableFile();
    if (op.op === "decide") {
      const decision = this.state.table.decisions[this.state.table.decisions.length - 1]!;
      const option = this.state.table.options.find((entry) => entry.id === decision.option);
      const who = this.state.agents.find((agent) => agent.id === by)?.label ?? by;
      this.postMessage({
        author: by,
        kind: "decision",
        text: `Decision №${decision.n}: ${option?.id} «${option?.title}»${decision.note ? ` — ${decision.note}` : ""} (decided by ${who})`,
        mentions: [],
        // A human decision is news for the agents; an agent's decision rides on its own reply.
        wakes: isHuman,
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
   * Which room agent wrote an inbox op. The shim signs it with the agent's id (or
   * kind, from a hint in its environment); an unsigned op belongs to the only
   * agent that is working right now, in a room turn or in its own session.
   */
  private opAuthor(signed: string): RoomAgent | undefined {
    const agents = this.state.agents;
    const byId = agents.find((entry) => entry.id === signed);
    if (byId) return byId;
    const byKind = agents.filter((entry) => entry.kind === signed);
    if (byKind.length === 1) return byKind[0];
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
    drainOpsInbox(this.ws, ({ agent, raw }) => {
      const member = this.opAuthor(agent);
      const nonce = typeof raw.nonce === "string" ? raw.nonce : undefined;
      if (!member) {
        const ids = this.state.agents.map((entry) => entry.id).join(" or --as ");
        if (nonce) writeAck(this.ws, nonce, { ok: false, error: `can't tell which agent wrote this — add --as ${ids}` });
        this.log(`rejected unsigned table op (${agent})`);
        return;
      }
      const by = member.id;
      const turnId = this.running.get(member.id)?.turnId;
      // An inbox file recovered after a crash may hold ops already applied: the nonce in the log says so.
      const applied = nonce ? this.appliedOp(nonce) : undefined;
      if (applied) {
        writeAck(this.ws, nonce!, { ok: true, id: applied.id ?? applied.op, text: `${applied.id ? `${applied.id} · ` : ""}${describeTableOp(applied, this.state.table)}` });
        this.log(`skipped table op ${nonce} from ${agent}: already applied`);
        return;
      }
      try {
        const op = this.applyTableOp(raw, by, false, turnId);
        if (nonce) writeAck(this.ws, nonce, { ok: true, id: op.id ?? op.op, text: `${op.id ? `${op.id} · ` : ""}${describeTableOp(op, this.state.table)}` });
      } catch (error) {
        const message = error instanceof TableOpError ? error.message : error instanceof Error ? error.message : String(error);
        if (nonce) writeAck(this.ws, nonce, { ok: false, error: message });
        this.log(`rejected table op from ${agent}: ${message}`);
      }
    });
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
    const commit = checkpointCommit(this.state.workspace, subject, lines.join("\n"));
    if (commit) this.store.append({ type: "commit.created", sha: commit.sha, subject, files: commit.files });
  }
}
