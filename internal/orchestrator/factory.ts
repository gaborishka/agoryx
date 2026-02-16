import type { OrchestrationMode } from "../events/types.js";
import { AutoPolicy } from "./auto.js";
import { ManualPolicy } from "./manual.js";
import type { OrchestrationPolicy } from "./policy.js";
import { RoundRobinPolicy } from "./round-robin.js";

export const createPolicy = (mode: OrchestrationMode): OrchestrationPolicy => {
  switch (mode) {
    case "manual":
      return new ManualPolicy();
    case "round-robin":
      return new RoundRobinPolicy();
    case "auto":
      return new AutoPolicy();
    default:
      return new ManualPolicy();
  }
};
