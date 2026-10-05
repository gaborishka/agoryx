import type { Message, Room } from "../events/types.js";

export interface Dispatch {
  dispatchId: string;
  requestId: string;
  targetAdapter: string;
  priority: number;
  reason: string;
}

export interface OrchestrationContext {
  availableAgents: string[];
}

export interface OrchestrationPolicy {
  readonly name: string;
  onUserMessage(
    room: Room,
    message: Message,
    context: OrchestrationContext,
  ): Dispatch[];
  onAgentMessage(
    room: Room,
    message: Message,
    context: OrchestrationContext,
  ): Dispatch[];
}
