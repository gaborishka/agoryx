import type { SQLiteStore, MemorySnapshot, UpsertSnapshotInput, MemoryLogEntry } from "../storage/sqlite.js";
import { createId, nowIso } from "../session/ids.js";
import {
  renderMemoryMarkdown as defaultRenderMemoryMarkdown,
  writeMemoryFile as defaultWriteMemoryFile,
} from "./renderer.js";
import { consolidate, type ConsolidationOptions, type ConsolidationResult } from "./consolidation.js";
import { isFeatureEnabled } from "../config/features.js";

export const REDUCER_VERSION = 1;

export interface RecoveryResult {
  action: "up_to_date" | "replayed" | "full_replay";
  processed: number;
  deduped: number;
  snapshotVersion: number;
  durationMs: number;
}

export interface MemoryServiceOptions {
  rootDir?: string;
  debounceMs?: number;
  now?: () => string;
  renderer?: typeof defaultRenderMemoryMarkdown;
  writer?: typeof defaultWriteMemoryFile;
  onRendered?: (roomId: string, content: string, path: string) => void;
  onRenderError?: (roomId: string, error: unknown) => void;
  consolidation?: ConsolidationOptions & {
    /** Auto-consolidation interval in ms. Default: 300_000 (5 min). 0 to disable. */
    intervalMs?: number;
  };
}

export class MemoryService {
  private readonly roomLocks = new Map<string, Promise<void>>();
  private readonly renderTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlightRenders = new Set<Promise<void>>();
  private readonly rootDir?: string;
  private readonly debounceMs: number;
  private readonly now: () => string;
  private readonly renderer: typeof defaultRenderMemoryMarkdown;
  private readonly writer: typeof defaultWriteMemoryFile;
  private readonly onRendered?: MemoryServiceOptions["onRendered"];
  private readonly onRenderError?: MemoryServiceOptions["onRenderError"];
  private disposed = false;
  private consolidationTimer: ReturnType<typeof setInterval> | null = null;
  private readonly consolidationOptions: ConsolidationOptions;
  private readonly knownRooms = new Set<string>();

  constructor(
    private readonly store: SQLiteStore,
    options: MemoryServiceOptions = {},
  ) {
    this.rootDir = options.rootDir;
    this.debounceMs = options.debounceMs ?? 1_000;
    this.now = options.now ?? nowIso;
    this.renderer = options.renderer ?? defaultRenderMemoryMarkdown;
    this.writer = options.writer ?? defaultWriteMemoryFile;
    this.onRendered = options.onRendered;
    this.onRenderError = options.onRenderError;
    this.consolidationOptions = options.consolidation ?? {};
    const intervalMs = options.consolidation?.intervalMs ?? 300_000;
    if (intervalMs > 0 && isFeatureEnabled("DREAM_CONSOLIDATION")) {
      this.consolidationTimer = setInterval(() => {
        this.autoConsolidate();
      }, intervalMs);
      // Don't block process exit
      if (this.consolidationTimer.unref) {
        this.consolidationTimer.unref();
      }
    }
  }

  public recordDispatchStart(roomId: string, agent: string, requestId: string): void {
    this.knownRooms.add(roomId);
    this.store.appendMemoryEvent({
      eventId: createId("mev"),
      roomId,
      source: "engine",
      eventType: "dispatch_start",
      payload: { agent, requestId },
    });
  }

  public recordDispatchEnd(roomId: string, agent: string, result: string, files: string[]): void {
    this.knownRooms.add(roomId);
    this.store.appendMemoryEvent({
      eventId: createId("mev"),
      roomId,
      source: "engine",
      eventType: "dispatch_end",
      payload: { agent, result, files },
    });
  }

  public recordDecision(roomId: string, text: string): void {
    this.knownRooms.add(roomId);
    this.store.appendMemoryEvent({
      eventId: createId("mev"),
      roomId,
      source: "user",
      eventType: "decision",
      payload: { text },
    });
    if (!this.disposed) {
      this.scheduleRender(roomId);
    }
  }

  public recordNote(roomId: string, text: string, source: string = "user"): void {
    this.knownRooms.add(roomId);
    this.store.appendMemoryEvent({
      eventId: createId("mev"),
      roomId,
      source,
      eventType: "note",
      payload: { text },
    });
    if (!this.disposed) {
      this.scheduleRender(roomId);
    }
  }

  public recordError(roomId: string, agent: string, error: string): void {
    this.knownRooms.add(roomId);
    this.store.appendMemoryEvent({
      eventId: createId("mev"),
      roomId,
      source: "engine",
      eventType: "error",
      payload: { agent, error },
    });
  }

  public recordTeamStep(roomId: string, runId: string, actor: string, summary: string): void {
    this.knownRooms.add(roomId);
    this.store.appendMemoryEvent({
      eventId: createId("mev"),
      roomId,
      source: `adapter.${actor}`,
      eventType: "team_step",
      payload: { runId, actor, summary },
    });
  }

  public recordWorktreeCreate(roomId: string, agent: string, path: string, branch: string): void {
    this.knownRooms.add(roomId);
    this.store.appendMemoryEvent({
      eventId: createId("mev"),
      roomId,
      source: "engine",
      eventType: "worktree_create",
      payload: { agent, path, branch },
    });
    if (!this.disposed) {
      this.scheduleRender(roomId);
    }
  }

  public recordWorktreeRemove(roomId: string, agent: string, path: string): void {
    this.knownRooms.add(roomId);
    this.store.appendMemoryEvent({
      eventId: createId("mev"),
      roomId,
      source: "engine",
      eventType: "worktree_remove",
      payload: { agent, path },
    });
    if (!this.disposed) {
      this.scheduleRender(roomId);
    }
  }

  /**
   * Run a consolidation pass for a room.
   * Prunes stale events and deduplicates decisions.
   */
  public runConsolidation(roomId: string): ConsolidationResult | null {
    if (!isFeatureEnabled("DREAM_CONSOLIDATION")) {
      return null;
    }

    const events = this.store.listMemoryEvents(roomId);
    if (events.length === 0) return null;

    const snapshot = this.store.getMemorySnapshot(roomId);
    const existingDecisions = snapshot?.keyDecisions ?? [];

    const result = consolidate(
      events.map(e => ({
        id: e.id,
        eventType: e.eventType,
        payload: typeof e.payload === "object" && e.payload !== null
          ? e.payload as Record<string, unknown>
          : {},
        createdAt: e.timestamp,
      })),
      existingDecisions,
      this.consolidationOptions,
    );

    // Apply prune
    if (result.pruneIds.length > 0) {
      this.store.deleteMemoryEvents(roomId, result.pruneIds);
    }

    // Update snapshot with deduplicated decisions
    if (result.decisionsDeduped > 0 && snapshot) {
      this.store.upsertMemorySnapshot(roomId, {
        ...snapshot,
        keyDecisions: result.decisions,
        lastLogId: snapshot.lastLogId,
        reducerVersion: snapshot.reducerVersion,
      });
    }

    return {
      transientPruned: result.transientPruned,
      decisionsDeduped: result.decisionsDeduped,
      errorsConsolidated: result.errorsConsolidated,
      totalProcessed: result.totalProcessed,
      durationMs: result.durationMs,
    };
  }

  public rebuildSnapshot(roomId: string): MemorySnapshot | null {
    const events = this.store.listMemoryEvents(roomId);
    if (events.length === 0) return null;

    const input = this.reduceEvents(events);
    return this.store.upsertMemorySnapshot(roomId, input);
  }

  public checkAndRecover(roomId: string): RecoveryResult {
    const start = Date.now();
    const snapshot = this.store.getMemorySnapshot(roomId);
    const maxLogId = this.store.getMaxMemoryLogId(roomId);

    // No log events
    if (maxLogId === null) {
      // Stale snapshot without backing log — delete and reset
      if (snapshot && snapshot.lastLogId > 0) {
        this.store.deleteMemorySnapshot(roomId);
        return { action: "full_replay", processed: 0, deduped: 0, snapshotVersion: REDUCER_VERSION, durationMs: Date.now() - start };
      }
      return { action: "up_to_date", processed: 0, deduped: 0, snapshotVersion: REDUCER_VERSION, durationMs: Date.now() - start };
    }

    // No snapshot or version mismatch — full replay
    if (!snapshot || snapshot.reducerVersion !== REDUCER_VERSION) {
      this.rebuildSnapshot(roomId);
      const events = this.store.listMemoryEvents(roomId);
      return {
        action: "full_replay",
        processed: events.length,
        deduped: 0,
        snapshotVersion: REDUCER_VERSION,
        durationMs: Date.now() - start,
      };
    }

    // Snapshot is up to date
    if (snapshot.lastLogId >= maxLogId) {
      return { action: "up_to_date", processed: 0, deduped: 0, snapshotVersion: REDUCER_VERSION, durationMs: Date.now() - start };
    }

    // Gap: replay only missing events
    const missing = this.store.listMemoryEventsAfter(roomId, snapshot.lastLogId);
    const input = this.reduceEventsIncremental(snapshot, missing);
    this.store.upsertMemorySnapshot(roomId, input);

    return {
      action: "replayed",
      processed: missing.length,
      deduped: 0,
      snapshotVersion: REDUCER_VERSION,
      durationMs: Date.now() - start,
    };
  }

  public renderMarkdown(roomId: string): string {
    this.checkAndRecover(roomId);
    const snapshot = this.store.getMemorySnapshot(roomId);
    const events = this.store.listMemoryEvents(roomId);
    return this.renderer(snapshot, events, {
      generatedAt: this.now(),
      roomId,
    });
  }

  public renderToFile(roomId: string): string | null {
    if (!this.rootDir) {
      return null;
    }
    const content = this.renderMarkdown(roomId);
    const path = this.writer(this.rootDir, content);
    this.onRendered?.(roomId, content, path);
    return content;
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
    if (this.consolidationTimer) {
      clearInterval(this.consolidationTimer);
      this.consolidationTimer = null;
    }
    for (const timer of this.renderTimers.values()) {
      clearTimeout(timer);
    }
    this.renderTimers.clear();
    if (this.inFlightRenders.size > 0) {
      await Promise.allSettled(this.inFlightRenders);
    }
  }

  public async withRoomLock<T>(
    roomId: string,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    const previous = this.roomLocks.get(roomId) ?? Promise.resolve();
    const current = previous.then(fn, fn);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.roomLocks.set(roomId, settled);

    try {
      return await current;
    } finally {
      if (this.roomLocks.get(roomId) === settled) {
        this.roomLocks.delete(roomId);
      }
    }
  }

  private reduceEvents(events: MemoryLogEntry[]): UpsertSnapshotInput {
    const decisions: string[] = [];
    const seenDecisions = new Set<string>();
    let lastLogId = 0;

    for (const evt of events) {
      lastLogId = evt.id;
      if (evt.eventType === "decision") {
        const text = (evt.payload as { text?: unknown }).text;
        if (typeof text === "string" && text && !seenDecisions.has(text)) {
          seenDecisions.add(text);
          decisions.push(text);
        }
      }
    }

    return {
      currentGoal: "",
      activeBranch: "",
      activeWorktrees: [],
      keyDecisions: decisions,
      blockers: [],
      nextActions: [],
      taskStatus: {},
      lastLogId,
      reducerVersion: REDUCER_VERSION,
    };
  }

  private reduceEventsIncremental(
    snapshot: MemorySnapshot,
    events: MemoryLogEntry[],
  ): UpsertSnapshotInput {
    const decisions = [...snapshot.keyDecisions];
    const seenDecisions = new Set(decisions);
    let lastLogId = snapshot.lastLogId;

    for (const evt of events) {
      lastLogId = evt.id;
      if (evt.eventType === "decision") {
        const text = (evt.payload as { text?: unknown }).text;
        if (typeof text === "string" && text && !seenDecisions.has(text)) {
          seenDecisions.add(text);
          decisions.push(text);
        }
      }
    }

    return {
      currentGoal: snapshot.currentGoal,
      activeBranch: snapshot.activeBranch,
      activeWorktrees: snapshot.activeWorktrees,
      keyDecisions: decisions,
      blockers: snapshot.blockers,
      nextActions: snapshot.nextActions,
      taskStatus: snapshot.taskStatus,
      lastLogId,
      reducerVersion: REDUCER_VERSION,
    };
  }

  private autoConsolidate(): void {
    if (this.disposed || !isFeatureEnabled("DREAM_CONSOLIDATION")) return;

    for (const roomId of this.knownRooms) {
      try {
        this.runConsolidation(roomId);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[memory:consolidation] Failed for room ${roomId}: ${msg}`);
      }
    }
  }

  private scheduleRender(roomId: string): void {
    if (!this.rootDir || this.disposed) {
      return;
    }

    const active = this.renderTimers.get(roomId);
    if (active) {
      clearTimeout(active);
    }

    const timer = setTimeout(() => {
      this.renderTimers.delete(roomId);
      if (this.disposed) {
        return;
      }

      const renderPromise = this.withRoomLock(roomId, () => {
        if (this.disposed) {
          return;
        }
        this.renderToFile(roomId);
      }).catch((error: unknown) => {
        if (this.onRenderError) {
          this.onRenderError(roomId, error);
          return;
        }
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`[memory] Failed to auto-render memory file for ${roomId}: ${reason}`);
      });
      this.inFlightRenders.add(renderPromise);
      void renderPromise.finally(() => {
        this.inFlightRenders.delete(renderPromise);
      });
    }, this.debounceMs);

    this.renderTimers.set(roomId, timer);
  }
}
