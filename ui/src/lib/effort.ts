import type { AgentModels, RoomAgent } from "./types";

/**
 * Switching an agent's model: the change to send. An effort the new model does not take (its own levels, or its
 * kind's for the CLI's default model) goes back to the default with it, so the next turn is not started with a
 * level the CLI refuses. Without the model list, or with a model outside it, the effort is left as it is.
 */
export function modelSwitch(models: AgentModels | null, agent: Pick<RoomAgent, "kind" | "effort">, model: string | null): { model: string | null; effort?: null } {
  const kind = models?.[agent.kind];
  if (!agent.effort || !kind) return { model };
  const chosen = model === null ? undefined : kind.models.find((m) => m.id === model);
  if (model !== null && !chosen) return { model };
  const levels = chosen?.efforts ?? kind.efforts;
  return levels.includes(agent.effort) ? { model } : { model, effort: null };
}
