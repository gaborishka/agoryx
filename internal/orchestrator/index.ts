/**
 * Orchestrator — central coordination module.
 *
 * Receives messages, applies the active policy, returns dispatches.
 * Supports mid-session mode switching.
 */

import type { Room, Message, OrchestrationMode } from "../events/types.js";
import type { Dispatch, OrchestrationContext, OrchestrationPolicy } from "./policy.js";
import { ManualPolicy } from "./manual.js";
import { RoundRobinPolicy } from "./round-robin.js";
import { AutoPolicy } from "./auto.js";

export class Orchestrator {
  private readonly policies = new Map<string, OrchestrationPolicy>();
  private activeMode: OrchestrationMode;

  constructor(initialMode: OrchestrationMode = "manual") {
    this.registerPolicy(new ManualPolicy());
    this.registerPolicy(new RoundRobinPolicy());
    this.registerPolicy(new AutoPolicy());
    this.activeMode = initialMode;
  }

  get mode(): OrchestrationMode {
    return this.activeMode;
  }

  setMode(mode: OrchestrationMode): void {
    if (!this.policies.has(mode)) {
      throw new Error(`Unknown orchestration mode: ${mode}`);
    }
    this.activeMode = mode;
  }

  onUserMessage(
    room: Room,
    message: Message,
    context: OrchestrationContext,
  ): Dispatch[] {
    const policy = this.policies.get(this.activeMode);
    if (!policy) {
      throw new Error(`No policy for mode: ${this.activeMode}`);
    }
    return policy.onUserMessage(room, message, context);
  }

  onAgentMessage(
    room: Room,
    message: Message,
    context: OrchestrationContext,
  ): Dispatch[] {
    const policy = this.policies.get(this.activeMode);
    if (!policy) {
      throw new Error(`No policy for mode: ${this.activeMode}`);
    }
    return policy.onAgentMessage(room, message, context);
  }

  registerPolicy(policy: OrchestrationPolicy): void {
    this.policies.set(policy.name, policy);
  }
}

export { ManualPolicy } from "./manual.js";
export { RoundRobinPolicy } from "./round-robin.js";
export { AutoPolicy } from "./auto.js";
export type { Dispatch, OrchestrationContext, OrchestrationPolicy } from "./policy.js";
