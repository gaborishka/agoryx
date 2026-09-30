/**
 * What a room's wakes cost, read back from its recorded turns: per agent, how often it was woken, how the turns
 * ended, and the time, money and tokens each kind of ending took. Only a description of what happened — nothing
 * here decides who is woken. Pure: the daemon and `agoryx usage` both read a room with it.
 */
import { wakesAgent } from "./wakes.js";
import type { AgentKind, RoomAgent, RoomEvent, RoomState, TurnError, TurnState } from "./types.js";

/** How a turn ended: a reply in the room, a pass, a failure, or stopped before it finished. */
export type TurnOutcome = "replied" | "passed" | "failed" | "stopped";

export const TURN_OUTCOMES: readonly TurnOutcome[] = ["replied", "passed", "failed", "stopped"];

export interface UsageTotals {
  turns: number;
  /** Wall time of those turns. */
  ms: number;
  /** What the CLIs reported (Claude only: Codex reports tokens, not money). */
  costUsd: number;
  /** How many of the turns reported a cost: the sum covers only them. */
  costTurns: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AgentUsage {
  agent: string;
  label: string;
  kind: AgentKind | null;
  /** Turns it was woken for, ended or not. */
  wakes: number;
  /** Turns still running (counted in `wakes`, not in any outcome). */
  running: number;
  outcomes: Record<TurnOutcome, UsageTotals>;
  /** All ended turns. */
  total: UsageTotals;
  /** Who posted what woke it, per turn (a turn woken by two counts for both). */
  wokenBy: Record<string, number>;
  /** Failed turns by the kind of failure. */
  errors: Partial<Record<TurnError["kind"], number>>;
}

export interface RoomUsage {
  room: string;
  name: string;
  /** The first and last turn's start. */
  from?: string;
  to?: string;
  agents: AgentUsage[];
  outcomes: Record<TurnOutcome, UsageTotals>;
  total: UsageTotals;
}

export const emptyTotals = (): UsageTotals => ({ turns: 0, ms: 0, costUsd: 0, costTurns: 0, inputTokens: 0, outputTokens: 0 });

const emptyOutcomes = (): Record<TurnOutcome, UsageTotals> => ({
  replied: emptyTotals(),
  passed: emptyTotals(),
  failed: emptyTotals(),
  stopped: emptyTotals(),
});

/** An ended turn's outcome; null while it runs. */
export const turnOutcome = (turn: Pick<TurnState, "status">): TurnOutcome | null =>
  turn.status === "ok" ? "replied" : turn.status === "pass" ? "passed" : turn.status === "error" ? "failed" : turn.status === "interrupted" ? "stopped" : null;

const add = (into: UsageTotals, turn: TurnState): void => {
  into.turns += 1;
  into.ms += turn.durationMs ?? (turn.endedAt ? Math.max(0, Date.parse(turn.endedAt) - Date.parse(turn.startedAt)) : 0);
  if (typeof turn.usage?.costUsd === "number") {
    into.costUsd += turn.usage.costUsd;
    into.costTurns += 1;
  }
  into.inputTokens += turn.usage?.inputTokens ?? 0;
  into.outputTokens += turn.usage?.outputTokens ?? 0;
};

/** Who posted an event that woke someone: a message's author, a table change's author. */
const wakerOf = (event: RoomEvent): string | null =>
  event.type === "message.posted" ? event.message.author : event.type === "table.op" ? event.op.by : null;

/** A room's wake economics from its state and its whole event log (`store.since(0)`). */
export const roomUsage = (state: RoomState, events: readonly RoomEvent[]): RoomUsage => {
  const agents = new Map<string, AgentUsage>();
  const entry = (id: string): AgentUsage => {
    let found = agents.get(id);
    if (!found) {
      const agent = state.agents.find((candidate) => candidate.id === id);
      found = {
        agent: id,
        label: agent?.label ?? id,
        kind: agent?.kind ?? null,
        wakes: 0,
        running: 0,
        outcomes: emptyOutcomes(),
        total: emptyTotals(),
        wokenBy: {},
        errors: {},
      };
      agents.set(id, found);
    }
    return found;
  };
  // Every agent on the roster has a row, woken or not.
  for (const agent of state.agents) entry(agent.id);

  const outcomes = emptyOutcomes();
  const total = emptyTotals();
  // Events are in seq order: a turn's window (cursorBefore, cursor] is found by binary search.
  const firstAfter = (seq: number): number => {
    let low = 0;
    let high = events.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (events[mid]!.seq <= seq) low = mid + 1;
      else high = mid;
    }
    return low;
  };

  for (const turn of state.turns) {
    const usage = entry(turn.agent);
    usage.wakes += 1;
    const agent: RoomAgent = state.agents.find((candidate) => candidate.id === turn.agent) ?? { id: turn.agent, kind: "claude", label: turn.agent };
    const wokeBy = new Set<string>();
    for (let index = firstAfter(turn.cursorBefore); index < events.length && events[index]!.seq <= turn.cursor; index += 1) {
      const event = events[index]!;
      const by = wakerOf(event);
      if (by && wakesAgent(state, event, agent)) wokeBy.add(by);
    }
    for (const by of wokeBy) usage.wokenBy[by] = (usage.wokenBy[by] ?? 0) + 1;

    const outcome = turnOutcome(turn);
    if (!outcome) {
      usage.running += 1;
      continue;
    }
    add(usage.outcomes[outcome], turn);
    add(usage.total, turn);
    add(outcomes[outcome], turn);
    add(total, turn);
    if (outcome === "failed") {
      const kind = turn.error?.kind ?? "unknown";
      usage.errors[kind] = (usage.errors[kind] ?? 0) + 1;
    }
  }

  const first = state.turns[0];
  const last = state.turns[state.turns.length - 1];
  return {
    room: state.id,
    name: state.name,
    ...(first ? { from: first.startedAt } : {}),
    ...(last ? { to: last.startedAt } : {}),
    agents: [...agents.values()],
    outcomes,
    total,
  };
};
