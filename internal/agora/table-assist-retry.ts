import type { TableAssistInput } from "./table-assist.js";

/** Retry a completed attempt with new identity while retaining the human's exact routing and intent. */
export function tableAssistRetry(previous: TableAssistInput & { agent: string }, nonce: string, agents: readonly { id: string }[]): TableAssistInput & { agent: string } {
  if (!agents.some(agent => agent.id === previous.agent)) throw new Error("The original agent is no longer in this room. Choose an agent in a new request.");
  if (nonce === previous.nonce) throw new Error("A new attempt needs a new request identity.");
  return {
    kind: previous.kind, agent: previous.agent, nonce,
    ...(previous.target === undefined ? {} : { target: previous.target }),
    ...(previous.guidance === undefined ? {} : { guidance: previous.guidance }),
  };
}
