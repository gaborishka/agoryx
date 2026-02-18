import type {
  ErrorClass,
  EventEnvelope,
  Message,
  MessageEventPayload,
  MessageErrorPayload,
  SessionBoundPayload,
} from "../events/types.js";

export type AdapterStatus = "ready" | "busy" | "error" | "not_authenticated";
export type AdapterMode = "stub" | "cli" | "persistent" | "agentic";

export interface AdapterConfig {
  mode: AdapterMode;
  timeoutMs: number;
  maxTokens: number;
  systemPrompt?: string;
  workspaceCwd?: string;
}

export interface AgentInput {
  roomId: string;
  sessionId: string;
  requestId: string;
  messages: Message[];
  config: AdapterConfig;
}

export interface SendTurnInput {
  roomId: string;
  sessionId: string;
  requestId: string;
  nativeSessionId: string | null;
  prompt: string;
  config: AdapterConfig;
}

export interface Adapter {
  name: string;
  send(input: AgentInput): AsyncGenerator<AdapterEvent>;
  cancel(requestId: string): Promise<void>;
  health(): Promise<AdapterStatus>;
}

export interface PersistentAdapter extends Adapter {
  sendTurn(input: SendTurnInput): AsyncGenerator<AdapterEvent>;
  destroy?(nativeSessionId: string): Promise<void>;
}

export type AdapterEvent =
  | EventEnvelope<MessageEventPayload>
  | EventEnvelope<MessageErrorPayload>
  | EventEnvelope<SessionBoundPayload>;

export interface AdapterError {
  class: ErrorClass;
  message: string;
  raw?: string;
}
