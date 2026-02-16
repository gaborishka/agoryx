import type {
  ErrorClass,
  EventEnvelope,
  Message,
  MessageEventPayload,
  MessageErrorPayload,
} from "../events/types.js";

export type AdapterStatus = "ready" | "busy" | "error" | "not_authenticated";
export type AdapterMode = "stub" | "cli";

export interface AdapterConfig {
  mode: AdapterMode;
  timeoutMs: number;
  maxTokens: number;
  systemPrompt?: string;
}

export interface AgentInput {
  roomId: string;
  sessionId: string;
  requestId: string;
  messages: Message[];
  config: AdapterConfig;
}

export interface Adapter {
  name: string;
  send(input: AgentInput): AsyncGenerator<AdapterEvent>;
  cancel(requestId: string): Promise<void>;
  health(): Promise<AdapterStatus>;
}

export type AdapterEvent =
  | EventEnvelope<MessageEventPayload>
  | EventEnvelope<MessageErrorPayload>;

export interface AdapterError {
  class: ErrorClass;
  message: string;
  raw?: string;
}
