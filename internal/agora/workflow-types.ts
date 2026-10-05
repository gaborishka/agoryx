import type { AgentKind } from "./types.js";

export type WorkflowMode = "verification" | "council" | "tournament" | "debate";
export type WorkflowStatus = "running" | "waiting_user" | "completed" | "failed" | "cancelled";
export type WorkflowRole = "author" | "reviewer" | "member" | "contender" | "evaluator" | "pro" | "con" | "judge";

/** Filled from the room roster by the server; clients only choose IDs and roles. */
export interface WorkflowParticipant {
  id: string;
  kind: AgentKind;
  label: string;
  model?: string;
  effort?: string;
  role?: WorkflowRole;
}

export interface WorkflowBudget {
  /** Same enforced wall-clock deadline for every participant's submission. */
  timeoutMs: number;
  /** Same enforced returned-text limit; not a claim of equal token or monetary cost. */
  maxOutputChars: number;
  /** Maximum repair attempts after the initial artifact or steelman, before reporting unresolved work. */
  maxRounds: number;
}

export interface WorkflowStartInput {
  mode: WorkflowMode;
  task: string;
  criteria: string[];
  participants: WorkflowParticipant[];
  budget?: Partial<WorkflowBudget>;
  /** Explicitly selected immutable text snapshots; never arbitrary worker filesystem access. */
  context?: Array<{ path: string; text: string }>;
}

export interface WorkflowEntry {
  id: string;
  participantId: string;
  label: string;
  status: "pending" | "running" | "complete" | "failed";
  /** Present only after all submissions in this round have been validated and revealed. */
  text?: string;
}

export interface WorkflowRound {
  id: string;
  phase: string;
  status: "running" | "revealed" | "failed";
  blind: boolean;
  startedAt?: string;
  entries: WorkflowEntry[];
  /** Persisted anonymous identities, independent of user-controlled participant labels. */
  aliases?: Record<string, string>;
}

export interface WorkflowCheck {
  criterion: string;
  status: "passed" | "failed" | "unknown";
  evidence: string;
}

export interface WorkflowReport {
  summary: string;
  checks: WorkflowCheck[];
  unknowns: string[];
}

export interface WorkflowRun {
  id: string;
  roomId: string;
  mode: WorkflowMode;
  status: WorkflowStatus;
  phase: string;
  task: string;
  criteria: string[];
  participants: WorkflowParticipant[];
  budget: WorkflowBudget;
  context?: Array<{ path: string; text: string }>;
  rounds: WorkflowRound[];
  createdAt: string;
  updatedAt: string;
  selection?: { entryIds: string[]; instruction?: string };
  report?: WorkflowReport;
  /** The human's final decision is preserved alongside the judge's original verdict. */
  override?: string;
  error?: string;
}

export interface WorkflowSummary extends Pick<WorkflowRun, "id" | "mode" | "status" | "phase" | "updatedAt"> {
  working: Array<{ agent: string; since: string }>;
}

export type WorkflowAction =
  | { type: "select"; runId: string; entryIds: string[]; instruction?: string }
  | { type: "override"; runId: string; text: string }
  | { type: "retry"; runId: string };

export interface WorkflowExecutionInput {
  roomId: string;
  runId: string;
  phase: string;
  participant: WorkflowParticipant;
  prompt: string;
  budget: WorkflowBudget;
  signal: AbortSignal;
}

/** A fresh, isolated execution for every call; no native room session or shared workspace. */
export type WorkflowExecutor = (input: WorkflowExecutionInput) => Promise<{ text: string }>;
