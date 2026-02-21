import type {
  Adapter,
  AdapterEvent,
  AdapterConfig,
  PersistentAdapter,
} from "../adapters/adapter.js";
import type { ChatRuntimeConfig } from "../config/default.js";
import type {
  Message,
  SessionBoundPayload,
  TeamStep,
} from "../events/types.js";
import type { MemoryService } from "../memory/service.js";
import type { Dispatch } from "../orchestrator/policy.js";
import { createId } from "../session/ids.js";
import { SessionService } from "../session/service.js";
import type { EngineLogger } from "./logger.js";
import type {
  DispatchResult,
  EngineState,
  RetryResult,
  TeamDispatchApi,
} from "./types.js";

interface DispatchEngineOptions {
  session: SessionService;
  adapters: Record<string, Adapter>;
  config: ChatRuntimeConfig;
  getState: () => EngineState;
  onAdapterEvent?: (adapterName: string, event: AdapterEvent) => void;
  logger: EngineLogger;
  memoryService?: MemoryService;
}

export class DispatchEngine implements TeamDispatchApi {
  private readonly session: SessionService;
  private readonly adapters: Record<string, Adapter>;
  private readonly config: ChatRuntimeConfig;
  private readonly getState: () => EngineState;
  private readonly onAdapterEvent?: (
    adapterName: string,
    event: AdapterEvent,
  ) => void;
  private readonly logger: EngineLogger;
  private readonly memoryService?: MemoryService;

  public constructor(options: DispatchEngineOptions) {
    this.session = options.session;
    this.adapters = options.adapters;
    this.config = options.config;
    this.getState = options.getState;
    this.onAdapterEvent = options.onAdapterEvent;
    this.logger = options.logger;
    this.memoryService = options.memoryService;
  }

  public getLastFailedRequest(adapter: string): string | null {
    const state = this.getState();
    return this.session.getLastFailedRequest(state.room.id, adapter);
  }

  public createInternalDispatch(targetAdapter: string, reason: string): Dispatch {
    return {
      dispatchId: createId("dsp"),
      requestId: createId("req"),
      targetAdapter,
      priority: 0,
      reason,
    };
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
      try {
        await adapter.cancel(failedRequestId);
      } catch (error: unknown) {
        this.logger.log("warn", "retry.cancel_failed", {
          adapter: normalizedAdapter,
          failedRequestId,
          error: error instanceof Error ? error.message : String(error),
        });
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

  public async runPromptDispatch(
    dispatch: Dispatch,
    prompt: string,
    isSessionRetry = false,
    options?: {
      outputTransform?: (text: string) => string;
    },
  ): Promise<DispatchResult> {
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

    this.memoryService?.recordDispatchStart(state.room.id, dispatch.targetAdapter, dispatch.requestId);

    const adapterConfig = withTeamSystemPrompt(
      this.resolveAdapterConfig(dispatch.targetAdapter),
    );
    const persistentLikeMode =
      (adapterConfig.mode === "persistent" || adapterConfig.mode === "agentic") &&
      "sendTurn" in adapter;

    let result: DispatchResult;
    if (persistentLikeMode) {
      result = await this.session.acquireTurnLock(
        state.room.id,
        dispatch.targetAdapter,
        () =>
          this.runPersistentDispatch(
            dispatch,
            adapter as PersistentAdapter,
            adapterConfig,
            isSessionRetry,
            {
              promptOverride: prompt,
              trackCursor: false,
              outputTransform: options?.outputTransform,
            },
          ),
      );
    } else {
      const syntheticMessage: Message = {
        id: createId("msg"),
        roomId: state.room.id,
        author: "team.system",
        role: "user",
        text: prompt,
        format: "plain",
        metadata: {},
        createdAt: new Date().toISOString(),
      };

      result = await this.runLegacyDispatch(dispatch, adapter, adapterConfig, [syntheticMessage], {
        outputTransform: options?.outputTransform,
      });
    }

    if (result.success) {
      this.memoryService?.recordDispatchEnd(state.room.id, dispatch.targetAdapter, "done", []);
    } else {
      this.memoryService?.recordError(state.room.id, dispatch.targetAdapter, result.error ?? "unknown error");
    }

    return result;
  }

  public async runDispatch(
    dispatch: Dispatch,
    isSessionRetry = false,
  ): Promise<DispatchResult> {
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

    this.logger.log("debug", "dispatch.start", {
      roomId: state.room.id,
      adapter: dispatch.targetAdapter,
      requestId: dispatch.requestId,
      dispatchId: dispatch.dispatchId,
      reason: dispatch.reason,
    });

    this.memoryService?.recordDispatchStart(state.room.id, dispatch.targetAdapter, dispatch.requestId);

    const adapterConfig = this.resolveAdapterConfig(dispatch.targetAdapter);
    const isPersistent =
      (adapterConfig.mode === "persistent" || adapterConfig.mode === "agentic") &&
      "sendTurn" in adapter;

    let result: DispatchResult;
    if (isPersistent) {
      result = await this.session.acquireTurnLock(
        state.room.id,
        dispatch.targetAdapter,
        () =>
          this.runPersistentDispatch(
            dispatch,
            adapter as PersistentAdapter,
            adapterConfig,
            isSessionRetry,
          ),
      );
    } else {
      result = await this.runLegacyDispatch(dispatch, adapter, adapterConfig);
    }

    if (result.success) {
      this.memoryService?.recordDispatchEnd(state.room.id, dispatch.targetAdapter, "done", []);
    } else {
      this.memoryService?.recordError(state.room.id, dispatch.targetAdapter, result.error ?? "unknown error");
    }

    return result;
  }

  private async runLegacyDispatch(
    dispatch: Dispatch,
    adapter: Adapter,
    adapterConfig: AdapterConfig,
    messagesOverride?: Message[],
    options?: {
      outputTransform?: (text: string) => string;
    },
  ): Promise<DispatchResult> {
    const state = this.getState();
    const messages =
      messagesOverride ??
      this.session.buildContextMessages(
        state.room,
        adapterConfig.systemPrompt,
        dispatch.targetAdapter,
      );
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
      this.onAdapterEvent?.(dispatch.targetAdapter, event);

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
      this.logger.log("warn", "dispatch.failed", {
        roomId: state.room.id,
        adapter: dispatch.targetAdapter,
        requestId: dispatch.requestId,
        errorClass: failed.errorClass,
        error: failed.message,
      });
      return {
        adapter: dispatch.targetAdapter,
        requestId: dispatch.requestId,
        success: false,
        text: applyOutputTransform(finalText, options?.outputTransform),
        error: `${failed.errorClass}: ${failed.message}`,
      };
    }

    const resolvedText = applyOutputTransform(
      finalText.trim() || "(empty response)",
      options?.outputTransform,
    );

    const { provider, model } = resolveAdapterProviderInfo(dispatch.targetAdapter);
    this.session.saveAssistantMessage(
      state.room.id,
      `agent.${dispatch.targetAdapter}`,
      resolvedText,
      dispatch.requestId,
      dispatch.dispatchId,
      provider,
      model,
    );

    this.logger.log("info", "dispatch.completed", {
      roomId: state.room.id,
      adapter: dispatch.targetAdapter,
      requestId: dispatch.requestId,
      textLength: resolvedText.length,
    });

    return {
      adapter: dispatch.targetAdapter,
      requestId: dispatch.requestId,
      success: true,
      text: resolvedText,
    };
  }

  private async runPersistentDispatch(
    dispatch: Dispatch,
    adapter: PersistentAdapter,
    adapterConfig: AdapterConfig,
    isSessionRetry: boolean,
    options?: {
      promptOverride?: string;
      trackCursor?: boolean;
      outputTransform?: (text: string) => string;
    },
  ): Promise<DispatchResult> {
    const state = this.getState();
    const agentSession = this.session.getOrCreateAgentSession(
      state.room.id,
      dispatch.targetAdapter,
    );
    const promptResult = options?.promptOverride
      ? { prompt: options.promptOverride, cutoffSeq: null as number | null }
      : this.session.buildDeltaPrompt(
          state.room,
          dispatch.targetAdapter,
          agentSession.lastSeenSeq,
          adapterConfig.systemPrompt,
        );
    const { prompt, cutoffSeq } = promptResult;
    const turnPrompt = withPersistentSystemPrompt(prompt, adapterConfig.systemPrompt);

    let finalText = "";
    let failed: { errorClass: string; message: string } | undefined;
    let boundNativeId: string | null = null;

    for await (const event of adapter.sendTurn({
      roomId: state.room.id,
      sessionId: state.sessionId,
      requestId: dispatch.requestId,
      nativeSessionId: agentSession.nativeSessionId,
      prompt: turnPrompt,
      config: adapterConfig,
    })) {
      this.session.appendEvent(event);
      this.onAdapterEvent?.(dispatch.targetAdapter, event);

      if (event.type === "session.bound") {
        const payload = event.payload as SessionBoundPayload;
        if (typeof payload.nativeSessionId === "string" && payload.nativeSessionId) {
          boundNativeId = payload.nativeSessionId;
        }
      }

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

    if (failed?.errorClass === "SESSION_EXPIRED" && !isSessionRetry) {
      this.session.updateAgentSessionStatus(agentSession.id, "expired");
      const retryDispatch: Dispatch = {
        ...dispatch,
        dispatchId: createId("dsp"),
        requestId: createId("req"),
      };
      return this.runPersistentDispatch(retryDispatch, adapter, adapterConfig, true, options);
    }

    if (failed) {
      if (failed.errorClass !== "SESSION_EXPIRED") {
        this.session.incrementAgentSessionFailCount(agentSession.id);
      }
      this.logger.log("warn", "dispatch.persistent_failed", {
        roomId: state.room.id,
        adapter: dispatch.targetAdapter,
        requestId: dispatch.requestId,
        errorClass: failed.errorClass,
        error: failed.message,
      });
      return {
        adapter: dispatch.targetAdapter,
        requestId: dispatch.requestId,
        success: false,
        text: applyOutputTransform(finalText, options?.outputTransform),
        error: `${failed.errorClass}: ${failed.message}`,
      };
    }

    if (!agentSession.nativeSessionId && !boundNativeId) {
      this.session.updateAgentSessionStatus(agentSession.id, "failed");
      this.logger.log("error", "dispatch.no_native_session", {
        roomId: state.room.id,
        adapter: dispatch.targetAdapter,
        requestId: dispatch.requestId,
      });
      return {
        adapter: dispatch.targetAdapter,
        requestId: dispatch.requestId,
        success: false,
        text: applyOutputTransform(finalText, options?.outputTransform),
        error: "FATAL: no native session ID received on cold start",
      };
    }

    if (boundNativeId) {
      this.session.updateAgentSessionNativeId(agentSession.id, boundNativeId);
    }
    if ((options?.trackCursor ?? true) && cutoffSeq !== null) {
      this.session.updateAgentSessionCursor(agentSession.id, cutoffSeq);
    }

    const resolvedText = applyOutputTransform(
      finalText.trim() || "(empty response)",
      options?.outputTransform,
    );

    const { provider, model } = resolveAdapterProviderInfo(dispatch.targetAdapter);
    this.session.saveAssistantMessage(
      state.room.id,
      `agent.${dispatch.targetAdapter}`,
      resolvedText,
      dispatch.requestId,
      dispatch.dispatchId,
      provider,
      model,
    );

    this.logger.log("info", "dispatch.persistent_completed", {
      roomId: state.room.id,
      adapter: dispatch.targetAdapter,
      requestId: dispatch.requestId,
      nativeSessionId: boundNativeId ?? agentSession.nativeSessionId,
      textLength: resolvedText.length,
    });

    return {
      adapter: dispatch.targetAdapter,
      requestId: dispatch.requestId,
      success: true,
      text: resolvedText,
    };
  }

  private resolveAdapterConfig(adapterName: string): AdapterConfig {
    const config = this.config.adapterConfig[adapterName];
    if (config) {
      return config;
    }
    this.logger.log("warn", "dispatch.missing_adapter_config", {
      adapter: adapterName,
      fallback: "stub",
    });
    return {
      mode: "stub",
      timeoutMs: 120_000,
      maxTokens: 4_000,
    };
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
  "SESSION_EXPIRED",
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

const ADAPTER_PROVIDER_MAP: Record<string, { provider: string; model: string }> = {
  codex: { provider: "openai", model: "codex" },
  claude: { provider: "anthropic", model: "claude-code" },
};

const resolveAdapterProviderInfo = (
  adapterName: string,
): { provider: string; model: string } =>
  ADAPTER_PROVIDER_MAP[adapterName] ?? { provider: adapterName, model: adapterName };

export const normalizeErrorClass = (error?: string): TeamStep["errorClass"] => {
  if (!error) {
    return null;
  }
  const prefix = error.split(":")[0]?.trim();
  if (!prefix) {
    return "UNKNOWN";
  }
  return (ERROR_CLASSES as readonly string[]).includes(prefix)
    ? (prefix as TeamStep["errorClass"])
    : "UNKNOWN";
};

const TEAM_DIALOGUE_SYSTEM_PROMPT = [
  "You are in an autonomous multi-agent room in Agoryx.",
  "Return only the final message intended for the shared room.",
  "Do not narrate your internal process, bootstrap steps, or tool execution.",
  "Do not dump raw files, line-number listings, or system reminder blocks.",
  "If you inspect files/tools, do it silently and report concise conclusions only.",
].join(" ");

const withTeamSystemPrompt = (config: AdapterConfig): AdapterConfig => ({
  ...config,
  systemPrompt: config.systemPrompt
    ? `${config.systemPrompt}\n\n${TEAM_DIALOGUE_SYSTEM_PROMPT}`
    : TEAM_DIALOGUE_SYSTEM_PROMPT,
});

const applyOutputTransform = (
  text: string,
  transform?: (text: string) => string,
): string => (transform ? transform(text) : text);

const withPersistentSystemPrompt = (
  prompt: string,
  systemPrompt?: string,
): string => {
  const trimmedSystem = systemPrompt?.trim();
  if (!trimmedSystem) {
    return prompt;
  }

  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) {
    return `[System]\n${trimmedSystem}`;
  }

  return `[System]\n${trimmedSystem}\n\n[Task]\n${prompt}`;
};
