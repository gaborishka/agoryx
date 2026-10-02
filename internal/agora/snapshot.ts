import type { AgentPresence, RoomEvent, RoomState, TurnState } from "./types.js";

export interface StreamBuffer {
  agent: string;
  text: string;
}

export const runningTurnsPresence = (state: RoomState): boolean[] =>
  state.agents.map((agent) => state.turns.some((turn) => turn.agent === agent.id && turn.status === "running"));

export const presenceOf = (state: RoomState): Record<string, AgentPresence> =>
  Object.fromEntries(
    state.agents.map((agent) => [
      agent.id,
      state.turns.some((turn) => turn.agent === agent.id && turn.status === "running") ? "working" : "idle",
    ]),
  );

/** What a client needs to render a room from scratch. */
export const roomSnapshot = (state: RoomState, streams: Map<string, StreamBuffer> = new Map()) => ({
  state,
  presence: presenceOf(state),
  streams: Object.fromEntries([...streams.entries()].map(([turnId, buffer]) => [turnId, buffer])),
});

const findTurn = (state: RoomState, turnId: string): TurnState | undefined => {
  for (let index = state.turns.length - 1; index >= 0; index -= 1) {
    if (state.turns[index]!.id === turnId) return state.turns[index];
  }
  return undefined;
};

/**
 * The slice of projected state a client must merge after `event`, so browser
 * clients never re-implement the projection. Small collections ride along
 * whole; messages and turns are upserted by id; activities are merged by id.
 */
export const eventPatch = (state: RoomState, event: RoomEvent): Record<string, unknown> => {
  // The event's own seq, not the state's: a client catching up replays several events against today's
  // state, and a newer seq on the first patch would make it drop the rest as already seen.
  const guest = event.type === "message.posted" ? event.message.from : event.type === "table.op" ? event.op.from : "from" in event ? event.from : undefined;
  // An agent of another room acted: the client learns who that handle is.
  const base = { seq: event.seq, runs: state.runs, presence: presenceOf(state), ...(guest ? { guests: state.guests } : {}) };
  switch (event.type) {
    case "message.posted": {
      const message = state.messages.find((entry) => entry.id === event.message.id);
      return { ...base, message };
    }
    case "turn.started":
      return { ...base, turn: findTurn(state, event.turnId), cursors: state.cursors };
    case "turn.activity":
      return { ...base, activity: { turnId: event.turnId, activity: event.activity } };
    case "turn.ended":
      return { ...base, turn: findTurn(state, event.turnId), sessions: state.sessions };
    case "session.bound":
      return { ...base, sessions: state.sessions };
    case "table.op":
    case "step.committed":
      return { ...base, table: state.table };
    case "settings.changed":
      return { ...base, settings: state.settings };
    case "room.renamed":
      return { ...base, name: state.name };
    case "agent.changed":
      return { ...base, agents: state.agents };
    case "agent.added":
    case "agent.removed":
      return { ...base, agents: state.agents, former: state.former, cursors: state.cursors };
    case "commit.created":
      return { ...base, commits: state.commits };
    case "workspace.reverted":
      return { ...base, reverts: state.reverts };
    case "doc.revised":
      return { ...base, docRevisions: state.docRevisions };
    case "repo.seen":
    case "repo.gone":
      return { ...base, repo: state.repo ?? null };
    case "pr.linked":
    case "pr.status":
      return { ...base, prs: state.prs };
    default:
      return base;
  }
};
