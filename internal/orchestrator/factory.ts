import type { OrchestrationMode } from "../events/types.js";
import { AutoPolicy } from "./auto.js";
import { ManualPolicy } from "./manual.js";
import type { OrchestrationPolicy } from "./policy.js";
import { RoundRobinPolicy } from "./round-robin.js";
import { TeamPolicy } from "./team.js";

export interface PolicyOptions {
  agentSkills?: Record<string, string[]>;
}

export const createPolicy = (
  mode: OrchestrationMode,
  options?: PolicyOptions,
): OrchestrationPolicy => {
  switch (mode) {
    case "manual":
      return new ManualPolicy();
    case "round-robin":
      return new RoundRobinPolicy();
    case "auto":
      return new AutoPolicy(options?.agentSkills);
    case "team":
      return new TeamPolicy();
    default:
      return new ManualPolicy();
  }
};
