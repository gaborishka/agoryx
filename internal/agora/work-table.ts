import type { TableScenario } from "./types.js";
import type { IntelligentUI, UIInputSnapshot } from "./intelligent-ui.js";
import { wakesAgent } from "./wakes.js";
import { currentDecisionIds } from "./table-decisions.js";
export { currentDecisionIds } from "./table-decisions.js";
import type {
  EphemeralEvent, RoomEvent, RoomState, TableComponentKind, TableDecision, TableItem,
  TableOp, TableOption, TableState,
} from "./types.js";

/** Browser-safe, pure presentation model: no clocks, filesystem, network or inferred task completion. */
export interface WorkRef {
  id: string;
  kind: "table" | "message" | "turn" | "missing";
  text?: string;
  by?: string;
  status?: string;
}

export interface WorkDecision extends TableDecision {
  title: string;
  current: boolean;
  /** Who chose it, rather than who proposed it. An agent's choice remains an agent's. */
  human: boolean;
  authorLabel: string;
}

export interface WorkEvent {
  kind: "decision" | "question" | "reopened" | "review" | "done" | "objection" | "fact" | "conclusion" | "concession" | "artifact" | "component" | "error" | "run" | "workspace" | "pr" | "direction";
  seq: number;
  ts?: string;
  ref?: string;
  text: string;
  by?: string;
  authorLabel?: string;
  status?: string;
}

export interface WorkAgent {
  id: string;
  label: string;
  state: "working" | "queued" | "idle" | "error" | "interrupted";
  turnId?: string;
  activity?: string;
}

export interface WorkComponentView {
  ui?: IntelligentUI;
  inputSnapshot?: UIInputSnapshot;
  scenarios?: TableScenario[];
  id: string;
  title: string;
  kind: TableComponentKind;
  refs: WorkRef[];
  body?: string;
  file?: string;
  by: string;
  seq: number;
  updatedSeq: number;
  /** The content version used for previews; lifecycle actions preserve it. */
  contentSeq?: number;
  asOfSeq?: number;
  contentBy?: string;
  updatedBy?: string;
  source: "authored" | "derived";
  /** Sources changed after this authored version, disappeared or no longer belong in the component. */
  stale: boolean;
}

export interface WorkWarning {
  code: "stale_brief" | "missing_ref" | "awaiting_missing" | "recommendation_unavailable" | "agent_error" | "budget" | "stopped";
  ref?: string;
  text: string;
  by?: string;
}

export interface WorkHeadsUp {
  source: "authored" | "derived";
  now: string;
  changes: string[];
  next?: string;
  by?: string;
  seq?: number;
  asOfSeq: number;
  stale: boolean;
  refs: WorkRef[];
  /** Only an explicit request in the brief puts the human on the critical path. */
  awaiting?: {
    q: string;
    text: string;
    recommendation?: string;
    options: TableOption[];
    by: string;
    stale: boolean;
  };
}

export interface WorkTableView {
  runtime: {
    status: "working" | "active" | "quiet" | "stopped" | "budget" | "idle";
    runId?: string;
    working: number;
  };
  headsUp: WorkHeadsUp;
  events: WorkEvent[];
  decisions: WorkDecision[];
  historicalDecisions: WorkDecision[];
  tasks: TableItem[];
  team: WorkAgent[];
  components: WorkComponentView[];
  warnings: WorkWarning[];
  counts: { openQuestions: number; openOptions: number; activeTasks: number; currentDecisions: number; historicalDecisions: number; components: number };
}

const LIMITS = { events: 3, decisions: 8, tasks: 6, components: 12, refs: 24, warnings: 8 } as const;
const line = (text: string, max = 240): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const newest = <T extends { seq: number }>(items: readonly T[]): T[] => [...items].sort((a, b) => b.seq - a.seq);
const label = (room: RoomState, by: string): string =>
  (room.agents.find((agent) => agent.id === by) ?? room.former?.find((agent) => agent.id === by))?.label ??
  (room.guests?.[by] ? `${room.guests[by]!.label} · ${room.guests[by]!.roomName}` : by);

/** Reopened, re-chosen and orphaned historical decisions never appear as current choices. */
export const currentDecision = (table: TableState, decision: TableDecision): boolean => currentDecisionIds(table).has(decision.id);

const normalizedRef = (raw: string): string => {
  const input = raw.replace(/^#/, "").trim();
  return /^[mt]\d+$/i.test(input) ? input.toLowerCase() : input.toUpperCase();
};

/** Build once per projection: even a full surface of decision references remains linear in room size. */
export const createWorkRefResolver = (room: RoomState, currentIds = currentDecisionIds(room.table)): ((raw: string) => WorkRef) => {
  const table = room.table;
  const indexed = new Map<string, WorkRef>();
  const put = (id: string, text: string, by: string, status: string, kind: WorkRef["kind"] = "table") =>
    indexed.set(id, { id, kind, text, by, status });
  for (const q of table.questions) put(q.id, q.text, q.by, q.status);
  const options = new Map<string, TableOption>();
  for (const option of table.options) { options.set(option.id, option); put(option.id, option.title, option.by, option.status); }
  for (const note of table.notes) put(note.id, note.text, note.by, note.kind);
  for (const point of [...table.facts, ...table.settled, ...table.next, ...table.shifts]) {
    put(point.id, point.text, point.by, point.withdrawn ? "withdrawn" : point.done ? (point.checked ? "checked" : "done") : point.review ? "review" : "open");
  }
  for (const decision of table.decisions) put(decision.id, decision.title ?? options.get(decision.option)?.title ?? decision.note ?? decision.option, decision.by, currentIds.has(decision.id) ? "current" : "historical");
  for (const component of table.components ?? []) put(component.id, component.title, component.contentBy ?? component.by, component.archived ? "archived" : "active");
  for (const message of room.messages) put(message.id, message.text, message.author, message.kind, "message");
  for (const turn of room.turns) put(turn.id, label(room, turn.agent), turn.agent, turn.status, "turn");
  const resolved = new Map<string, WorkRef>();
  return (raw) => {
    const id = normalizedRef(raw);
    let ref = resolved.get(id);
    if (!ref) {
      const item = indexed.get(id);
      // Ordinary chat can be very long; flatten only records used by the compact work surface.
      ref = item ? { ...item, text: line(item.text!) } : { id, kind: "missing" };
      resolved.set(id, ref);
    }
    return ref;
  };
};

/** Resolve one context reference; collections should reuse createWorkRefResolver. */
export const workRef = (room: RoomState, raw: string): WorkRef => createWorkRefResolver(room)(raw);

/** Material context changes. Streaming, tool traces, session plumbing and ordinary agent prose stay out. */
export const isWorkTableEvent = (event: RoomEvent | EphemeralEvent): event is RoomEvent => {
  switch (event.type) {
    case "table.op": return event.op.op !== "brief";
    case "message.posted": return event.message.kind === "human" || event.message.kind === "decision" || Boolean(
      event.message.sys && ["turn.failed", "agent.failing", "thread.reported", "git.force_pushed", "pr.checks", "pr.review", "pr.merged", "pr.closed", "pr.reopened"].includes(event.message.sys.code),
    );
    case "turn.ended": return event.status === "error" || event.status === "interrupted" || Boolean(event.files?.length);
    // Runtime owns normal starts and quiet ends; neither changes the actual result or decision.
    case "run.started": return false;
    case "run.ended": return event.reason !== "quiet";
    case "run.extended":
    case "doc.revised": case "step.committed": case "workspace.reverted":
    case "pr.linked": case "pr.status": case "thread.resolved": case "thread.reopened":
    case "room.mode.changed": case "agent.added": case "agent.removed":
      return true;
    case "settings.changed": return Object.keys(event.patch).length > 0;
    default: return false;
  }
};

const eventView = (room: RoomState, event: RoomEvent, resolve: (raw: string) => WorkRef, captions?: ReadonlyMap<number, string>): WorkEvent | undefined => {
  const at = { seq: event.seq, ts: event.ts };
  const authored = (by?: string) => by ? { by, authorLabel: label(room, by) } : {};
  switch (event.type) {
    case "table.op": {
      const op = event.op;
      const base = { ...at, ...authored(op.by) };
      switch (op.op) {
        case "brief": return undefined;
        case "ask": return { ...base, kind: "question", ref: op.id, text: line(op.text) };
        case "decide": return { ...base, kind: "decision", ref: op.id, text: (op.id ? resolve(op.id).text : undefined) ?? resolve(op.target).text ?? op.note ?? op.target, status: "chosen" };
        case "reopen": return { ...base, kind: "reopened", ref: op.target, text: captions?.get(event.seq) ?? resolve(op.target).text ?? op.target };
        case "review": case "done": return { ...base, kind: op.op, ref: op.target, text: captions?.get(event.seq) ?? resolve(op.target).text ?? op.target };
        case "object": return { ...base, kind: "objection", ref: op.id, text: line(op.text), status: op.target };
        case "fact": return { ...base, kind: "fact", ref: op.id, text: line(op.text) };
        case "settle": return { ...base, kind: "conclusion", ref: op.id, text: line(op.text) };
        case "concede": return { ...base, kind: "concession", ref: op.id, text: line(op.text) };
        case "propose": return op.file || op.body ? { ...base, kind: "artifact", ref: op.id, text: line(op.title) } : undefined;
        case "component-input": return { ...base, kind: "component", ref: op.target, text: `Scenario saved for ${resolve(op.target).text ?? op.target}`, status: "scenario" };
        case "component": return { ...base, kind: "component", ref: op.target ?? op.id, text: line(op.title), status: "updated" };
        case "archive": case "restore": return { ...base, kind: "component", ref: op.target, text: captions?.get(event.seq) ?? resolve(op.target).text ?? op.target, status: op.op };
        case "delete": return { ...base, kind: "reopened", ref: op.target, text: line(op.was ?? op.target), status: "deleted" };
        // Evidence, support, edits and plans affect freshness without filling the heads-up with bookkeeping.
        default: return undefined;
      }
    }
    case "message.posted": {
      const message = event.message;
      if (message.kind === "human") return { ...at, ...authored(message.author), kind: "direction", ref: message.id, text: line(message.text) };
      if (message.sys?.code === "decision") return undefined; // table.op carries the same choice with a stable D ref.
      if (message.sys?.code === "turn.failed" || message.sys?.code === "agent.failing") return { ...at, kind: "error", ref: message.id, text: line(message.sys.message), by: message.sys.agent, authorLabel: message.sys.agent };
      return isWorkTableEvent(event) ? { ...at, ...authored(message.author), kind: message.kind === "decision" ? "decision" : "artifact", ref: message.id, text: line(message.text), status: message.sys?.code } : undefined;
    }
    case "turn.ended":
      if (event.status === "error" || event.status === "interrupted") return { ...at, ...authored(event.agent), kind: "error", ref: event.turnId, text: line(event.error?.message ?? (event.status === "interrupted" ? "Turn interrupted" : "Turn failed")), status: event.status };
      return event.files?.length ? { ...at, ...authored(event.agent), kind: "artifact", ref: event.turnId, text: line(event.files.join(", ")), status: "changed" } : undefined;
    case "run.started": return undefined;
    case "run.extended": return { ...at, ...authored(event.by), kind: "run", text: `Added ${event.turns} ${event.turns === 1 ? "turn" : "turns"}`, status: "extended" };
    case "run.ended": return event.reason === "quiet" ? undefined : { ...at, ...authored(event.by), kind: "run", text: event.reason === "budget" ? "Turn limit reached" : "Work stopped", status: event.reason };
    case "doc.revised": return { ...at, ...authored(event.by), kind: "artifact", text: event.path, status: event.text === null ? "deleted" : "revised" };
    case "step.committed": return { ...at, ...authored(event.by), kind: "artifact", ref: event.steps[0], text: line(event.subject), status: "committed" };
    case "workspace.reverted": return { ...at, ...authored(event.by), kind: "workspace", text: event.to, status: event.undoOf ? "undo" : "reverted" };
    case "pr.linked": return { ...at, ...authored(event.by), kind: "pr", text: event.url, status: "linked" };
    case "pr.status": return { ...at, kind: "pr", text: line(event.status.title), status: event.status.state };
    case "thread.resolved": case "thread.reopened": return { ...at, ...authored(event.by), kind: "workspace", text: room.name, status: event.type };
    default: return undefined;
  }
};

/** Projection fallback lets older snapshots work; event seq always means a known event, never an invented time. */
const projectedEvents = (room: RoomState, currentIds: Set<string>, resolve: (raw: string) => WorkRef): WorkEvent[] => {
  const table = room.table;
  const result: WorkEvent[] = [];
  const add = (kind: WorkEvent["kind"], item: { id: string; text?: string; title?: string; by: string; seq: number }, status?: string) =>
    result.push({ kind, ref: item.id, seq: item.seq, text: line(item.title ?? item.text ?? item.id), by: item.by, authorLabel: label(room, item.by), ...(status ? { status } : {}) });
  for (const q of table.questions) add("question", q, q.status);
  for (const option of table.options) if (option.file || option.body) add("artifact", option, option.status);
  for (const point of table.facts) add("fact", point, point.withdrawn ? "withdrawn" : undefined);
  for (const point of table.settled) add("conclusion", point);
  for (const shift of table.shifts) add("concession", shift);
  for (const note of table.notes) if (note.kind === "object") add("objection", note, note.target);
  for (const decision of table.decisions) add("decision", { ...decision, title: resolve(decision.id).text ?? decision.option }, currentIds.has(decision.id) ? "current" : "historical");
  for (const step of table.next) if (step.reviewSeq) result.push({ kind: "review", ref: step.id, seq: step.reviewSeq, text: line(step.text), by: step.review, ...(step.review ? { authorLabel: label(room, step.review) } : {}) });
  for (const component of table.components ?? []) add("component", { ...component, by: component.updatedBy ?? component.by, seq: component.updatedSeq }, component.archived ? "archived" : "active");
  for (const message of room.messages) {
    const event: RoomEvent = { type: "message.posted", message, seq: message.seq, ts: message.ts };
    if (isWorkTableEvent(event)) {
      const view = eventView(room, event, resolve);
      if (view) result.push(view);
    }
  }
  for (const turn of room.turns) {
    if (turn.endSeq !== undefined && (turn.status === "error" || turn.status === "interrupted" || turn.files?.length)) {
      const view = eventView(room, { type: "turn.ended", seq: turn.endSeq, ts: turn.endedAt ?? "", turnId: turn.id, agent: turn.agent, status: turn.status as "ok" | "pass" | "error" | "interrupted", sessionId: turn.sessionId, durationMs: turn.durationMs ?? 0, error: turn.error, files: turn.files }, resolve);
      if (view) result.push(view);
    }
  }
  for (const run of room.runs) if (run.endedSeq !== undefined && (run.endReason === "budget" || run.endReason === "stopped")) {
    result.push({ kind: "run", seq: run.endedSeq, text: run.endReason === "budget" ? "Turn limit reached" : "Work stopped", status: run.endReason });
  }
  for (const doc of room.docRevisions) result.push({ kind: "artifact", seq: doc.seq, ts: doc.ts, text: doc.path, by: doc.by, authorLabel: label(room, doc.by), status: doc.deleted ? "deleted" : "revised" });
  for (const revert of room.reverts) result.push({ kind: "workspace", seq: revert.seq, ts: revert.ts, text: revert.to, by: revert.by, authorLabel: label(room, revert.by), status: revert.undoOf ? "undo" : "reverted" });
  for (const pr of room.prs ?? []) result.push({ kind: "pr", seq: pr.seq, text: pr.status?.title ?? pr.url, by: pr.by, authorLabel: label(room, pr.by), status: "linked" });
  return result;
};

const componentStale = (kind: TableComponentKind, refs: WorkRef[]): boolean => refs.some((ref) =>
  ref.kind === "missing" || ref.status === "historical" || ref.status === "archived" || ref.status === "withdrawn" ||
  (kind === "comparison" && /^Q/.test(ref.id) && ref.status !== "open"),
);

/** A source may be renamed later; important historical actions retain their original caption. */
const eventCaptions = (events: readonly RoomEvent[]): Map<number, string> => {
  const texts = new Map<string, string>();
  const captions = new Map<number, string>();
  for (const event of newest(events).reverse()) {
    if (event.type !== "table.op") continue;
    const op = event.op;
    const target = "target" in op ? op.target : undefined;
    const text = "title" in op && typeof op.title === "string" ? op.title : "text" in op && typeof op.text === "string" ? op.text : undefined;
    if (text !== undefined) {
      const id = (op.op === "edit" || op.op === "component") && target ? target : op.id;
      if (id) texts.set(id, text);
    }
    if (target && texts.has(target)) captions.set(event.seq, line(texts.get(target)!));
    if (op.op === "delete") texts.delete(op.target);
  }
  return captions;
};

/** A question also depends on its alternatives; a W source depends on the content behind that W. */
const componentFreshness = (table: TableState, events: readonly RoomEvent[], resolve: (raw: string) => WorkRef): ((id: string) => boolean) => {
  const components = new Map((table.components ?? []).map((component) => [component.id, component]));
  const related = new Map<string, Set<string>>();
  const relate = (parent: string, child: string) => {
    const children = related.get(parent) ?? new Set<string>();
    children.add(child); related.set(parent, children);
  };
  for (const note of table.notes) { relate(note.target, note.id); relate(note.id, note.target); }
  for (const step of table.next) if (step.target) relate(step.target, step.id);

  // Retain an alternative that left/deleted its question after this content was published, but do
  // not make a newly refreshed comparison depend forever on alternatives it no longer shows.
  const memberships = new Map<string, { option: string; until?: number }[]>();
  const questionOf = new Map<string, { q: string; membership: { option: string; until?: number } }>();
  const move = (option: string, q: string | undefined, seq: number, by?: string) => {
    const prior = questionOf.get(option);
    if (prior) {
      prior.membership.until = seq; questionOf.delete(option);
      // Editing P1's q records Q2 in the op; Q1 also changed when the option left it.
      if (by && prior.q !== q) changed(prior.q, seq, by);
    }
    if (!q) return;
    const membership = { option };
    const children = memberships.get(q) ?? [];
    children.push(membership); memberships.set(q, children);
    questionOf.set(option, { q, membership });
  };
  const mutations = new Map<string, { seq: number; by: string }[]>();
  const changed = (id: string, seq: number, by: string) => {
    const list = mutations.get(id) ?? [];
    list.push({ seq, by }); mutations.set(id, list);
  };
  for (const item of [...table.questions, ...table.options, ...table.notes, ...table.facts, ...table.settled, ...table.next, ...table.shifts, ...table.decisions]) changed(item.id, item.seq, item.by);
  for (const step of table.next) if (step.reviewSeq && step.review) changed(step.id, step.reviewSeq, step.review);
  for (const component of components.values()) changed(component.id, component.updatedSeq, component.updatedBy ?? component.by);
  for (const event of newest(events).reverse()) {
    if (event.type !== "table.op") continue;
    const op = event.op;
    for (const id of new Set([op.id, "target" in op ? op.target : undefined, "q" in op ? op.q : undefined])) if (id) changed(id, event.seq, op.by);
    if (op.op === "propose" && op.id) move(op.id, op.q, event.seq, op.by);
    if (op.op === "edit" && op.target.startsWith("P") && op.q !== undefined) move(op.target, op.q || undefined, event.seq, op.by);
    if (op.op === "delete") {
      if (op.target.startsWith("P")) move(op.target, undefined, event.seq, op.by);
      if (op.target.startsWith("Q")) for (const [option, entry] of questionOf) if (entry.q === op.target) move(option, undefined, event.seq);
    }
  }
  // Precomputed old snapshots may not include a complete operation log.
  for (const option of table.options) if (option.q && !questionOf.has(option.id)) move(option.id, option.q, option.seq);

  const known = new Map<string, boolean>();
  const stale = (id: string, path = new Set<string>()): boolean => {
    if (path.has(id)) return true; // Cyclic authored sources cannot substantiate each other.
    const cached = known.get(id);
    if (cached !== undefined) return cached;
    const component = components.get(id);
    if (!component) return true;
    const contentSeq = component.contentSeq ?? component.updatedSeq;
    const cursor = component.asOfSeq ?? contentSeq;
    const contentBy = component.contentBy ?? component.by;
    const dependencies = new Set<string>();
    const queue = [...component.refs];
    for (let i = 0; i < queue.length; i += 1) {
      const source = queue[i]!;
      if (dependencies.has(source)) continue;
      dependencies.add(source);
      queue.push(...(related.get(source) ?? []));
      for (const child of memberships.get(source) ?? []) if (child.until === undefined || child.until > contentSeq) queue.push(child.option);
    }
    path.add(id);
    const invalid = componentStale(component.kind, component.refs.map(resolve)) || [...dependencies].some((source) =>
      resolve(source).kind === "missing" ||
      (source.startsWith("W") && stale(source, path)) || (mutations.get(source) ?? []).some((event) => event.seq > cursor &&
        !(event.seq <= contentSeq && event.by === contentBy)),
    );
    path.delete(id);
    known.set(id, invalid);
    return invalid;
  };
  return (id) => stale(id);
};

/** Bounded work surface. Raw room state remains available for full history and controls. */
export const workTableView = (
  room: RoomState,
  events: readonly RoomEvent[] = [],
  /** Complete table-op history preserves source freshness when the transport's event window rolls over. */
  ops: readonly { seq: number; ts: string; op: TableOp }[] = [],
): WorkTableView => {
  const table = room.table;
  const currentIds = currentDecisionIds(table);
  const resolve = createWorkRefResolver(room, currentIds);
  const semanticBySeq = new Map<number, RoomEvent>();
  for (const entry of ops) {
    const event: RoomEvent = { type: "table.op", ...entry };
    if (event.seq <= room.seq && isWorkTableEvent(event)) semanticBySeq.set(event.seq, event);
  }
  for (const event of events) if (event.seq <= room.seq && isWorkTableEvent(event)) semanticBySeq.set(event.seq, event);
  const semantic = [...semanticBySeq.values()];
  const captions = eventCaptions(semantic);
  const fallback = projectedEvents(room, currentIds, resolve);
  const material = new Map<number, { seq: number; by?: string }>();
  for (const item of [...fallback, ...table.options, ...table.notes, ...table.next]) material.set(item.seq, item);
  for (const step of table.next) if (step.reviewSeq) material.set(step.reviewSeq, { seq: step.reviewSeq, by: step.review });
  if (room.modeSince) material.set(room.modeSince, { seq: room.modeSince });
  for (const event of semantic) {
    const by = event.type === "table.op" ? event.op.by : event.type === "message.posted" ? event.message.author :
      event.type === "turn.ended" ? event.agent : "by" in event ? event.by : undefined;
    material.set(event.seq, { seq: event.seq, by });
  }
  const asOfSeq = [...material.keys()].reduce((last, seq) => Math.max(last, seq), 0);
  const bySeq = new Map(fallback.map((event) => [event.seq, event]));
  let visible = 0;
  for (const event of newest(semantic)) {
    const view = eventView(room, event, resolve, captions);
    if (view) {
      bySeq.set(event.seq, view);
      if (++visible === LIMITS.events) break;
    }
  }
  const recent = newest([...bySeq.values()]).slice(0, LIMITS.events);
  const lastRun = room.runs.at(-1);
  const active = lastRun?.status === "active" ? lastRun : undefined;
  const running = room.turns.filter((turn) => turn.status === "running");
  const runtime: WorkTableView["runtime"] = {
    status: running.length ? "working" : active ? "active" : lastRun?.endReason ?? "idle",
    ...(lastRun ? { runId: lastRun.id } : {}), working: running.length,
  };
  const latestTurns = new Map<string, RoomState["turns"][number]>();
  for (const turn of room.turns) latestTurns.set(turn.agent, turn);
  const team: WorkAgent[] = room.agents.map((agent) => {
    const turn = latestTurns.get(agent.id);
    const pending = active && (room.messages.some((message) => message.seq > (room.cursors[agent.id] ?? 0) && wakesAgent(room, { type: "message.posted", message, seq: message.seq, ts: message.ts }, agent)) ||
      semantic.some((event) => event.seq > (room.cursors[agent.id] ?? 0) && wakesAgent(room, event, agent)));
    const state = turn?.status === "running" ? "working" : pending ? "queued" : turn?.status === "error" ? "error" : turn?.status === "interrupted" ? "interrupted" : "idle";
    const activity = turn?.status === "running" ? [...turn.activity].reverse().find((entry) => entry.kind !== "thinking") : undefined;
    return { id: agent.id, label: agent.label, state, ...(turn ? { turnId: turn.id } : {}), ...(activity ? { activity: line(activity.label, 120) } : {}) };
  });
  const optionsById = new Map(table.options.map((option) => [option.id, option]));
  const decisions = newest(table.decisions).map((decision): WorkDecision => ({
    ...decision, title: decision.title ?? optionsById.get(decision.option)?.title ?? decision.option,
    current: currentIds.has(decision.id), human: decision.by === room.human, authorLabel: label(room, decision.by),
  }));
  const current = decisions.filter((decision) => decision.current);
  const activeTasks = table.next.filter((step) => !step.done);
  const tasks = newest(activeTasks).sort((a, b) => Number(Boolean(b.review)) - Number(Boolean(a.review)) || b.seq - a.seq).slice(0, LIMITS.tasks);
  const warnings: WorkWarning[] = [];
  const brief = table.brief;
  const derivedRefs = [...new Set([...recent.flatMap((event) => event.ref ? [event.ref] : []), ...tasks.slice(0, 2).map((step) => step.id), ...running.map((turn) => turn.id)])].slice(0, 5);
  const refs = (brief ? (brief.refs ?? []).slice(0, 12) : derivedRefs).map(resolve);
  const missingRefs = refs.filter((ref) => ref.kind === "missing");
  // An agent knows its own contributions made after its prompt cursor. Concurrent contributions
  // by others are unseen; after publication, every material change can invalidate the account.
  const changedSinceBrief = brief && [...material.values()].some((event) => event.seq > brief.asOfSeq &&
    !(event.seq <= brief.seq && event.by === brief.by));
  const stale = Boolean(brief && (changedSinceBrief || missingRefs.length));
  const workingNames = team.filter((agent) => agent.state === "working").map((agent) => agent.label).join(", ");
  const derivedNow = runtime.status === "working" ? `${workingNames} ${runtime.working === 1 ? "is working" : "are working"}` : runtime.status === "active" ? "Work is in progress; agents are preparing the next turn" : runtime.status === "quiet" ? "No active turns right now" : runtime.status === "stopped" ? "Work stopped" : runtime.status === "budget" ? "Turn limit reached" : "The table is ready for work";
  const headsUp: WorkHeadsUp = {
    source: brief ? "authored" : "derived", now: brief ? line(brief.now, 600) : derivedNow,
    changes: brief ? (brief.changes ?? []).slice(0, 3).map((change) => line(change, 320)) : recent.filter((event) => event.kind !== "run" && event.kind !== "direction").slice(0, 2).map((event) => event.text),
    ...(brief?.next ? { next: line(brief.next, 600) } : tasks[0] ? { next: line(tasks[0].text, 600) } : {}),
    ...(brief ? { by: brief.by, seq: brief.seq } : {}), asOfSeq: brief?.asOfSeq ?? asOfSeq, stale, refs,
  };
  if (brief?.awaiting) {
    const question = table.questions.find((item) => item.id === brief.awaiting!.q);
    if (!question) warnings.push({ code: "awaiting_missing", ref: brief.awaiting.q, text: "The question from this Heads-up is no longer on the table" });
    else if (question.status === "open") {
      const options = table.options.filter((option) => option.q === question.id && option.status === "open")
        .sort((a, b) => Number(b.id === brief.awaiting!.recommendation) - Number(a.id === brief.awaiting!.recommendation) || a.seq - b.seq);
      const requested = brief.awaiting.recommendation;
      const recommendation = requested && options.some((option) => option.id === requested) ? requested : undefined;
      if (requested && !recommendation) warnings.push({ code: "recommendation_unavailable", ref: requested, text: "The recommended option changed or is no longer available" });
      headsUp.awaiting = { q: question.id, text: question.text, ...(recommendation ? { recommendation } : {}), options, by: brief.by, stale: stale || Boolean(requested && !recommendation) };
    }
  }
  if (stale) warnings.push({ code: "stale_brief", text: "This Heads-up may not reflect important changes" });
  for (const ref of missingRefs) warnings.push({ code: "missing_ref", ref: ref.id, text: "Source no longer available" });
  for (const agent of team.filter((entry) => entry.state === "error")) {
    const turn = latestTurns.get(agent.id);
    warnings.push({ code: "agent_error", ref: turn?.id, by: agent.id, text: line(turn?.error?.message ?? "The agent's turn failed") });
  }
  if (runtime.status === "budget" || runtime.status === "stopped") warnings.push({ code: runtime.status, text: derivedNow });
  const isComponentStale = componentFreshness(table, semantic, resolve);
  const authored: WorkComponentView[] = [...(table.components ?? [])].filter((component) => !component.archived)
    .sort((a, b) => b.updatedSeq - a.updatedSeq).map((component) => {
      const resolved = component.refs.slice(0, LIMITS.refs).map(resolve);
      return { ...component, refs: resolved, source: "authored" as const, stale: isComponentStale(component.id) };
    });
  const derived: WorkComponentView[] = [];
  const auto = (id: string, title: string, kind: TableComponentKind, entries: { id: string; seq: number; by: string }[]) => {
    if (!entries.length || authored.some((component) => component.kind === kind)) return;
    const selected = entries.slice(0, LIMITS.refs);
    const latest = newest(selected)[0]!;
    derived.push({ id, title, kind, refs: selected.map((entry) => resolve(entry.id)), by: latest.by, seq: latest.seq, updatedSeq: latest.seq, source: "derived", stale: false });
  };
  // Native comparisons render a question's related proposals; native checks render the same
  // task rows as a plan. Avoid adding a second surface for content already visible there.
  const coveredArtifacts = new Set(authored.flatMap((component) => component.refs.map((ref) => ref.id)));
  const comparedQuestions = new Set(authored.filter((component) => component.kind === "comparison")
    .flatMap((component) => component.refs.filter((ref) => /^Q\d+$/.test(ref.id)).map((ref) => ref.id)));
  for (const option of table.options) if (option.q && comparedQuestions.has(option.q)) coveredArtifacts.add(option.id);
  const checkedTasks = new Set(authored.filter((component) => component.kind === "checks")
    .flatMap((component) => component.refs.filter((ref) => /^X\d+$/.test(ref.id)).map((ref) => ref.id)));
  auto("auto-plan", "Next steps", "plan", tasks.filter((task) => !checkedTasks.has(task.id)));
  auto("auto-checks", "Checks", "checks", newest(table.next.filter((step) => step.review || step.done)).slice(0, 6));
  for (const option of newest(table.options.filter((entry) => entry.status !== "withdrawn" && (entry.file || entry.body)))) {
    if (coveredArtifacts.has(option.id) || derived.some((component) => component.kind === "artifact")) continue;
    auto(`auto-${option.id}`, option.title, "artifact", [option]);
  }
  const components = [...authored, ...derived].slice(0, LIMITS.components);
  for (const component of components) for (const ref of component.refs) {
    if (ref.kind === "missing" && !warnings.some((warning) => warning.code === "missing_ref" && warning.ref === ref.id)) {
      warnings.push({ code: "missing_ref", ref: ref.id, text: `A source for component ${component.id} is no longer available` });
    }
  }
  return {
    runtime, headsUp, events: recent, decisions: current.slice(0, LIMITS.decisions),
    historicalDecisions: decisions.filter((decision) => !decision.current).slice(0, LIMITS.decisions), tasks, team, components,
    warnings: warnings.slice(0, LIMITS.warnings),
    counts: { openQuestions: table.questions.filter((q) => q.status === "open").length, openOptions: table.options.filter((option) => option.status === "open").length, activeTasks: activeTasks.length, currentDecisions: current.length, historicalDecisions: decisions.length - current.length, components: authored.length + derived.length },
  };
};
