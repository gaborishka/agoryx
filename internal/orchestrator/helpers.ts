import { createId } from "../session/ids.js";
import type { Dispatch } from "./policy.js";

export interface AgentHandoff {
  target: string;
  forceRepeat: boolean;
}

export const parseMentions = (text: string): string[] => {
  const matches = text.match(/@([a-zA-Z0-9._-]+)/g) ?? [];
  return matches.map((match) => match.slice(1).toLowerCase());
};

export const parseAgentHandoffs = (text: string): AgentHandoff[] => {
  const handoffs: AgentHandoff[] = [];
  const indexByTarget = new Map<string, number>();
  const pattern = /@([a-zA-Z0-9._-]+)(!{1,2})/g;
  for (const match of text.matchAll(pattern)) {
    const target = (match[1] ?? "").toLowerCase();
    if (!target) {
      continue;
    }
    const forceRepeat = (match[2]?.length ?? 0) >= 2;
    const existingIndex = indexByTarget.get(target);
    if (existingIndex === undefined) {
      indexByTarget.set(target, handoffs.length);
      handoffs.push({ target, forceRepeat });
      continue;
    }
    if (forceRepeat && !handoffs[existingIndex]!.forceRepeat) {
      handoffs[existingIndex] = { ...handoffs[existingIndex]!, forceRepeat: true };
    }
  }
  return handoffs;
};

export const makeDispatch = (
  targetAdapter: string,
  reason: string,
  priority = 100,
): Dispatch => ({
  dispatchId: createId("dsp"),
  requestId: createId("req"),
  targetAdapter,
  priority,
  reason,
});
