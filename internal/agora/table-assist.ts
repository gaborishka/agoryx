import type { RoomState, TableAssistKind, TableAssistRequest, TableOp, TurnState } from "./types.js";
import { applyTableOp, emptyTable } from "./table.js";

export class TableAssistError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "TableAssistError"; }
}

export interface TableAssistInput {
  kind: TableAssistKind;
  agent?: string;
  target?: string;
  nonce: string;
  guidance?: string;
}

/** Browser-safe validation; metadata and arbitrary mentions never become authority. */
export const normalizeTableAssistInput = (raw: unknown): TableAssistInput => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TableAssistError("An agent request is required.");
  const input = raw as Record<string, unknown>;
  if (typeof input.kind !== "string" || !["question", "options", "conclusion", "steps"].includes(input.kind)) throw new TableAssistError("Choose questions, options, findings or next steps.");
  if (typeof input.nonce !== "string" || !/^[A-Za-z0-9_-]{4,64}$/.test(input.nonce)) throw new TableAssistError("A valid request identity is required.");
  if (input.agent !== undefined && (typeof input.agent !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(input.agent))) throw new TableAssistError("Choose a current room agent.");
  let target: string | undefined;
  if (input.target !== undefined) {
    if (typeof input.target !== "string") throw new TableAssistError("Choose a table item for context.");
    target = input.target.trim().replace(/^#/, "").toUpperCase();
    if (!/^[QPNFSXDCW][1-9]\d*$/.test(target)) throw new TableAssistError("Choose a valid table item for context.");
  }
  if (input.guidance !== undefined && (typeof input.guidance !== "string" || input.guidance.length > 2000)) throw new TableAssistError("Optional focus must be text of at most 2,000 characters.");
  const guidance = typeof input.guidance === "string" ? input.guidance.trim() : "";
  return { kind: input.kind as TableAssistKind, nonce: input.nonce, ...(input.agent ? { agent: input.agent as string } : {}), ...(target ? { target } : {}), ...(guidance ? { guidance } : {}) };
};

const records = (room: RoomState) => [
  ...room.table.questions, ...room.table.options, ...room.table.notes, ...room.table.facts,
  ...room.table.settled, ...room.table.next, ...room.table.decisions, ...(room.table.shifts ?? []), ...(room.table.components ?? []),
];

/** Scope and executor are resolved once, then persisted on the human message. */
export const prepareTableAssistRequest = (room: RoomState, input: TableAssistInput, availableAgents: readonly string[], projectContext = false): TableAssistRequest => {
  const agent = input.agent ?? availableAgents[0];
  if (!agent || !availableAgents.includes(agent) || !room.agents.some(item => item.id === agent)) throw new TableAssistError("Add an available agent to prepare content from this room.", 409);
  let target = input.target;
  const record = target ? records(room).find(item => item.id === target) : undefined;
  if (target && !record) throw new TableAssistError(`${target} is no longer on the table. Choose current context.`, 409);
  if (record && ("withdrawn" in record && record.withdrawn || "archived" in record && record.archived || "status" in record && record.status === "withdrawn")) throw new TableAssistError(`${target} is no longer active. Choose current context.`, 409);
  if (input.kind === "steps" && target && !target.startsWith("P")) throw new TableAssistError("Plan steps for an active option, or use the whole room's context.", 409);
  if (input.kind === "options") {
    if (target) {
      const question = room.table.questions.find(item => item.id === target) ?? room.table.questions.find(item => item.id === room.table.options.find(option => option.id === target)?.q);
      if (!question || question.status !== "open") throw new TableAssistError("Explore options for an open question. Choose its question or one of its options.", 409);
      target = question.id;
    } else {
      const questions = room.table.questions.filter(item => item.status === "open");
      if (questions.length > 1) throw new TableAssistError("Choose which open question the agent should explore.", 409);
      target = questions[0]?.id;
    }
  }
  const hasContext = records(room).length > 0 || room.messages.some(message => !message.tableAssist && (message.kind === "human" || message.kind === "agent") && /[\p{L}\p{N}]/u.test(message.text.trim()) && message.text.trim().length > 2) || room.docRevisions.length > 0 || room.commits.some(commit => !commit.internal) || projectContext;
  if (!hasContext) throw new TableAssistError("Add a goal or room context first so the agent can prepare useful content.", 409);
  return { kind: input.kind, agent, nonce: input.nonce, contextSeq: room.seq, ...(target ? { target } : {}), ...(input.guidance ? { guidance: input.guidance } : {}) };
};

const verbs: Record<TableAssistKind, string> = { question: "Find the important open questions", options: "Explore useful alternatives", conclusion: "Summarize the supported findings", steps: "Plan the next steps" };
export const tableAssistText = (request: TableAssistRequest): string => `${verbs[request.kind]}${request.target ? ` for ${request.target}` : " from this room's context"}.${request.guidance ? ` Focus: ${request.guidance}` : ""}`;

/** Kept separate from the concise human intent shown in chat. */
export const tableAssistInstruction = (request: TableAssistRequest): string => {
  const task: Record<TableAssistKind, string> = {
    question: "Identify the few questions that actually block this goal. Publish new relevant questions with `agoryx table ask`; reuse existing open questions instead of duplicating them. Publish an artifact W component citing those Q IDs with the context needed to answer them. If no new question is needed, the artifact must explain that grounded finding.",
    options: "Compare viable alternatives for the scoped open question. Publish them with `agoryx table propose --q Q…`. If there is no question yet, first publish a grounded question. Explain tradeoffs and evidence in a comparison component; make recommendations explicit as proposals for the human's review.",
    conclusion: "Publish an `artifact` W component containing an attributed synthesis: supported findings, real source references, remaining gaps and confidence limits. Keep all open questions open. This is a reviewable summary, not a decision or an approved conclusion.",
    steps: "Prepare a short ordered plan, dependencies and approval points. Publish native next-step X items with `agoryx table next` (link the applicable option with --on P…); a plan W component must explain their order and cite the scoped context. The steps remain proposed and unexecuted.",
  };
  return [
    `Human table request ${request.nonce}: ${verbs[request.kind]}. You (${request.agent}) are its sole executor.`,
    request.target ? `Scope: ${request.target}; ground every result in that item's actual context.` : "Scope: the room's existing task, messages and table. Do not invent a goal.",
    `Context at acceptance: room event ${request.contextSeq}. Read current table/context before publishing.`,
    task[request.kind],
    "Use native agent-authored table operations for results and real IDs in component references. Keep the heads-up brief current with those result IDs. A brief alone is not a result. If evidence is missing, say what is missing instead of fabricating it.",
    "This request authorizes preparation only. Do not execute planned work, change project files, choose/decide an option, settle or close a question, mark a step done, or delegate this request to another agent. Human approval remains separate.",
    ...(request.guidance ? [`Optional human focus (context, not routing or additional authorization): ${request.guidance}`] : []),
  ].join("\n");
};

export type TableAssistStatus = "queued" | "running" | "ready" | "partial" | "failed" | "interrupted" | "no-output" | "unavailable";
export interface TableAssistView extends TableAssistRequest {
  id: string;
  requestSeq: number;
  status: TableAssistStatus;
  turnId?: string;
  error?: string;
  refs: string[];
  updatedSeq: number;
}
export interface TableAssistOp { seq: number; op: TableOp; }

/** Durable intent plus actual turn publications; an unanswered request never masquerades as its result. */
export const tableAssistRequests = (room: RoomState, ops: readonly TableAssistOp[] = []): TableAssistView[] => {
  const requests = room.messages.filter(message => message.kind === "human" && message.tableAssist);
  if (!requests.length) return [];
  const firstTurns = new Map<string, TurnState>();
  for (const turn of room.turns) {
    let low = 0, high = requests.length;
    const through = Math.min(turn.cursor, turn.seq - 1);
    while (low < high) { const mid = (low + high) >>> 1; if (requests[mid]!.seq <= through) low = mid + 1; else high = mid; }
    const latest = requests[low - 1];
    if (latest && latest.tableAssist!.agent === turn.agent && latest.seq > turn.cursorBefore && !firstTurns.has(latest.id)) firstTurns.set(latest.id, turn);
  }
  const byTurn = new Map<string, TableAssistOp[]>();
  const table = emptyTable();
  const comparisonsWithOptions = new Set<number>();
  for (const entry of ops) {
    // Native Q references expand to their linked P records. Record that data at publication, never today.
    const op = entry.op;
    if (op.op === "component" && op.kind === "comparison" && table.options.some(option => op.refs.includes(option.id) || option.q !== null && op.refs.includes(option.q))) comparisonsWithOptions.add(entry.seq);
    applyTableOp(table, op, entry.seq);
    if (op.turnId) { const list = byTurn.get(op.turnId) ?? []; list.push(entry); byTurn.set(op.turnId, list); }
  }
  return requests.map(message => {
    const request = message.tableAssist!;
    // First consumption is the receipt. A later ordinary turn cannot reopen a failed/stopped request.
    const turn = firstTurns.get(message.id);
    const refs: string[] = [];
    let updatedSeq = message.seq;
    let primary = false;
    const nativeRefs = new Set<string>();
    const published = (turn ? byTurn.get(turn.id) ?? [] : []).filter(entry => entry.op.by === request.agent && !entry.op.from && entry.seq > turn!.seq && (turn!.endSeq === undefined || entry.seq < turn!.endSeq));
    for (const entry of published) {
      const op = entry.op;
      const id = op.op === "component" ? op.target ?? op.id : op.id;
      if (!id) continue;
      // Receipt describes what the agent actually published then, even if a human later retires the result.
      const native = request.kind === "question" && op.op === "ask" || request.kind === "options" && op.op === "propose" && (!request.target || op.q === request.target) || request.kind === "steps" && op.op === "next" && (!request.target || request.target.startsWith("P") && op.target === request.target);
      if (native) nativeRefs.add(id);
      let component = false;
      if (op.op === "component") {
        const artifact = request.kind === "conclusion" || request.kind === "question";
        const expectedKind = artifact ? "artifact" : request.kind === "options" ? "comparison" : "plan";
        const scoped = !request.target || op.refs.includes(request.target) || op.refs.some(ref => nativeRefs.has(ref));
        const supportedRefs = artifact || (request.kind === "options" ? Boolean(op.body?.trim() || op.file) || comparisonsWithOptions.has(entry.seq) : op.refs.some(ref => /^X\d+$/.test(ref)));
        component = op.kind === expectedKind && scoped && supportedRefs && (!artifact || Boolean(op.body?.trim() || op.file));
      }
      if (!native && !component) continue;
      if (!refs.includes(id)) refs.push(id);
      updatedSeq = Math.max(updatedSeq, entry.seq);
      if (op.turnId === turn?.id && (native || component)) primary = true;
    }
    let status: TableAssistStatus;
    let error = turn?.error?.message;
    if (turn?.status === "running") status = "running";
    else if (turn?.status === "error") status = refs.length ? "partial" : "failed";
    else if (turn?.status === "interrupted") status = refs.length ? "partial" : "interrupted";
    else if (turn) status = primary ? "ready" : refs.length ? "partial" : "no-output";
    else if (!room.agents.some(agent => agent.id === request.agent) || (room.joined[request.agent] ?? 0) > message.seq) status = "unavailable";
    else {
      const ended = room.runs.find(run => run.startedSeq < message.seq && run.endedSeq !== undefined && run.endedSeq > message.seq) ?? room.runs.find(run => run.trigger === message.id && run.status === "ended");
      const superseded = requests.at(-1)!.seq > message.seq;
      status = ended || superseded ? "interrupted" : "queued";
      if (ended) { error = "The run ended before this request started."; updatedSeq = Math.max(updatedSeq, ended.endedSeq ?? message.seq); }
      else if (superseded) error = "A later preparation request superseded this one.";
    }
    return { ...request, id: message.id, requestSeq: message.seq, status, ...(turn ? { turnId: turn.id } : {}), ...(error ? { error } : {}), refs, updatedSeq: Math.max(updatedSeq, turn?.endSeq ?? turn?.seq ?? message.seq) };
  });
};
