import { checkpointSubject } from "./checkpoint-message.js";
import { stepBuilder } from "./table.js";
import type { RoomEvent, RoomState, TableItem, TurnState } from "./types.js";
import { gitOperation, uncommittedFiles } from "./workspace.js";

/** Why a step cannot be committed now, with the HTTP status the daemon answers with. */
export class StepCommitError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** A file the human may commit with a step: this room's turns that changed it, and whether one of the step's own turns did. */
export interface StepCommitFile {
  path: string;
  turns: Array<{ id: string; agent: string }>;
  step: boolean;
}

export interface StepCommitPlan {
  step: string;
  subject: string;
  files: StepCommitFile[];
}

/** A commit names its step first, as the agents are asked to: `X3 Quote chips`. */
export const stepSubject = (step: Pick<TableItem, "id" | "text">): string => checkpointSubject([{ ...step, by: "", done: true }], "", []);

export const stepOf = (state: RoomState, id: string): TableItem => {
  const step = state.table.next.find((entry) => entry.id === id);
  if (!step) throw new StepCommitError(`no step ${id} on the table`, 404);
  if (step.withdrawn) throw new StepCommitError(`${id} was withdrawn`);
  return step;
};

/**
 * The turns that built a step. Its builder's (see stepBuilder) that changed files after it was put on the table, up to
 * the last time its check was asked for (with none asked for, up to it being marked done; with neither, up to now),
 * and those where the builder named it (asked for its check, marked it done). Closed by the human with no builder on
 * record, any agent's in that span: the one that put it on the table is often not the one who built it. Open with
 * none on record, nobody has said it is being built: none. A turn that named another step and not this one was on
 * that one. The turn that put it on the table was planning
 * (it often puts several there at once) — unless the step is done and no later turn is its: then it built the step
 * too. A checker's turns, even the one that passed it, were on their own work.
 */
export const stepTurns = (state: RoomState, events: readonly RoomEvent[], step: Pick<TableItem, "id" | "seq" | "review" | "doneBy" | "done">): TurnState[] => {
  const builder = stepBuilder(step, state.human);
  if (builder === undefined && !step.done) return [];
  const theirs = (agent: string) => builder === undefined || agent === builder;
  const named = new Set<string>();
  const elsewhere = new Set<string>();
  let review: number | undefined;
  let done: number | undefined;
  let putIn: string | undefined;
  for (const event of events) {
    if (event.type !== "table.op") continue;
    const { op } = event;
    if (op.op === "next" && op.id === step.id) putIn = op.turnId;
    if (op.op !== "review" && op.op !== "done") continue;
    if (op.target !== step.id) {
      if (op.turnId) elsewhere.add(op.turnId);
      continue;
    }
    if (op.turnId && theirs(op.by)) named.add(op.turnId);
    if (op.op === "review") review = event.seq;
    if (op.op === "done") done = event.seq;
  }
  const until = review ?? done ?? Number.POSITIVE_INFINITY;
  const built = state.turns.filter(
    (turn) => turn.files?.length && theirs(turn.agent) && (named.has(turn.id) || (turn.seq > step.seq && turn.seq <= until && !elsewhere.has(turn.id))),
  );
  if (built.length || !step.done) return built;
  return state.turns.filter((turn) => turn.id === putIn && turn.files?.length && theirs(turn.agent));
};

/**
 * What committing a step would take: its subject, and every file git sees uncommitted in the folder, each with
 * the room's turns that changed it. Those the step's own turns changed are the step's; the rest are listed too,
 * for the human to add.
 */
export const planStepCommit = (state: RoomState, events: readonly RoomEvent[], id: string): StepCommitPlan => {
  const step = stepOf(state, id);
  const paths = uncommittedFiles(state.workspace);
  if (!paths) throw new StepCommitError("the folder is not a git repository of its own: there is nothing to commit to", 409);
  const operation = gitOperation(state.workspace);
  if (operation) throw new StepCommitError(`the repository is in the middle of ${operation}: finish it or abort it first`, 409);
  const own = new Set(stepTurns(state, events, step).flatMap((turn) => turn.files ?? []));
  const files = paths.map((path) => ({
    path,
    turns: state.turns.filter((turn) => turn.files?.includes(path)).map((turn) => ({ id: turn.id, agent: turn.agent })),
    step: own.has(path),
  }));
  return { step: step.id, subject: stepSubject(step), files };
};
