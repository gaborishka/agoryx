import type { RoomState, TranscriptEntry, TranscriptTool, TurnState } from "./types.js";

/** A completed turn keeps its own session even after the agent resets or leaves. */
export function turnSession(state: Pick<RoomState, "sessions">, turn: TurnState): string | null {
  const current = state.sessions[turn.agent];
  if (turn.status === "running" && current && current.boundAt >= turn.startedAt) return current.sessionId;
  return turn.sessionId;
}

/** Runner ids may repeat in older Codex exec sessions; both id and the turn's time window must match. */
export function turnActivityEntries(turn: Pick<TurnState, "activity" | "startedAt" | "endedAt">, entries: readonly TranscriptEntry[]): TranscriptTool[] {
  const ids = new Set(turn.activity.map((a) => a.id));
  const start = Date.parse(turn.startedAt);
  const end = turn.endedAt ? Date.parse(turn.endedAt) : Infinity;
  const matches = entries.filter((e): e is TranscriptTool => e.kind === "tool" && ids.has(e.id) && Boolean(e.at) && Date.parse(e.at!) >= start && Date.parse(e.at!) <= end);
  const counts = new Map<string, number>();
  for (const e of matches) counts.set(e.id, (counts.get(e.id) ?? 0) + 1);
  // Ambiguous ids are not enough evidence to attach someone else's output to an action.
  return matches.filter((e) => counts.get(e.id) === 1);
}
