export type OrchestrationMode = "manual" | "round-robin" | "auto";
export type MessageRole = "user" | "assistant" | "system";
export type MessageFormat = "markdown" | "plain";

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
