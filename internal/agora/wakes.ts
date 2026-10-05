import type { RoomAgent, RoomEvent, RoomState } from "./types.js";

const PRESENTATION_OPS = new Set(["brief", "component", "archive", "restore"]);
/** Publishing or maintaining the work surface is context, never a request for another model turn. */
export const isTablePresentationOp = (op: unknown): boolean => typeof op === "string" && PRESENTATION_OPS.has(op);

/** Whether an agent was in a turn when event `seq` was posted (and so could read it with `read new`). Pure. */
export const inTurnAt = (state: RoomState, agentId: string, seq: number): boolean =>
  state.turns.some((turn) => turn.agent === agentId && turn.seq < seq && (turn.endSeq === undefined || turn.endSeq > seq));

/** Whether an event wakes an agent: the room's one rule, for the engine and for reading a room back. Pure. */
export const wakesAgent = (state: RoomState, event: RoomEvent, agent: RoomAgent): boolean => {
  // What was said before the agent was seated is for reading, not answering.
  if (event.seq <= (state.joined?.[agent.id] ?? 0)) return false;
  if (event.type === "message.posted") {
    const message = event.message;
    if (message.author === agent.id || !message.wakes) return false;
    // A structured preparation request retains its exact executor even after that agent leaves.
    if (message.tableAssist) {
      if (message.kind !== "human" || message.tableAssist.agent !== agent.id) return false;
      // A toolbar request is consumed once. Failure/stop is visible and an explicit retry records new intent.
      if (state.turns.some(turn => turn.agent === agent.id && turn.seq > event.seq && turn.cursorBefore < event.seq && turn.cursor >= event.seq && turn.status !== "running")) return false;
      if (state.runs.some(run => run.status === "ended" && (run.trigger === message.id || run.startedSeq < event.seq && (run.endedSeq ?? 0) > event.seq))) return false;
      return true;
    }
    // Said while working: wakes only who it addresses, and only one that was not in a turn to read it then.
    if (message.kind === "update") {
      return (message.mentions.includes("all") || message.mentions.includes(agent.id)) && !inTurnAt(state, agent.id, event.seq);
    }
    // Said in someone's own session: wakes only who it explicitly addresses, never that session's agent.
    if (message.native) {
      return message.native.agent !== agent.id && (message.mentions.includes("all") || message.mentions.includes(agent.id));
    }
    // Agoryx's own note that names agents (a second look) wakes only them.
    if (message.kind === "system" && message.author === "agoryx" && message.mentions.length > 0) return message.mentions.includes(agent.id);
    if (message.kind === "human" && message.mentions.length > 0) {
      const agentMentions = message.mentions.filter((handle) => handle === "all" || state.agents.some((entry) => entry.id === handle));
      if (agentMentions.length > 0 && !agentMentions.includes("all") && !agentMentions.includes(agent.id)) return false;
    }
    return true;
  }
  if (event.type === "table.op") {
    if (isTablePresentationOp(event.op.op)) return false;
    return (event.op.by === state.human || Boolean(event.op.from)) && !event.op.turnId;
  }
  return false;
};
