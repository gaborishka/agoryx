import type { FileChange, RevertEntry, RoomState } from "./types.js";
import { changedSince, revertPreview } from "./workspace.js";

/**
 * Returning the room's folder to a checkpoint (T3's rewind): the human's action, never an agent's. Only
 * files move; the conversation and the table stay as they are, since they record what was said, and what
 * was said still happened. The engine does it (RoomEngine.revertWorkspace); this is what it and the
 * daemon's preview share: which commit a request means, and what returning to it would change.
 */

export type RevertCode = "bad" | "agent" | "missing" | "undone" | "later" | "busy" | "changed" | "same" | "failed";

const STATUS: Record<RevertCode, number> = { bad: 400, agent: 403, missing: 404, undone: 409, later: 409, busy: 409, changed: 409, same: 409, failed: 500 };

/** Why a return cannot be made; `code` lets a client say it in its own words. */
export class RevertError extends Error {
  readonly status: number;
  constructor(readonly code: RevertCode, message: string) {
    super(message);
    this.name = "RevertError";
    this.status = STATUS[code];
  }
}

/** A checkpoint of this room (a sha, 7 hex characters or more), or the undo of one of its returns (that return's seq). */
export type RevertRequest = { sha: string; undoOf?: undefined } | { undoOf: number; sha?: undefined };

/** A return lists at most this many files in its event; `total` keeps the count. */
export const MAX_REVERT_CHANGES = 500;

export interface RevertTarget {
  /** The checkpoint (or, for an undo, the undo point) the request names. */
  sha: string;
  /** The commit whose files the folder gets: the whole folder at the checkpoint, when the checkpoint's commit holds only part of it. */
  source: string;
  checkpoint?: RoomState["commits"][number];
  undoOf?: RevertEntry;
}

/**
 * The return an undo would reverse now: the room's own latest one, if it is not itself an undo and is not
 * undone yet. Only the latest: undoing an older one would also throw away every return after it.
 */
export const undoableRevert = (state: RoomState): RevertEntry | undefined => {
  const last = state.reverts.filter((entry) => !entry.fromRoom).at(-1);
  return last && last.undoOf === undefined && last.undone === undefined ? last : undefined;
};

export const revertTarget = (state: RoomState, request: RevertRequest): RevertTarget => {
  if (request.undoOf !== undefined) {
    const entry = state.reverts.find((revert) => !revert.fromRoom && revert.seq === request.undoOf);
    if (!entry) throw new RevertError("missing", `no return #${request.undoOf} in this room`);
    if (entry.undoOf !== undefined) throw new RevertError("bad", "this is an undo; to change the folder again, return it to a checkpoint");
    if (entry.undone !== undefined) throw new RevertError("undone", "this return is already undone");
    if (undoableRevert(state) !== entry) throw new RevertError("later", "only the latest return can be undone");
    return { sha: entry.undo, source: entry.undo, undoOf: entry };
  }
  const sha = (request.sha ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new RevertError("bad", "a checkpoint sha is required (7 to 40 hex characters)");
  const matches = state.commits.filter((commit) => commit.sha.startsWith(sha));
  if (matches.length > 1) throw new RevertError("bad", `${sha} matches several checkpoints; give more of the sha`);
  if (!matches.length) throw new RevertError("missing", `no checkpoint ${sha} in this room`);
  return { sha: matches[0]!.sha, source: matches[0]!.folder ?? matches[0]!.sha, checkpoint: matches[0]! };
};

/** What a failed preview or return means, said for the CLI (the UI says it in its own words by `code`). */
export const REVERT_FAILURE: Record<"missing" | "changed" | "same" | "failed", string> = {
  missing: "the folder's repository no longer has this checkpoint",
  changed: "the folder changed since you looked; look at the files again",
  same: "the folder already matches this checkpoint",
  failed: "git could not read or write the folder, so nothing was changed",
};

export interface RevertPlan {
  to: string;
  undoOf?: number;
  /** The checkpoint's subject, or what an undo brings back. */
  subject: string;
  /** The folder now, as the preview saw it: a return given it refuses once the folder has moved on. */
  tree: string;
  /** From the files now to the target's: A comes back, D goes away, M is rewritten. */
  changes: FileChange[];
  /** For an undo: files that changed after the return (by agents or anyone); the undo takes those changes back too. */
  since?: string[];
}

/** What returning to `request` would change now, without changing anything. */
export const planRevert = (state: RoomState, request: RevertRequest): RevertPlan => {
  const target = revertTarget(state, request);
  const preview = revertPreview(state.workspace, target.source);
  if ("error" in preview) throw new RevertError(preview.error, REVERT_FAILURE[preview.error]);
  const after = target.undoOf?.after;
  const since = after ? changedSince(state.workspace, after) : null;
  return {
    to: target.sha,
    ...(target.undoOf ? { undoOf: target.undoOf.seq } : {}),
    subject: target.checkpoint?.subject ?? `the folder as it was before return #${target.undoOf!.seq}`,
    tree: preview.tree,
    changes: preview.changes,
    ...(since?.length ? { since } : {}),
  };
};

/** A room's return, said in one line (the CLI, and the agents' next delta, say it like this). */
export const describeRevert = (
  entry: Pick<RevertEntry, "to" | "undoOf" | "total" | "by" | "fromRoom">,
  name: (handle: string) => string = (handle) => handle,
): string => {
  const files = `${entry.total} file${entry.total === 1 ? "" : "s"}`;
  const where = entry.fromRoom ? ` from room "${entry.fromRoom.name}"` : "";
  return entry.undoOf !== undefined
    ? `${name(entry.by)} undid a return of the folder${where} · ${files} back as they were before it`
    : `${name(entry.by)} returned the folder to checkpoint ${entry.to.slice(0, 8)}${where} · ${files}`;
};
