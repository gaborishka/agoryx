import type { RoomAgent, RoomEvent, RoomState } from "./types.js";

/** Whether an agent was in a turn when event `seq` was posted (and so could read it with `read new`). Pure. */
export const inTurnAt = (state: RoomState, agentId: string, seq: number): boolean =>
  state.turns.some((turn) => turn.agent === agentId && turn.seq < seq && (turn.endSeq === undefined || turn.endSeq > seq));

/** Whether an event wakes an agent: the room's one rule, for the engine and for reading a room back. Pure. */
export const wakesAgent = (state: RoomState, event: RoomEvent, agent: RoomAgent): boolean => {
  if (event.type === "message.posted") {
    const message = event.message;
    if (message.author === agent.id || !message.wakes) return false;
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
    return (event.op.by === state.human || Boolean(event.op.from)) && !event.op.turnId;
  }
  return false;
};
