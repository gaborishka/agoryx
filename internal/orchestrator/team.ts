import type { Message, Room, TeamRun, TeamRunStage } from "../events/types.js";
import { makeDispatch } from "./helpers.js";
import type { Dispatch, OrchestrationContext, OrchestrationPolicy } from "./policy.js";

export class TeamPolicy implements OrchestrationPolicy {
  public readonly name = "team";
  private debateIndexByRun = new Map<string, number>();

  public onUserMessage(
    _room: Room,
    _message: Message,
    _context: OrchestrationContext,
  ): Dispatch[] {
    return [];
  }

  public onAgentMessage(
    _room: Room,
    _message: Message,
    _context: OrchestrationContext,
  ): Dispatch[] {
    return [];
  }

  public selectActor(
    run: TeamRun,
    _stage: TeamRunStage,
    availableAgents: string[],
  ): string | null {
    if (availableAgents.length === 0) {
      return null;
    }
    return this.selectDebateActor(run, availableAgents);
  }

  private selectDebateActor(run: TeamRun, availableAgents: string[]): string {
    const seedIndex = this.resolveSeedIndex(run, availableAgents);
    const index = this.debateIndexByRun.get(run.id) ?? seedIndex;
    const actor = availableAgents[index % availableAgents.length]!;
    this.debateIndexByRun.set(run.id, index + 1);
    return actor;
  }

  private resolveSeedIndex(run: TeamRun, availableAgents: string[]): number {
    if (run.stepCount > 0) {
      return run.stepCount % availableAgents.length;
    }

    const mentionedAgents = extractMentionedAgents(run.goal);
    for (const mentioned of mentionedAgents) {
      const index = availableAgents.findIndex((agent) => agent === mentioned);
      if (index >= 0) {
        return index;
      }
    }

    return 0;
  }

}

const extractMentionedAgents = (text: string): string[] => {
  const mentions: string[] = [];
  const normalized = text.toLowerCase();
  const pattern = /@([a-z0-9._-]+)/g;
  for (const match of normalized.matchAll(pattern)) {
    const value = match[1];
    if (!value || value === "all") {
      continue;
    }
    if (mentions.includes(value)) {
      continue;
    }
    mentions.push(value);
  }
  return mentions;
};

export const makeTeamDispatch = (
  targetAdapter: string,
  reason: string,
): Dispatch => makeDispatch(targetAdapter, reason, 100);
