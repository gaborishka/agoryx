import type { Message, Room } from "../events/types.js";
import { makeDispatch, parseMentions } from "./helpers.js";
import type { Dispatch, OrchestrationContext, OrchestrationPolicy } from "./policy.js";

export class RoundRobinPolicy implements OrchestrationPolicy {
  public readonly name = "round-robin";
  private indexByRoom = new Map<string, number>();

  public onUserMessage(
    room: Room,
    message: Message,
    context: OrchestrationContext,
  ): Dispatch[] {
    const mentions = parseMentions(message.text).filter((mention) =>
      context.availableAgents.includes(mention),
    );
    if (mentions.length > 0) {
      return [makeDispatch(mentions[0], `round-robin:mention:${mentions[0]}`)];
    }

    const index = this.indexByRoom.get(room.id) ?? 0;
    const target = context.availableAgents[index % context.availableAgents.length];
    if (!target) {
      return [];
    }
    this.indexByRoom.set(room.id, index + 1);
    return [makeDispatch(target, "round-robin:rotation")];
  }

  public onAgentMessage(
    _room: Room,
    _message: Message,
    _context: OrchestrationContext,
  ): Dispatch[] {
    return [];
  }
}
