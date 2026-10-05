import { guestHandle } from "./actor.js";
import { applyTableOp, emptyTable } from "./table.js";
import type { ActorOrigin, RoomCreatedEvent, RoomEvent, RoomState, RunState, TurnState } from "./types.js";

/** `owner/name`, lowercase, of a pull request's URL. */
export const prRepo = (url: string): string => (/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\//.exec(url)?.[1] ?? "").toLowerCase();

export const initialState = (event: RoomCreatedEvent & { seq: number; ts: string }): RoomState => ({
  id: event.id,
  name: event.name,
  workspace: event.workspace,
  mode: event.mode ?? "work",
  ...(event.projectKey !== undefined ? { projectKey: event.projectKey } : {}),
  project: event.project ?? ((event.mode ?? "work") === "work" ? { workspace: event.workspace, createdWorkspace: event.createdWorkspace, worktree: event.worktree, doc: event.settings.doc } : undefined),
  workspaceHistory: [{ seq: event.seq, workspace: event.workspace }],
  createdWorkspace: event.createdWorkspace,
  ...(event.worktree ? { worktree: event.worktree } : {}),
  human: event.human,
  agents: event.agents,
  former: [],
  joined: {},
  settings: { ...event.settings, autoCommit: false },
  createdAt: event.ts,
  seq: event.seq,
  messages: [],
  turns: [],
  runs: [],
  sessions: {},
  cursors: Object.fromEntries(event.agents.map((agent) => [agent.id, 0])),
  profiles: {},
  projectSeen: {},
  table: emptyTable(),
  commits: [],
  reverts: [],
  docRevisions: [],
  counters: { m: 0, t: 0, r: 0 },
  guests: event.createdBy ? { [guestHandle(event.createdBy)]: event.createdBy } : {},
  ...(event.createdBy ? { createdBy: event.createdBy } : {}),
  ...(event.parent ? { parent: event.parent } : {}),
});

/** The agent of another room an event names, if any: remembered so its handle can be named later. */
const eventOrigin = (event: RoomEvent): ActorOrigin | undefined => {
  switch (event.type) {
    case "message.posted":
      return event.message.from;
    case "table.op":
      return event.op.from;
    case "run.extended":
    case "run.ended":
    case "settings.changed":
    case "room.renamed":
    case "agent.changed":
    case "doc.revised":
    case "pr.linked":
      return event.from;
    default:
      return undefined;
  }
};

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
  const origin = eventOrigin(event);
  if (origin) state.guests[guestHandle(origin)] = origin;
  switch (event.type) {
    case "room.created":
      return;
    case "room.project.changed": {
      state.projectKey = event.projectKey;
      state.projectSeen = {};
      // A different project must start a fresh native context, with the room history replayed.
      state.sessions = {};
      state.cursors = Object.fromEntries(state.agents.map((agent) => [agent.id, 0]));
      return;
    }
    case "room.mode.changed": {
      if (event.projectKey !== undefined) state.projectKey = event.projectKey;
      state.mode = event.mode;
      state.workspace = event.workspace;
      state.project = event.project;
      state.createdWorkspace = event.mode === "work" && Boolean(event.project?.createdWorkspace);
      state.worktree = event.mode === "work" ? event.project?.worktree : undefined;
      state.settings.doc = event.mode === "work" ? event.project?.doc : null;
      state.settings.autoCommit = false;
      state.workspaceHistory ??= [];
      state.workspaceHistory.push({ seq: event.seq, workspace: event.workspace });
      state.modeSince = event.seq;
      // Native sessions belong to a cwd. Start fresh with the same room history at the new location.
      state.sessions = {};
      state.cursors = Object.fromEntries(state.agents.map((agent) => [agent.id, 0]));
      state.profiles = {};
      state.projectSeen = {};
      delete state.repo;
      return;
    }
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
      if (run && run.budget !== null) run.budget += event.turns;
      return;
    }
    case "run.ended": {
      const run = findRun(state, event.runId);
      if (run) {
        run.status = "ended";
        run.endReason = event.reason;
        run.endedSeq = event.seq;
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
        cursorBefore: state.cursors[event.agent] ?? 0,
        seq: event.seq,
        startedAt: event.ts,
        status: "running",
        resume: event.resume,
        sessionId: event.sessionId,
        activity: [],
        profile: event.profile ?? "",
        profileBefore: state.profiles[event.agent] ?? "",
        ...(event.project !== undefined ? { project: event.project, projectBefore: state.projectSeen?.[event.agent] ?? 0 } : {}),
        ...(event.limitMs !== undefined ? { limitMs: event.limitMs } : {}),
      });
      state.cursors[event.agent] = Math.max(state.cursors[event.agent] ?? 0, event.cursor);
      state.profiles[event.agent] = event.profile ?? "";
      if (event.project !== undefined) (state.projectSeen ??= {})[event.agent] = event.project;
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
      turn.endSeq = event.seq;
      turn.endedAt = event.ts;
      turn.sessionId = event.sessionId ?? turn.sessionId;
      turn.durationMs = event.durationMs;
      if (event.messageId) turn.messageId = event.messageId;
      if (event.usage) turn.usage = event.usage;
      if (event.error) turn.error = event.error;
      if (event.files) turn.files = event.files;
      if (event.changes) turn.changes = event.changes;
      // A turn that failed, or died with the process, never answered what it was shown: show it again
      // next time, unless a later turn of the same agent already moved the cursor on. (A turn the human
      // stopped keeps it: they stopped that work.)
      if ((event.status === "error" || event.unseen) && state.cursors[turn.agent] === turn.cursor) {
        state.cursors[turn.agent] = turn.cursorBefore;
      }
      // Likewise the profile: a version it never answered is given again.
      if ((event.status === "error" || event.unseen) && state.profiles[turn.agent] === turn.profile && turn.profileBefore !== undefined) {
        state.profiles[turn.agent] = turn.profileBefore;
      }
      if ((event.status === "error" || event.unseen) && turn.project !== undefined && state.projectSeen?.[turn.agent] === turn.project) {
        state.projectSeen[turn.agent] = turn.projectBefore ?? 0;
      }
      for (const entry of turn.activity) {
        if (entry.status === "running") entry.status = event.status === "ok" || event.status === "pass" ? "ok" : "fail";
      }
      return;
    }
    case "session.bound":
      state.sessions[event.agent] = { sessionId: event.sessionId, boundAt: event.ts, ...(event.briefingVersion !== undefined ? { briefingVersion: event.briefingVersion } : {}) };
      return;
    case "table.op":
      applyTableOp(state.table, event.op, event.seq, {
        alone: state.agents.length === 1,
        human: !event.op.from && event.op.by === state.human,
      });
      return;
    case "settings.changed":
      state.settings = { ...state.settings, ...event.patch, autoCommit: false };
      return;
    case "room.renamed":
      state.name = event.name;
      return;
    case "thread.resolved":
      state.resolved = { by: event.by, at: event.ts };
      return;
    case "thread.reopened":
      delete state.resolved;
      return;
    case "agent.changed":
      state.agents = state.agents.map((agent) => {
        if (agent.id !== event.agent) return agent;
        const next = { ...agent };
        if (event.model !== undefined) {
          if (event.model === null) delete next.model;
          else next.model = event.model;
        }
        if (event.effort !== undefined) {
          if (event.effort === null) delete next.effort;
          else next.effort = event.effort;
        }
        if (event.role !== undefined) {
          if (event.role === null) delete next.role;
          else next.role = event.role;
        }
        if (event.label !== undefined) next.label = event.label;
        if (event.profile !== undefined) {
          if (event.profile) delete next.profile;
          else next.profile = false;
        }
        return next;
      });
      return;
    case "agent.added":
      state.agents = [...state.agents, event.agent];
      state.former = state.former.filter((agent) => agent.id !== event.agent.id);
      state.joined[event.agent.id] = event.seq;
      // Its first turn reads the conversation from the start (or, back again, from where it left off).
      state.cursors[event.agent.id] ??= 0;
      return;
    case "agent.removed": {
      const gone = state.agents.find((agent) => agent.id === event.agent);
      if (!gone) return;
      state.agents = state.agents.filter((agent) => agent.id !== event.agent);
      state.former = [...state.former.filter((agent) => agent.id !== event.agent), gone];
      return;
    }
    case "commit.created":
      state.commits.push({ sha: event.sha, subject: event.subject, files: event.files, seq: event.seq, workspace: event.workspace ?? state.workspace, internal: event.internal, ...(event.folder ? { folder: event.folder } : {}) });
      return;
    case "step.committed":
      // The first commit a step went into is the one it is in; a later one naming it again does not move it.
      for (const step of state.table.next) if (event.steps.includes(step.id) && !step.commit) step.commit = { sha: event.sha, by: event.by, seq: event.seq };
      return;
    case "workspace.reverted": {
      const { type: _type, seq, ts, ...rest } = event;
      state.reverts.push({ seq, ts, ...rest });
      // An undo marks the return it undid: this room's own, or, for one made in another room, that room's.
      const undone =
        event.undoOf === undefined
          ? undefined
          : state.reverts.find((entry) => (event.fromRoom ? entry.fromRoom?.room === event.fromRoom.room && entry.fromRoom.seq === event.undoOf : !entry.fromRoom && entry.seq === event.undoOf));
      if (undone) undone.undone = seq;
      return;
    }
    case "doc.revised":
      state.docRevisions.push({
        seq: event.seq,
        ts: event.ts,
        path: event.path,
        by: event.by,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        ...(event.native ? { native: true } : {}),
        ...(event.among ? { among: event.among } : {}),
        hash: event.hash,
        ...(event.text === null ? { deleted: true } : {}),
        added: event.added,
        removed: event.removed,
      });
      return;
    case "repo.seen":
      state.repo = { repo: event.repo, remote: event.remote, branch: event.branch, ...(event.base ? { base: event.base } : {}), seq: event.seq };
      return;
    case "repo.gone":
      delete state.repo;
      return;
    case "pr.linked": {
      const repo = event.repo ?? prRepo(event.url);
      if (!(state.prs ??= []).some((pr) => pr.repo === repo && pr.number === event.number)) {
        state.prs.push({ repo, number: event.number, url: event.url, by: event.by, ...(event.via ? { via: event.via } : {}), seq: event.seq, ...(event.turnId ? { turnId: event.turnId } : {}) });
      }
      return;
    }
    case "pr.status": {
      const pr = state.prs?.find((entry) => entry.number === event.number && (event.repo === undefined || entry.repo === event.repo));
      if (pr) pr.status = event.status;
      return;
    }
  }
};

export const runningTurns = (state: RoomState): TurnState[] =>
  state.turns.filter((turn) => turn.status === "running");
