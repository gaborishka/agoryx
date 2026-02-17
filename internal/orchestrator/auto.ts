import type { Message, Room } from "../events/types.js";
import { makeDispatch, parseMentions } from "./helpers.js";
import type { Dispatch, OrchestrationContext, OrchestrationPolicy } from "./policy.js";

const SKILL_KEYWORDS: Record<string, string[]> = {
  code:         ["code", "код", "функці", "program"],
  implement:    ["implement", "реалізуй", "build"],
  debug:        ["debug", "баг", "bug", "виправ", "помилк", "error"],
  fix:          ["fix", "виправ", "полагод", "repair"],
  test:         ["test", "тест", "coverage", "spec"],
  refactor:     ["refactor", "рефактор", "clean", "оптиміз"],
  write:        ["write", "напиши", "створи", "generate"],
  architecture: ["architect", "архітектур", "структур", "layer"],
  review:       ["review", "перевір", "ревью", "critique", "оціни"],
  explain:      ["explain", "поясни", "розкаж", "чому"],
  plan:         ["plan", "план", "roadmap", "стратегі", "approach"],
  docs:         ["doc", "документ", "readme", "опис"],
  design:       ["design", "дизайн", "інтерфейс"],
  analyze:      ["analyz", "аналіз", "порівн", "compare", "evaluate"],
};

const SHORT_KEYWORD_WHITELIST = new Set(["ui", "ux", "db"]);

const wordMatchesKeyword = (word: string, keyword: string): boolean => {
  if (keyword.length < 3 && !SHORT_KEYWORD_WHITELIST.has(keyword)) {
    return false;
  }
  return word.startsWith(keyword);
};

const scoreAgent = (
  words: string[],
  agentSkills: string[],
): { score: number; bestSkill: string } => {
  let totalScore = 0;
  let bestSkill = "";
  let bestSkillScore = 0;

  for (const skill of agentSkills) {
    const keywords = SKILL_KEYWORDS[skill];
    if (!keywords) continue;

    let skillScore = 0;
    for (const word of words) {
      for (const keyword of keywords) {
        if (wordMatchesKeyword(word, keyword)) {
          skillScore++;
          break;
        }
      }
    }

    if (skillScore > 0) {
      totalScore += skillScore;
      if (skillScore > bestSkillScore) {
        bestSkillScore = skillScore;
        bestSkill = skill;
      }
    }
  }

  return { score: totalScore, bestSkill };
};

export class AutoPolicy implements OrchestrationPolicy {
  public readonly name = "auto";
  private fallbackIndexByRoom = new Map<string, number>();

  public constructor(
    private readonly agentSkills?: Record<string, string[]>,
  ) {}

  public onUserMessage(
    room: Room,
    message: Message,
    context: OrchestrationContext,
  ): Dispatch[] {
    // --- Pass 1: Mentions ---
    const mentions = parseMentions(message.text);

    // @all → broadcast
    if (mentions.includes("all")) {
      return context.availableAgents.map((agent, index) =>
        makeDispatch(agent, "auto:mention:all", 100 + index),
      );
    }

    // @agent → deduplicated dispatch to mentioned agents
    const uniqueMentions = [
      ...new Set(
        mentions.filter((m) => context.availableAgents.includes(m)),
      ),
    ];
    if (uniqueMentions.length > 0) {
      return uniqueMentions.map((agent, index) =>
        makeDispatch(agent, `auto:mention:${agent}`, 100 + index),
      );
    }

    // --- Pass 2: Skill match ---
    const words = message.text
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .map((w) => w.replace(/[^a-zA-Zа-яА-ЯіІїЇєЄґҐ0-9_-]/g, ""))
      .filter((w) => w.length > 0);
    const skills = this.agentSkills ?? {};

    let bestAgent = "";
    let bestScore = 0;
    let bestSkill = "";

    for (const agent of context.availableAgents) {
      const agentSkillList = skills[agent] ?? [];
      if (agentSkillList.length === 0) continue;

      const result = scoreAgent(words, agentSkillList);
      if (result.score > bestScore) {
        bestScore = result.score;
        bestAgent = agent;
        bestSkill = result.bestSkill;
      }
      // tie: first agent in availableAgents order wins (no override)
    }

    if (bestScore > 0 && bestAgent) {
      return [makeDispatch(bestAgent, `auto:skill:${bestSkill}→${bestAgent}`)];
    }

    // --- Pass 3: Round-robin fallback ---
    const index = this.fallbackIndexByRoom.get(room.id) ?? 0;
    const target = context.availableAgents[index % context.availableAgents.length];
    if (!target) {
      return [];
    }
    this.fallbackIndexByRoom.set(room.id, index + 1);
    return [makeDispatch(target, "auto:fallback:rotation")];
  }

  public onAgentMessage(
    _room: Room,
    _message: Message,
    _context: OrchestrationContext,
  ): Dispatch[] {
    return [];
  }
}
