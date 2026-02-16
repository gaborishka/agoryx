import { createId } from "../session/ids.js";
import type { Dispatch } from "./policy.js";

export const parseMentions = (text: string): string[] => {
  const matches = text.match(/@([a-zA-Z0-9_-]+)/g) ?? [];
  return matches.map((match) => match.slice(1).toLowerCase());
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
