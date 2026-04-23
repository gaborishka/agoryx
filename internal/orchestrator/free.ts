import type { Message, Room } from "../events/types.js";
import { AutonomyGuard } from "./autonomy.js";
import { makeDispatch, parseAgentHandoffs, parseMentions } from "./helpers.js";
import type { Dispatch, OrchestrationContext, OrchestrationPolicy } from "./policy.js";

const FREE_MODE_MAX_AGENT_TURNS = 6;

const normalizeAgentAuthor = (author: string): string =>
  author.toLowerCase().replace(/^agent\./, "");

const shuffleAgents = (agents: string[]): string[] => {
  const shuffled = [...agents];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return shuffled;
};

const selectMentionedAgents = (
  mentions: string[],
  availableAgents: string[],
  excludedAgent: string | null,
): string[] => {
  const result: string[] = [];
  for (const mention of mentions) {
    if (!availableAgents.includes(mention)) {
      continue;
    }
    if (excludedAgent && mention === excludedAgent) {
      continue;
    }
    if (result.includes(mention)) {
      continue;
    }
    result.push(mention);
  }
  return result;
};

const buildTargetOrder = (
  mentions: string[],
  availableAgents: string[],
  excludedAgent: string | null,
  includeRemaining: boolean,
): string[] => {
  const filteredAgents = excludedAgent
    ? availableAgents.filter((agent) => agent !== excludedAgent)
    : [...availableAgents];
  if (filteredAgents.length === 0) {
    return [];
  }

  if (mentions.includes("all")) {
    return shuffleAgents(filteredAgents);
  }

  const mentionedAgents = selectMentionedAgents(mentions, filteredAgents, excludedAgent);
  if (!includeRemaining) {
    return mentionedAgents;
  }
  const remaining = filteredAgents.filter((agent) => !mentionedAgents.includes(agent));
  return [...mentionedAgents, ...shuffleAgents(remaining)];
};

export class FreePolicy implements OrchestrationPolicy {
  public readonly name = "free";
  private readonly autonomy = new AutonomyGuard({
    enabled: true,
    maxAgentTurns: FREE_MODE_MAX_AGENT_TURNS,
  });

  public onUserMessage(
    _room: Room,
    message: Message,
    context: OrchestrationContext,
  ): Dispatch[] {
    this.autonomy.reset();
    const mentions = parseMentions(message.text);
    const targets = buildTargetOrder(mentions, context.availableAgents, null, true);
    return targets.map((agent, index) => makeDispatch(agent, `free:user:${agent}`, 100 + index));
  }

  public onAgentMessage(
    _room: Room,
    message: Message,
    context: OrchestrationContext,
  ): Dispatch[] {
    const handoffs = parseAgentHandoffs(message.text);
    // Free-mode chaining is explicit: no tag means end of autonomous round.
    if (handoffs.length === 0) {
      return [];
    }

    const mentions = handoffs.map((handoff) => handoff.target);
    const authorAgent = normalizeAgentAuthor(message.author);
    const targets = buildTargetOrder(mentions, context.availableAgents, authorAgent, false);
    const allowedTargets = this.takeAutonomyBudget(targets);

    const forceRepeatForAll = handoffs.some(
      (handoff) => handoff.target === "all" && handoff.forceRepeat,
    );
    const forceRepeatTargets = new Set(
      handoffs
        .filter((handoff) => handoff.forceRepeat && handoff.target !== "all")
        .map((handoff) => handoff.target),
    );

    return allowedTargets.map((agent, index) => {
      const reason = forceRepeatForAll || forceRepeatTargets.has(agent)
        ? `free:agent:rebuttal:${agent}`
        : `free:agent:handoff:${agent}`;
      return makeDispatch(agent, reason, 100 + index);
    });
  }

  private takeAutonomyBudget(targets: string[]): string[] {
    const allowed: string[] = [];
    for (const target of targets) {
      if (!this.autonomy.registerAgentTurn()) {
        break;
      }
      allowed.push(target);
    }
    return allowed;
  }
}
