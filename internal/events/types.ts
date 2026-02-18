export type OrchestrationMode = "manual" | "round-robin" | "auto" | "team";
export type MessageRole = "user" | "assistant" | "system";
export type MessageFormat = "markdown" | "plain";
export type TeamStrategy = "debate";
export type TeamProfile = "enthusiast" | "strict";
export type TeamRunStatus =
  | "active"
  | "waiting_user_input"
  | "done"
  | "failed"
  | "stopped";
export type TeamRunStage = "debate" | "plan" | "implement" | "checks" | "finalize";

export type ErrorClass =
  | "AUTH_ERROR"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "PROCESS_CRASH"
  | "PROTOCOL_ERROR"
  | "SESSION_EXPIRED"
  | "UNKNOWN";

export interface RoomConfig {
  mode: OrchestrationMode;
  checkpointThreshold: number;
  maxHistoryMessages: number;
  maxContextTokens: number;
}

export interface Room {
  id: string;
  name: string;
  participants: string[];
  config: RoomConfig;
  createdAt: string;
}

export interface MessageMetadata {
  provider?: string;
  model?: string;
  tokenUsage?: {
    input: number;
    output: number;
  };
  latencyMs?: number;
  dispatchId?: string;
  requestId?: string;
}

export interface Message {
  id: string;
  roomId: string;
  author: string;
  role: MessageRole;
  text: string;
  format: MessageFormat;
  metadata: MessageMetadata;
  createdAt: string;
}

export interface Checkpoint {
  id: string;
  roomId: string;
  summaryText: string;
  fromMessageId: string;
  toMessageId: string;
  createdAt: string;
}

export interface PinnedContext {
  id: string;
  roomId: string;
  label: string;
  content: string;
  pinnedBy: string;
  createdAt: string;
}

export type EventType =
  | "message.started"
  | "message.delta"
  | "message.completed"
  | "message.error"
  | "session.bound"
  | "tool.call.started"
  | "tool.call.completed"
  | "agent.status"
  | "session.checkpoint";

export interface EventEnvelope<TPayload = unknown> {
  eventId: string;
  roomId: string;
  sessionId: string;
  timestamp: string;
  source: string;
  type: EventType;
  requestId: string;
  payload: TPayload;
}

export interface MessageEventPayload {
  messageId: string;
  author: string;
  role: MessageRole;
  text: string;
  format: MessageFormat;
  metadata?: MessageMetadata;
}

export interface MessageErrorPayload {
  class: ErrorClass;
  message: string;
  raw?: string;
}

export interface SessionBoundPayload {
  nativeSessionId: string;
}

export interface TeamConfig {
  profile: TeamProfile;
  maxSteps: number;
  maxNoProgressSteps: number;
  maxDurationMs: number;
  checksEnabledByDefault: boolean;
  checkCommands: string[];
  strict: {
    maxSteps: number;
    maxNoProgressSteps: number;
    maxDurationMs: number;
    checksEnabledByDefault: boolean;
  };
  finalGate: "proposal";
  singleActive: boolean;
  trigger: {
    autoOnMessage: boolean;
    commandStart: boolean;
  };
}

export interface TeamRun {
  id: string;
  roomId: string;
  strategy: TeamStrategy;
  status: TeamRunStatus;
  stage: TeamRunStage;
  goal: string;
  participants: string[];
  stepCount: number;
  noProgressCount: number;
  maxSteps: number;
  maxNoProgressSteps: number;
  maxDurationMs: number;
  checksEnabled: boolean;
  createdBy: string;
  createdAt: string;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  finalSummary: string | null;
}

export interface TeamStep {
  id: string;
  runId: string;
  seq: number;
  stage: TeamRunStage;
  actor: string;
  dispatchId: string;
  requestId: string;
  inputText: string;
  outputText: string;
  result: "ok" | "error" | "stopped";
  errorClass: ErrorClass | null;
  createdAt: string;
}

export interface TeamFeedback {
  id: string;
  runId: string;
  messageId: string;
  feedbackText: string;
  status: "pending" | "consumed";
  createdAt: string;
  consumedAt: string | null;
}

export interface TeamCheck {
  id: string;
  runId: string;
  stepId: string | null;
  command: string;
  status: "passed" | "failed" | "timeout" | "skipped";
  exitCode: number | null;
  stdoutText: string;
  stderrText: string;
  durationMs: number;
  createdAt: string;
}
