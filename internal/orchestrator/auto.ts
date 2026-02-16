import type { Message, Room } from "../events/types.js";
import { makeDispatch, parseMentions } from "./helpers.js";
import type { Dispatch, OrchestrationContext, OrchestrationPolicy } from "./policy.js";

export class AutoPolicy implements OrchestrationPolicy {
  public readonly name = "auto";

  public onUserMessage(
    _room: Room,
    message: Message,
    context: OrchestrationContext,
  ): Dispatch[] {
    const mentions = parseMentions(message.text).filter((mention) =>
      context.availableAgents.includes(mention),
    );
    if (mentions.length > 0) {
      return mentions.map((agent, index) =>
        makeDispatch(agent, `auto:mention:${agent}`, 100 + index),
      );
    }

    return context.availableAgents.map((agent, index) =>
      makeDispatch(agent, "auto:broadcast", 100 + index),
    );
  }

  public onAgentMessage(
    _room: Room,
    _message: Message,
    _context: OrchestrationContext,
  ): Dispatch[] {
    return [];
  }
}
