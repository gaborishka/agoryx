import { readTranscript } from "./transcript.js";
import type { AgentKind, RoomState, TranscriptEntry, TranscriptTool, TurnState } from "./types.js";

/** How far back one request reads a session for a turn's actions. */
const BUDGET = 64 * 1024 * 1024;

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

/**
 * This turn's actions as its session file holds them. An old turn of a long session lies far behind the
 * file's last page, so for a finished turn pages are read backwards until one reaches the turn's start or
 * every action is found; `start` is then 0, as nothing older belongs to the turn. A running turn, polled
 * while it works, reads the last page only, and a page asked for (`end`) is read alone.
 */
export function readTurnActivity(kind: AgentKind, file: string, turn: Pick<TurnState, "activity" | "startedAt" | "endedAt">, options: { end?: number; window?: number; budget?: number } = {}) {
  const ids = new Set(turn.activity.map((a) => a.id));
  const started = Date.parse(turn.startedAt);
  const all: TranscriptTool[] = [];
  let end = options.end;
  for (;;) {
    const page = readTranscript(kind, file, { ...(end === undefined ? {} : { end }), ...(options.window ? { window: options.window } : {}) });
    all.unshift(...turnActivityEntries(turn, page.entries));
    // Pages do not overlap, so an id met on two of them is as ambiguous as twice on one.
    const counts = new Map<string, number>();
    for (const e of all) counts.set(e.id, (counts.get(e.id) ?? 0) + 1);
    const entries = all.filter((e) => counts.get(e.id) === 1);
    if (options.end !== undefined || !turn.endedAt) return { entries, start: page.start, size: page.size };
    const first = page.entries.find((e) => e.at && !Number.isNaN(Date.parse(e.at)));
    if (entries.length >= ids.size || (first && Date.parse(first.at!) <= started)) return { entries, start: 0, size: page.size };
    if (page.start === 0 || page.size - page.start > (options.budget ?? BUDGET)) return { entries, start: page.start, size: page.size };
    end = page.start;
  }
}
