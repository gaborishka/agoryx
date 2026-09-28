import { existsSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { locateNativeSession, scanNativeSession, type NativeExchange } from "./native.js";
import { activeRun } from "./projection.js";
import { buildTurnPrompt, parseMentions, passNote } from "./prompts.js";
import { truncate, type AgentRunner, type TurnResult } from "./runners/types.js";
import type { RoomStore } from "./store.js";
import { describeTableOp, prepareTableOp, renderTableMarkdown, TableOpError } from "./table.js";
import type {
  Activity,
  AgentKind,
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
  prepareWorkspace,
  snapshotChanges,
  writeAck,
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
}

/** A native exchange still being written this recently means the agent is busy there. */
const NATIVE_BUSY_MS = 5 * 60 * 1000;
const NATIVE_RELOCATE_MS = 30_000;

interface RunningTurn {
  turnId: string;
  agent: RoomAgent;
  controller: AbortController;
  snapshot: ChangeSnapshot | null;
  startedAt: number;
  done: Promise<void>;
}

const LOCK_FILE = "engine.lock";

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
    this.ws = prepareWorkspace(this.state.workspace, { initGit: this.state.createdWorkspace });
    clearStaleAcks(this.ws);
    this.writeTableFile();
    this.recover();
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
    if (existsSync(lock)) {
      const pid = Number.parseInt(readFileSync(lock, "utf8"), 10);
      if (Number.isFinite(pid) && pid !== process.pid && pidAlive(pid)) {
        throw new RoomLockedError(`room ${this.store.id} is already running in process ${pid}`);
      }
    }
    writeFileSync(lock, String(process.pid));
    lockedHere.add(this.store.dir);
    this.lockHeld = true;
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
    if (this.lockHeld) {
      rmSync(join(this.store.dir, LOCK_FILE), { force: true });
      lockedHere.delete(this.store.dir);
      this.lockHeld = false;
    }
  }

  /** Resolves when no turn is running and no run is active. */
  waitIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolveWaiter) => this.idleWaiters.push(resolveWaiter));
  }

  isIdle(): boolean {
    return this.running.size === 0 && !activeRun(this.state);
  }

  presence(): Record<string, "idle" | "working"> {
    return Object.fromEntries(this.state.agents.map((agent) => [agent.id, this.running.has(agent.id) ? "working" : "idle"]));
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
    this.ensureRun(message.id);
    this.requestSchedule();
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
    this.ensureRun(message.id, this.state.agents.length);
    this.requestSchedule();
  }

  tableOp(raw: unknown, by = this.state.human): TableOp {
    const isHuman = !this.state.agents.some((agent) => agent.id === by);
    const op = this.applyTableOp(raw, by, isHuman, undefined);
    if (isHuman) {
      this.benched.clear();
      this.ensureRun(null);
      this.requestSchedule();
    }
    return op;
  }

  updateSettings(patch: Partial<RoomSettings>): void {
    const clean: Partial<RoomSettings> = {};
    if (typeof patch.budget === "number" && patch.budget >= 1 && patch.budget <= 100) clean.budget = Math.round(patch.budget);
    if (typeof patch.network === "boolean") clean.network = patch.network;
    if (typeof patch.autoCommit === "boolean") clean.autoCommit = patch.autoCommit;
    if (patch.access === "workspace" || patch.access === "readonly") clean.access = patch.access;
    if (typeof patch.turnTimeoutMs === "number" && patch.turnTimeoutMs >= 30_000) clean.turnTimeoutMs = patch.turnTimeoutMs;
    if (Object.keys(clean).length > 0) this.store.append({ type: "settings.changed", patch: clean });
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
    const cursor = this.state.cursors[agent.id] ?? 0;
    return this.store.since(cursor).some((event) => this.wakes(event, agent));
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
    for (const agent of this.state.agents) {
      if (this.running.has(agent.id) || this.benched.has(agent.id)) continue;
      if (!this.runners[agent.kind]) continue;
      if (!this.pending(agent)) continue;
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
      this.postSystem(
        `Turn budget reached (${run.used} agent turns). The run paused with things still open — write anything, or ask for another round, to continue.`,
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
        events: this.store.since(rejoin ? 0 : fromSeq).filter((event) => event.seq <= cursor),
        turnsLeft,
        fresh,
        rejoin,
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
      .then((result) => this.finishTurn(agent, turnId, run.id, result, snapshot, startedAt));

    this.running.set(agent.id, { turnId, agent, controller, snapshot, startedAt, done });
    this.ensureOpsPolling();
    this.log(`${agent.id} ${turnId} started (${sessionId ? "resume" : "fresh"}, ${prompt.length} chars)`);
  }

  private finishTurn(
    agent: RoomAgent,
    turnId: string,
    runId: string,
    result: TurnResult,
    snapshot: ChangeSnapshot | null,
    startedAt: number,
  ): void {
    // Sweep the inbox while this turn still counts as running, so its ops are attributed to it.
    this.ingestOps();
    this.running.delete(agent.id);
    const files = this.attributeFiles(turnId, diffSnapshots(snapshot, snapshotChanges(this.state.workspace)));

    let messageId: string | undefined;
    let status: "ok" | "pass" | "error" | "interrupted" = result.status;
    if (result.status === "ok") {
      const note = passNote(result.text);
      if (note !== null) {
        status = "pass";
        messageId = this.postMessage({ author: agent.id, kind: "pass", text: note, mentions: [], wakes: false, turnId, runId }).id;
      } else {
        const handles = [...this.state.agents.map((entry) => entry.id), this.state.human.toLowerCase()];
        messageId = this.postMessage({
          author: agent.id,
          kind: "agent",
          text: result.text.trim(),
          mentions: parseMentions(result.text, handles),
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
   * Turns run in parallel in one workspace, so a git diff alone would credit
   * a file to everyone who was running. A file another overlapping turn
   * reported editing (and this one did not) belongs to that turn.
   */
  private attributeFiles(turnId: string, files: string[]): string[] {
    if (files.length === 0) return files;
    const turn = this.state.turns.find((entry) => entry.id === turnId);
    if (!turn) return files;
    const claims = (entry: TurnState, file: string) =>
      entry.activity.some((activity) => activity.kind === "edit" && activity.label.includes(file));
    const overlapping = this.state.turns.filter(
      (entry) => entry.id !== turnId && (entry.status === "running" || (entry.endedAt !== undefined && entry.endedAt >= turn.startedAt)),
    );
    if (overlapping.length === 0) return files;
    return files.filter((file) => claims(turn, file) || !overlapping.some((entry) => claims(entry, file)));
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
        tracker.size = size;
        tracker.mtimeMs = mtimeMs;
        for (const exchange of scan.exchanges) this.importNative(agent, exchange);
      } catch (error) {
        this.log(`could not read ${agent.id}'s native session: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Someone is mid-conversation with this agent in its own app: don't resume the same session under them. */
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
    this.nativeKeys ??= new Set(
      this.state.messages.filter((message) => message.native).map((message) => `${message.native!.agent}:${message.native!.key}`),
    );
    const dedupe = `${agent.id}:${exchange.key}`;
    if (this.nativeKeys.has(dedupe)) return;
    this.nativeKeys.add(dedupe);
    const native = { agent: agent.id, key: exchange.key, ...(exchange.at ? { at: exchange.at } : {}) };
    const handles = [...this.state.agents.map((entry) => entry.id), this.state.human.toLowerCase()];
    const addressesOthers = (mentions: string[]) =>
      mentions.some((handle) => handle === "all" || (handle !== agent.id && this.state.agents.some((entry) => entry.id === handle)));
    let trigger: string | null = null;
    if (exchange.prompt) {
      const mentions = parseMentions(exchange.prompt, handles);
      const wakes = addressesOthers(mentions);
      const message = this.postMessage({ author: this.state.human, kind: "human", text: exchange.prompt, mentions, wakes, native });
      if (wakes) trigger ??= message.id;
    }
    if (exchange.reply && passNote(exchange.reply) === null) {
      const mentions = parseMentions(exchange.reply, handles);
      const wakes = addressesOthers(mentions);
      const message = this.postMessage({ author: agent.id, kind: "agent", text: exchange.reply.trim(), mentions, wakes, native });
      if (wakes) trigger ??= message.id;
    }
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

  /** Pull table ops agents wrote via the `agoryx table` shim and ack them. */
  ingestOps(): void {
    for (const { agent, raw } of drainOpsInbox(this.ws)) {
      const member = this.opAuthor(agent);
      const nonce = typeof raw.nonce === "string" ? raw.nonce : undefined;
      if (!member) {
        const ids = this.state.agents.map((entry) => entry.id).join(" or --as ");
        if (nonce) writeAck(this.ws, nonce, { ok: false, error: `can't tell which agent wrote this — add --as ${ids}` });
        this.log(`rejected unsigned table op (${agent})`);
        continue;
      }
      const by = member.id;
      const turnId = this.running.get(member.id)?.turnId;
      try {
        const op = this.applyTableOp(raw, by, false, turnId);
        if (nonce) writeAck(this.ws, nonce, { ok: true, id: op.id ?? op.op, text: `${op.id ? `${op.id} · ` : ""}${describeTableOp(op, this.state.table)}` });
      } catch (error) {
        const message = error instanceof TableOpError ? error.message : error instanceof Error ? error.message : String(error);
        if (nonce) writeAck(this.ws, nonce, { ok: false, error: message });
        this.log(`rejected table op from ${agent}: ${message}`);
      }
    }
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
