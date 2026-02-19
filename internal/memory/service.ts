import type { SQLiteStore, MemorySnapshot, UpsertSnapshotInput, MemoryLogEntry } from "../storage/sqlite.js";
import { createId } from "../session/ids.js";

export const REDUCER_VERSION = 1;

export interface RecoveryResult {
  action: "up_to_date" | "replayed" | "full_replay";
  processed: number;
  deduped: number;
  snapshotVersion: number;
  durationMs: number;
}

export class MemoryService {
  private readonly roomLocks = new Map<string, Promise<void>>();

  constructor(private readonly store: SQLiteStore) {}

  public recordDispatchStart(roomId: string, agent: string, requestId: string): void {
    this.store.appendMemoryEvent({
      eventId: createId("mev"),
      roomId,
      source: "engine",
      eventType: "dispatch_start",
      payload: { agent, requestId },
    });
  }

  public recordDispatchEnd(roomId: string, agent: string, result: string, files: string[]): void {
    this.store.appendMemoryEvent({
      eventId: createId("mev"),
      roomId,
      source: "engine",
      eventType: "dispatch_end",
      payload: { agent, result, files },
    });
  }

  public recordDecision(roomId: string, text: string): void {
    this.store.appendMemoryEvent({
      eventId: createId("mev"),
      roomId,
      source: "user",
      eventType: "decision",
      payload: { text },
    });
  }

  public recordNote(roomId: string, text: string, source: string = "user"): void {
    this.store.appendMemoryEvent({
      eventId: createId("mev"),
      roomId,
      source,
      eventType: "note",
      payload: { text },
    });
  }

  public recordError(roomId: string, agent: string, error: string): void {
    this.store.appendMemoryEvent({
      eventId: createId("mev"),
      roomId,
      source: "engine",
      eventType: "error",
      payload: { agent, error },
    });
  }

  public recordTeamStep(roomId: string, runId: string, actor: string, summary: string): void {
    this.store.appendMemoryEvent({
      eventId: createId("mev"),
      roomId,
      source: `adapter.${actor}`,
      eventType: "team_step",
      payload: { runId, actor, summary },
    });
  }

  public recordWorktreeCreate(roomId: string, agent: string, path: string, branch: string): void {
    this.store.appendMemoryEvent({
      eventId: createId("mev"),
      roomId,
      source: "engine",
      eventType: "worktree_create",
      payload: { agent, path, branch },
    });
  }

  public recordWorktreeRemove(roomId: string, agent: string, path: string): void {
    this.store.appendMemoryEvent({
      eventId: createId("mev"),
      roomId,
      source: "engine",
      eventType: "worktree_remove",
      payload: { agent, path },
    });
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
    let lastLogId = 0;

    for (const evt of events) {
      lastLogId = evt.id;
      if (evt.eventType === "decision") {
        const text = (evt.payload as any).text;
        if (text && !decisions.includes(text)) decisions.push(text);
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
    let lastLogId = snapshot.lastLogId;

    for (const evt of events) {
      lastLogId = evt.id;
      if (evt.eventType === "decision") {
        const text = (evt.payload as any).text;
        if (text && !decisions.includes(text)) decisions.push(text);
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
}
