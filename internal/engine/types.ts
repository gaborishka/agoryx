import type { AdapterEvent } from "../adapters/adapter.js";
import type { TeamCheck, TeamRun, TeamStep, Message, OrchestrationMode, PinnedContext, Room } from "../events/types.js";
import type { Dispatch, OrchestrationPolicy } from "../orchestrator/policy.js";
import type { EngineLogger } from "./logger.js";

export interface ChatEngineHooks {
  onAdapterEvent?: (adapterName: string, event: AdapterEvent) => void;
  logger?: EngineLogger;
}

export interface DispatchResult {
  adapter: string;
  requestId: string;
  success: boolean;
  text: string;
  error?: string;
}

export interface RetryResult extends DispatchResult {
  failedRequestId: string;
}

export interface TeamStatusResult {
  run: TeamRun;
  pendingFeedback: number;
}

export interface TeamLogResult {
  run: TeamRun;
  steps: TeamStep[];
  checks: TeamCheck[];
}

export interface TeamInterruptResult {
  run: TeamRun;
  interrupted: boolean;
  feedbackQueued: boolean;
}

export interface EngineState {
  room: Room;
  sessionId: string;
  policy: OrchestrationPolicy;
  availableAgents: string[];
}

export interface ChatEngineFacade {
  getState(): EngineState;
  setState(next: EngineState): void;
}

export interface TeamDispatchApi {
  createInternalDispatch(targetAdapter: string, reason: string): Dispatch;
  runDispatch(
    dispatch: Dispatch,
    isSessionRetry?: boolean,
  ): Promise<DispatchResult>;
  runPromptDispatch(
    dispatch: Dispatch,
    prompt: string,
    isSessionRetry?: boolean,
    options?: {
      outputTransform?: (text: string) => string;
    },
  ): Promise<DispatchResult>;
}

export type ChatEngineReadApi = {
  listMessages(limit?: number): Message[];
  addPinnedContext(label: string, content: string): string;
  removePinnedContext(pinId: string): boolean;
  listPinnedContext(): PinnedContext[];
};

export type ModeFactory = (mode: OrchestrationMode) => OrchestrationPolicy;
