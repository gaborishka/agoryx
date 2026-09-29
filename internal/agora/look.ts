import type { AgentKind, RoomAgent } from "./types.js";

/**
 * How an agent looks next to the others. The colour family says which CLI it is (Claude's clay,
 * Codex's water) and never changes; when a room seats several agents of one kind, each of them
 * also gets its own `shade` of that family and a one-character `mark`, so two Claudes are told
 * apart at a glance. Both follow from the room's roster alone (its order is in the event log), so
 * the same agent looks the same after a reload, in the page and in `agoryx tail`. An agent that is
 * the only one of its kind has shade 0 and no mark: it looks exactly as its kind always has.
 *
 * Pure (no node:*): the web UI imports it too.
 */

/** Shades per kind: a room of eight agents all of one kind still gets eight. */
export const SHADES = 8;

export interface AgentLook {
  kind: AgentKind;
  /** 0 is the kind's own colour; 1–7 are nearby hues of the same family. */
  shade: number;
  /** Absent when the agent is the only one of its kind in the room. */
  mark?: string;
}

type Seat = Pick<RoomAgent, "id" | "kind" | "label">;

const initial = (text: string): string => text.match(/[\p{L}\p{N}]/u)?.[0]?.toLocaleUpperCase() ?? "";

/**
 * One character per label, distinct within the group: the initial of what sets each label apart
 * ("Claude Opus", "Claude Sonnet" → O, S; "Opus", "Sonnet" → O, S). When initials would repeat
 * ("Claude", "Claude 2"), the place in the roster: 1, 2, …
 */
export const marksFor = (labels: readonly string[]): string[] => {
  const words = labels.map((label) => label.trim().split(/\s+/));
  let shared = 0;
  // Drop the words every label starts with, as long as each keeps a word of its own.
  while (words.every((list) => list.length > shared + 1 && list[shared]!.toLowerCase() === words[0]![shared]!.toLowerCase())) shared += 1;
  const picked = words.map((list) => initial(list.slice(shared).join(" ")));
  if (picked.every(Boolean) && new Set(picked).size === picked.length) return picked;
  return labels.map((_, index) => String(index + 1));
};

/** Every agent's look, by id. */
export const agentLooks = (agents: readonly Seat[]): Map<string, AgentLook> => {
  const looks = new Map<string, AgentLook>();
  const kinds = [...new Set(agents.map((agent) => agent.kind))];
  for (const kind of kinds) {
    const group = agents.filter((agent) => agent.kind === kind);
    const marks = group.length > 1 ? marksFor(group.map((agent) => agent.label)) : [];
    group.forEach((agent, index) => {
      looks.set(agent.id, { kind, shade: index % SHADES, ...(marks[index] ? { mark: marks[index] } : {}) });
    });
  }
  return looks;
};

/** One agent's look; undefined for a handle that is not in the roster (the human, agoryx, a stranger). */
export const agentLook = (agents: readonly Seat[], id: string): AgentLook | undefined => agentLooks(agents).get(id);
