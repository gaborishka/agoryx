import type { Message, Room } from "../events/types.js";
import { makeDispatch, parseMentions } from "./helpers.js";
import type { Dispatch, OrchestrationContext, OrchestrationPolicy } from "./policy.js";

export class ManualPolicy implements OrchestrationPolicy {
  public readonly name = "manual";

  public onUserMessage(
    _room: Room,
    message: Message,
    context: OrchestrationContext,
  ): Dispatch[] {
    const mentions = parseMentions(message.text);
    if (mentions.includes("all")) {
      return context.availableAgents.map((agent, index) =>
        makeDispatch(agent, "manual:@all", 100 + index),
      );
    }

    const requestedAgents = mentions.filter((mention) =>
      context.availableAgents.includes(mention),
    );

    return requestedAgents.map((agent, index) =>
      makeDispatch(agent, `manual:@${agent}`, 100 + index),
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
