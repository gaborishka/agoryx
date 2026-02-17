import type { Adapter, AdapterConfig, AdapterEvent } from "../adapters/adapter.js";
import type { ChatRuntimeConfig } from "../config/default.js";
import type { Message, OrchestrationMode, PinnedContext, Room } from "../events/types.js";
import { createPolicy } from "../orchestrator/factory.js";
import type { Dispatch, OrchestrationPolicy } from "../orchestrator/policy.js";
import { createId } from "../session/ids.js";
import { SessionService } from "../session/service.js";

export interface ChatEngineHooks {
  onAdapterEvent?: (adapterName: string, event: AdapterEvent) => void;
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

interface EngineState {
  room: Room;
  sessionId: string;
  policy: OrchestrationPolicy;
  availableAgents: string[];
}

export class ChatEngine {
  private state: EngineState | null = null;

  public constructor(
    private readonly session: SessionService,
    private readonly adapters: Record<string, Adapter>,
    private readonly config: ChatRuntimeConfig,
    private readonly hooks: ChatEngineHooks = {},
  ) {}

  public init(): { room: Room; sessionId: string; mode: OrchestrationMode } {
    const enabledAgents = this.config.agents.filter((agent) => Boolean(this.adapters[agent]));
    if (enabledAgents.length === 0) {
      throw new Error("No valid adapters were selected.");
    }

    const created = this.config.resumeRoomId
      ? this.session.resumeSession(this.config.resumeRoomId)
      : this.session.createSession({
          roomName: this.config.roomName,
          participants: ["user", ...enabledAgents.map((agent) => `agent.${agent}`)],
          roomConfig: this.config.roomConfig,
        });

    if (!created) {
      throw new Error(`Room ${this.config.resumeRoomId} was not found.`);
    }

    const policy = createPolicy(created.room.config.mode, {
      agentSkills: this.config.agentSkills,
    });
    this.state = {
      room: created.room,
      sessionId: created.sessionId,
      policy,
      availableAgents: enabledAgents,
    };

    return {
      room: this.state.room,
      sessionId: this.state.sessionId,
      mode: this.state.room.config.mode,
    };
  }

  public getState(): EngineState {
    if (!this.state) {
      throw new Error("Engine is not initialized.");
    }
    return this.state;
  }

  public setMode(mode: OrchestrationMode): OrchestrationMode {
    const current = this.getState();
    current.room = this.session.updateRoomMode(current.room, mode);
    current.policy = createPolicy(mode, {
      agentSkills: this.config.agentSkills,
    });
    this.state = current;
    return mode;
  }

  public async adapterStatus(): Promise<Record<string, string>> {
    const statuses = await Promise.all(
      this.getState().availableAgents.map(async (agent) => [
        agent,
        await this.adapters[agent].health(),
      ]),
    );
    return Object.fromEntries(statuses);
  }

  public listMessages(limit = 50): Message[] {
    return this.session.listMessages(this.getState().room.id, limit);
  }

  public addPinnedContext(label: string, content: string): string {
    return this.session.addPinnedContext(this.getState().room.id, label, content);
  }

  public removePinnedContext(pinId: string): boolean {
    return this.session.removePinnedContext(this.getState().room.id, pinId);
  }

  public listPinnedContext(): PinnedContext[] {
    return this.session.listPinnedContext(this.getState().room.id);
  }

  public checkpointNow(): string | null {
    const state = this.getState();
    return this.session.maybeCreateCheckpoint(state.room, true);
  }

  public getLastFailedRequest(adapter: string): string | null {
    const state = this.getState();
    return this.session.getLastFailedRequest(state.room.id, adapter);
  }

  public async processUserMessage(text: string): Promise<DispatchResult[]> {
    const state = this.getState();
    const userMessage = this.session.saveUserMessage(state.room.id, text);
    const dispatches = state.policy
      .onUserMessage(state.room, userMessage, {
        availableAgents: state.availableAgents,
      })
      .sort((left, right) => left.priority - right.priority);

    const results: DispatchResult[] = [];
    for (const dispatch of dispatches) {
      results.push(await this.runDispatch(dispatch));
    }

    // Opportunistic checkpoints keep context bounded.
    this.session.maybeCreateCheckpoint(state.room);
    return results;
  }

  public async retryFailed(adapterName: string): Promise<RetryResult | null> {
    const normalizedAdapter = normalizeAdapterName(adapterName);
    if (!normalizedAdapter) {
      return null;
    }

    const failedRequestId = this.getLastFailedRequest(normalizedAdapter);
    if (!failedRequestId) {
      return null;
    }

    const adapter = this.adapters[normalizedAdapter];
    if (adapter) {
      // Best-effort cleanup: timeouts/process crashes may leave a stale subprocess.
      try {
        await adapter.cancel(failedRequestId);
      } catch {
        // Ignore cleanup errors and continue with retry dispatch.
      }
    }

    const dispatch: Dispatch = {
      dispatchId: createId("dsp"),
      requestId: createId("req"),
      targetAdapter: normalizedAdapter,
      priority: 0,
      reason: `retry:${failedRequestId}`,
    };
    const result = await this.runDispatch(dispatch);

    return {
      ...result,
      failedRequestId,
    };
  }

  private async runDispatch(dispatch: Dispatch): Promise<DispatchResult> {
    const state = this.getState();
    const adapter = this.adapters[dispatch.targetAdapter];
    if (!adapter) {
      return {
        adapter: dispatch.targetAdapter,
        requestId: dispatch.requestId,
        success: false,
        text: "",
        error: `Adapter ${dispatch.targetAdapter} is not available.`,
      };
    }

    const adapterConfig = this.resolveAdapterConfig(dispatch.targetAdapter);
    const messages = this.session.buildContextMessages(state.room, adapterConfig.systemPrompt);
    let finalText = "";
    let failed: { errorClass: string; message: string } | undefined;

    for await (const event of adapter.send({
      roomId: state.room.id,
      sessionId: state.sessionId,
      requestId: dispatch.requestId,
      messages,
      config: adapterConfig,
    })) {
      this.session.appendEvent(event);
      this.hooks.onAdapterEvent?.(dispatch.targetAdapter, event);

      if (event.type === "message.delta") {
        const payloadText = extractPayloadText(event.payload);
        if (payloadText) {
          finalText += payloadText;
        }
      }

      if (event.type === "message.completed") {
        const payloadText = extractPayloadText(event.payload);
        finalText = payloadText || finalText;
      }

      if (event.type === "message.error") {
        failed = extractErrorInfo(event.payload);
      }
    }

    if (failed) {
      return {
        adapter: dispatch.targetAdapter,
        requestId: dispatch.requestId,
        success: false,
        text: finalText,
        error: `${failed.errorClass}: ${failed.message}`,
      };
    }

    const provider = dispatch.targetAdapter === "codex" ? "openai" : "anthropic";
    const model = dispatch.targetAdapter === "codex" ? "codex" : "claude-code";
    this.session.saveAssistantMessage(
      state.room.id,
      `agent.${dispatch.targetAdapter}`,
      finalText.trim() || "(empty response)",
      dispatch.requestId,
      dispatch.dispatchId,
      provider,
      model,
    );

    return {
      adapter: dispatch.targetAdapter,
      requestId: dispatch.requestId,
      success: true,
      text: finalText.trim() || "(empty response)",
    };
  }

  private resolveAdapterConfig(adapterName: string): AdapterConfig {
    const fallback = {
      mode: "stub",
      timeoutMs: 120_000,
      maxTokens: 4_000,
    } satisfies AdapterConfig;

    return this.config.adapterConfig[adapterName] ?? fallback;
  }
}

const extractPayloadText = (payload: unknown): string => {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const text = (payload as { text?: string }).text;
  return typeof text === "string" ? text : "";
};

const ERROR_CLASSES = [
  "AUTH_ERROR",
  "RATE_LIMIT",
  "TIMEOUT",
  "PROCESS_CRASH",
  "PROTOCOL_ERROR",
  "UNKNOWN",
] as const;

const extractErrorInfo = (payload: unknown): { errorClass: string; message: string } => {
  const fallback = {
    errorClass: "UNKNOWN",
    message: "Unknown adapter error",
  };

  if (!payload || typeof payload !== "object") {
    return fallback;
  }

  const errorClass = (payload as { class?: string }).class;
  const normalizedClass =
    typeof errorClass === "string" &&
    (ERROR_CLASSES as readonly string[]).includes(errorClass)
      ? errorClass
      : "UNKNOWN";

  const message = (payload as { message?: string }).message;
  return {
    errorClass: normalizedClass,
    message: typeof message === "string" ? message : fallback.message,
  };
};

const normalizeAdapterName = (value: string): string =>
  value.trim().toLowerCase();
