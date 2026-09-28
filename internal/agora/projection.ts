import { applyTableOp, emptyTable } from "./table.js";
import type { RoomCreatedEvent, RoomEvent, RoomState, RunState, TurnState } from "./types.js";

export const initialState = (event: RoomCreatedEvent & { seq: number; ts: string }): RoomState => ({
  id: event.id,
  name: event.name,
  workspace: event.workspace,
  createdWorkspace: event.createdWorkspace,
  human: event.human,
  agents: event.agents,
  settings: { ...event.settings },
  createdAt: event.ts,
  seq: event.seq,
  messages: [],
  turns: [],
  runs: [],
  sessions: {},
  cursors: Object.fromEntries(event.agents.map((agent) => [agent.id, 0])),
  table: emptyTable(),
  commits: [],
  docRevisions: [],
  counters: { m: 0, t: 0, r: 0 },
});

const findTurn = (state: RoomState, turnId: string): TurnState | undefined => {
  for (let i = state.turns.length - 1; i >= 0; i -= 1) {
    if (state.turns[i]!.id === turnId) return state.turns[i];
  }
  return undefined;
};

export const findRun = (state: RoomState, runId: string): RunState | undefined => {
  for (let i = state.runs.length - 1; i >= 0; i -= 1) {
    if (state.runs[i]!.id === runId) return state.runs[i];
  }
  return undefined;
};

export const activeRun = (state: RoomState): RunState | undefined => {
  const last = state.runs[state.runs.length - 1];
  return last?.status === "active" ? last : undefined;
};

/** Mutating reducer. Events are applied in seq order exactly once. */
export const applyEvent = (state: RoomState, event: RoomEvent): void => {
  state.seq = Math.max(state.seq, event.seq);
  switch (event.type) {
    case "room.created":
      return;
    case "message.posted": {
      state.counters.m = (state.counters.m ?? 0) + 1;
      // Cursors move only when a turn starts: a message posted by an agent at the
      // end of its turn must not hide what others said while it was working.
      state.messages.push({ ...event.message, seq: event.seq, ts: event.ts });
      return;
    }
    case "run.started":
      state.counters.r = (state.counters.r ?? 0) + 1;
      state.runs.push({
        id: event.runId,
        trigger: event.trigger,
        budget: event.budget,
        used: 0,
        startedSeq: event.seq,
        status: "active",
      });
      return;
    case "run.extended": {
      const run = findRun(state, event.runId);
      if (run) run.budget += event.turns;
      return;
    }
    case "run.ended": {
      const run = findRun(state, event.runId);
      if (run) {
        run.status = "ended";
        run.endReason = event.reason;
      }
      return;
    }
    case "turn.started": {
      state.counters.t = (state.counters.t ?? 0) + 1;
      state.turns.push({
        id: event.turnId,
        agent: event.agent,
        runId: event.runId,
        cursor: event.cursor,
        seq: event.seq,
        startedAt: event.ts,
        status: "running",
        resume: event.resume,
        sessionId: event.sessionId,
        activity: [],
      });
      state.cursors[event.agent] = Math.max(state.cursors[event.agent] ?? 0, event.cursor);
      const run = findRun(state, event.runId);
      if (run) run.used += 1;
      return;
    }
    case "turn.activity": {
      const turn = findTurn(state, event.turnId);
      if (!turn) return;
      const index = turn.activity.findIndex((entry) => entry.id === event.activity.id);
      if (index >= 0) turn.activity[index] = { ...turn.activity[index], ...event.activity };
      else turn.activity.push(event.activity);
      return;
    }
    case "turn.ended": {
      const turn = findTurn(state, event.turnId);
      if (!turn) return;
      turn.status = event.status;
      turn.endedAt = event.ts;
      turn.sessionId = event.sessionId ?? turn.sessionId;
      turn.durationMs = event.durationMs;
      if (event.messageId) turn.messageId = event.messageId;
      if (event.usage) turn.usage = event.usage;
      if (event.error) turn.error = event.error;
      if (event.files) turn.files = event.files;
      if (event.changes) turn.changes = event.changes;
      for (const entry of turn.activity) {
        if (entry.status === "running") entry.status = event.status === "ok" || event.status === "pass" ? "ok" : "fail";
      }
      return;
    }
    case "session.bound":
      state.sessions[event.agent] = { sessionId: event.sessionId, boundAt: event.ts };
      return;
    case "table.op":
      applyTableOp(state.table, event.op, event.seq);
      return;
    case "settings.changed":
      state.settings = { ...state.settings, ...event.patch };
      return;
    case "commit.created":
      state.commits.push({ sha: event.sha, subject: event.subject, files: event.files, seq: event.seq });
      return;
    case "doc.revised":
      state.docRevisions.push({
        seq: event.seq,
        ts: event.ts,
        path: event.path,
        by: event.by,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        ...(event.native ? { native: true } : {}),
        hash: event.hash,
        ...(event.text === null ? { deleted: true } : {}),
        added: event.added,
        removed: event.removed,
      });
      return;
  }
};

export const runningTurns = (state: RoomState): TurnState[] =>
  state.turns.filter((turn) => turn.status === "running");
