import type { WorkflowRun } from "./workflow-types.js";

/** A human's cross-room navigation index. Deliberately excludes submissions, context and reports. */
export interface WorkflowIndexEntry extends Pick<
  WorkflowRun,
  | "id"
  | "roomId"
  | "mode"
  | "status"
  | "phase"
  | "task"
  | "createdAt"
  | "updatedAt"
> {
  roomName: string;
  participants: number;
  projectHash?: string;
}
export function workflowIndexEntry(
  run: WorkflowRun,
  room: { name: string; projectHash?: string },
): WorkflowIndexEntry {
  return {
    id: run.id,
    roomId: run.roomId,
    mode: run.mode,
    status: run.status,
    phase: run.phase,
    task: run.task,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    roomName: room.name,
    participants: run.participants.length,
    ...(room.projectHash ? { projectHash: room.projectHash } : {}),
  };
}
