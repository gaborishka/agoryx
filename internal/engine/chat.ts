import type {
  Adapter,
  AdapterConfig,
  AdapterEvent,
  PersistentAdapter,
} from "../adapters/adapter.js";
import type { ChatRuntimeConfig } from "../config/default.js";
import type {
  TeamCheck,
  TeamRun,
  TeamRunStage,
  TeamStep,
  Message,
  OrchestrationMode,
  PinnedContext,
  Room,
  SessionBoundPayload,
} from "../events/types.js";
import { createPolicy } from "../orchestrator/factory.js";
import type { Dispatch, OrchestrationPolicy } from "../orchestrator/policy.js";
import { TeamPolicy } from "../orchestrator/team.js";
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

interface EngineState {
  room: Room;
  sessionId: string;
  policy: OrchestrationPolicy;
  availableAgents: string[];
}

interface ActiveTeamDispatch {
  adapterName: string;
  requestId: string;
}

export class ChatEngine {
  private state: EngineState | null = null;
  private readonly teamPolicy = new TeamPolicy();
  private readonly teamLoopByRoom = new Map<string, Promise<void>>();
  private readonly teamStopFlags = new Set<string>();
  private readonly teamNextActorByRun = new Map<string, string>();
  private readonly teamActiveDispatchByRun = new Map<string, ActiveTeamDispatch>();
  private readonly interruptedRequestIds = new Set<string>();
  private teamAdapterModeSnapshot: Partial<Record<string, AdapterConfig["mode"]>> | null = null;

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

  public startTeamRun(
    goal: string,
    options: { strict?: boolean; checksEnabled?: boolean; createdBy?: string } = {},
  ): TeamRun {
    const state = this.getState();
    const trimmedGoal = goal.trim();
    if (!trimmedGoal) {
      throw new Error("Goal must not be empty.");
    }
    if (this.config.team.singleActive) {
      const active = this.session.getActiveTeamRun(state.room.id);
      if (active) {
        throw new Error(`Run already active: ${active.id}`);
      }
    }

    const strategy = "debate";
    const strictProfile = options.strict ?? this.config.team.profile === "strict";
    const limits = strictProfile
      ? this.config.team.strict
      : {
          maxSteps: this.config.team.maxSteps,
          maxNoProgressSteps: this.config.team.maxNoProgressSteps,
          maxDurationMs: this.config.team.maxDurationMs,
          checksEnabledByDefault: this.config.team.checksEnabledByDefault,
        };
    const checksEnabled = options.checksEnabled ?? limits.checksEnabledByDefault;

    this.restoreTeamAdapterModes();
    const modeSnapshot: Partial<Record<string, AdapterConfig["mode"]>> = {};
    for (const agent of state.availableAgents) {
      const adapterConfig = this.config.adapterConfig[agent];
      if (!adapterConfig || adapterConfig.mode !== "cli") {
        continue;
      }
      modeSnapshot[agent] = adapterConfig.mode;
      this.config.adapterConfig[agent] = {
        ...adapterConfig,
        mode: "agentic",
      };
    }
    if (Object.keys(modeSnapshot).length > 0) {
      this.teamAdapterModeSnapshot = modeSnapshot;
    }

    if (state.room.config.mode !== "team") {
      state.room = this.session.updateRoomMode(state.room, "team");
      state.policy = createPolicy("team", {
        agentSkills: this.config.agentSkills,
      });
      this.state = state;
    }

    const run = this.session.createTeamRun({
      roomId: state.room.id,
      strategy,
      stage: "debate",
      goal: trimmedGoal,
      participants: state.availableAgents,
      maxSteps: limits.maxSteps,
      maxNoProgressSteps: limits.maxNoProgressSteps,
      maxDurationMs: limits.maxDurationMs,
      checksEnabled,
      createdBy: options.createdBy ?? "user",
    });
    this.launchTeamLoop(run.id, run.roomId);
    return run;
  }

  public teamStatus(runId?: string): TeamStatusResult | null {
    const state = this.getState();
    const run = runId
      ? this.session.getTeamRun(runId)
      : this.session.getActiveTeamRun(state.room.id);
    if (!run) {
      return null;
    }
    return {
      run,
      pendingFeedback: this.session.countPendingTeamFeedback(run.id),
    };
  }

  public teamLog(limit = 20, runId?: string): TeamLogResult | null {
    const state = this.getState();
    const run = runId
      ? this.session.getTeamRun(runId)
      : this.session.getLatestResumableTeamRun(state.room.id);
    if (!run) {
      return null;
    }
    return {
      run,
      steps: this.session.listTeamSteps(run.id, limit),
      checks: this.session.listTeamChecks(run.id, limit),
    };
  }

  public teamResume(): TeamRun | null {
    const state = this.getState();
    const run = this.session.getLatestResumableTeamRun(state.room.id);
    if (!run) {
      return null;
    }
    if (run.status === "active") {
      this.launchTeamLoop(run.id, run.roomId);
    }
    return run;
  }

  public teamApprove(runId?: string): TeamRun | null {
    const state = this.getState();
    const run = runId
      ? this.session.getTeamRun(runId)
      : this.session.getActiveTeamRun(state.room.id);
    if (!run || run.status !== "waiting_user_input") {
      return null;
    }

    this.session.updateTeamRunStatus(run.id, "done", {
      completedAt: new Date().toISOString(),
    });
    this.restoreTeamAdapterModes();
    this.teamNextActorByRun.delete(run.id);
    return this.session.getTeamRun(run.id);
  }

  public teamStop(runId?: string): TeamRun | null {
    const state = this.getState();
    const run = runId
      ? this.session.getTeamRun(runId)
      : this.session.getActiveTeamRun(state.room.id);
    if (!run) {
      return null;
    }

    this.teamStopFlags.add(run.id);
    void this.interruptTeamRun(undefined, run.id).catch(() => {
      // Best-effort interruption; status update below is authoritative.
    });
    this.session.updateTeamRunStatus(run.id, "stopped", {
      completedAt: new Date().toISOString(),
    });
    this.restoreTeamAdapterModes();
    this.teamNextActorByRun.delete(run.id);
    return this.session.getTeamRun(run.id);
  }

  public async interruptTeamRun(
    feedbackText?: string,
    runId?: string,
  ): Promise<TeamInterruptResult | null> {
    const state = this.getState();
    const run = runId
      ? this.session.getTeamRun(runId)
      : this.session.getActiveTeamRun(state.room.id);
    if (!run || run.status !== "active") {
      return null;
    }

    const trimmedFeedback = feedbackText?.trim() ?? "";
    let feedbackQueued = false;
    if (trimmedFeedback) {
      const message = this.session.saveUserMessage(state.room.id, trimmedFeedback);
      this.session.enqueueTeamFeedback(run.id, message.id, trimmedFeedback);
      feedbackQueued = true;
    }

    const activeDispatch = this.teamActiveDispatchByRun.get(run.id);
    if (!activeDispatch) {
      return {
        run,
        interrupted: false,
        feedbackQueued,
      };
    }

    this.interruptedRequestIds.add(activeDispatch.requestId);
    const adapter = this.adapters[activeDispatch.adapterName];
    try {
      await adapter?.cancel(activeDispatch.requestId);
    } catch {
      // Best-effort cancellation only.
    }

    return {
      run,
      interrupted: true,
      feedbackQueued,
    };
  }

  public queueTeamFeedback(text: string): TeamRun | null {
    const state = this.getState();
    const run = this.session.getActiveTeamRun(state.room.id);
    if (!run || run.status !== "active") {
      return null;
    }
    const message = this.session.saveUserMessage(state.room.id, text);
    this.session.enqueueTeamFeedback(run.id, message.id, text);
    return run;
  }

  public async shutdown(): Promise<void> {
    if (!this.state) {
      return;
    }

    const activeRun = this.session.getActiveTeamRun(this.state.room.id);
    if (activeRun?.status === "active") {
      this.teamStopFlags.add(activeRun.id);
      await this.interruptTeamRun(undefined, activeRun.id);
      this.session.updateTeamRunStatus(activeRun.id, "stopped", {
        completedAt: new Date().toISOString(),
      });
      this.restoreTeamAdapterModes();
    }

    const loops = [...this.teamLoopByRoom.values()];
    if (loops.length > 0) {
      await Promise.allSettled(loops);
    }

    const agentSessions = this.session.listActiveAgentSessions(this.state.room.id);
    const destroyOps = agentSessions
      .filter((session) => Boolean(session.nativeSessionId))
      .map(async (session) => {
        const adapter = this.adapters[session.agentName];
        if (!adapter || !("destroy" in adapter)) {
          return;
        }
        const destroy = (adapter as PersistentAdapter).destroy;
        if (typeof destroy !== "function" || !session.nativeSessionId) {
          return;
        }
        await destroy.call(adapter, session.nativeSessionId);
      });
    if (destroyOps.length > 0) {
      await Promise.allSettled(destroyOps);
    }
  }

  public async processUserMessage(text: string): Promise<DispatchResult[]> {
    const state = this.getState();
    if (state.room.config.mode === "team") {
      const activeRun = this.session.getActiveTeamRun(state.room.id);
      if (activeRun?.status === "active") {
        const message = this.session.saveUserMessage(state.room.id, text);
        this.session.enqueueTeamFeedback(activeRun.id, message.id, text);
        return [];
      }
      if (activeRun?.status === "waiting_user_input") {
        this.session.saveUserMessage(state.room.id, text);
        return [];
      }

      if (this.config.team.trigger.autoOnMessage) {
        this.startTeamRun(text);
      } else {
        this.session.saveUserMessage(state.room.id, text);
      }
      return [];
    }

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

  private launchTeamLoop(runId: string, roomId: string): void {
    if (this.teamLoopByRoom.has(roomId)) {
      return;
    }

    const loopPromise = this.runTeamLoop(runId)
      .catch((error) => {
        const run = this.session.getTeamRun(runId);
        if (run && run.status === "active") {
          this.session.updateTeamRunStatus(run.id, "failed", {
            completedAt: new Date().toISOString(),
            finalSummary: error instanceof Error ? error.message : "Unknown team loop failure",
          });
          this.restoreTeamAdapterModes();
        }
      })
      .finally(() => {
        if (this.teamLoopByRoom.get(roomId) === loopPromise) {
          this.teamLoopByRoom.delete(roomId);
        }
        const activeDispatch = this.teamActiveDispatchByRun.get(runId);
        if (activeDispatch) {
          this.interruptedRequestIds.delete(activeDispatch.requestId);
          this.teamActiveDispatchByRun.delete(runId);
        }
        this.teamStopFlags.delete(runId);
        this.teamNextActorByRun.delete(runId);
      });

    this.teamLoopByRoom.set(roomId, loopPromise);
  }

  private async runTeamLoop(runId: string): Promise<void> {
    while (true) {
      const run = this.session.getTeamRun(runId);
      if (!run || run.status !== "active") {
        return;
      }

      if (this.teamStopFlags.has(run.id)) {
        this.session.updateTeamRunStatus(run.id, "stopped", {
          completedAt: new Date().toISOString(),
        });
        this.restoreTeamAdapterModes();
        return;
      }

      const hasPendingFeedback = this.session.countPendingTeamFeedback(run.id) > 0;
      if (this.shouldFinalizeRun(run) && !hasPendingFeedback) {
        this.completeTeamRun(run, "Debate limits reached.");
        return;
      }

      await this.executeDebateStep(run);
    }
  }

  private shouldFinalizeRun(run: TeamRun): boolean {
    const elapsedMs = Date.now() - Date.parse(run.startedAt);
    return (
      run.stepCount >= run.maxSteps ||
      run.noProgressCount >= run.maxNoProgressSteps ||
      elapsedMs >= run.maxDurationMs
    );
  }

  private async executeDebateStep(run: TeamRun): Promise<void> {
    const state = this.getState();
    const hintedActor = this.teamNextActorByRun.get(run.id);
    const actor = hintedActor && state.availableAgents.includes(hintedActor)
      ? hintedActor
      : this.teamPolicy.selectActor(run, "debate", state.availableAgents);
    if (!actor) {
      this.session.updateTeamRunStatus(run.id, "failed", {
        completedAt: new Date().toISOString(),
        finalSummary: "No available actor for debate step.",
      });
      return;
    }

    const prompt = this.session.buildTeamPrompt(
      state.room,
      run,
      "debate",
      actor,
      {
        instructions:
          "Advance the goal with one concrete step in this turn. Prefer doing work over check-ins. " +
          "At the end of your response add exactly one control line: TEAM_NEXT:<agent> to continue, or TEAM_DONE to finish. " +
          "If the goal is complete or blocked pending user input, use TEAM_DONE. " +
          "Do not output internal tool/runtime logs or meta progress chatter.",
      },
    );
    const consumedFeedbackIds = this.session.listPendingTeamFeedback(run.id, 20).map((item) => item.id);
    this.session.consumeTeamFeedback(consumedFeedbackIds);

    const dispatch = this.createInternalDispatch(actor, `team:debate:${run.stepCount + 1}`);
    this.trackActiveTeamDispatch(run.id, actor, dispatch.requestId);
    let result: DispatchResult;
    try {
      result = await this.runPromptDispatch(dispatch, prompt);
    } finally {
      this.clearActiveTeamDispatch(run.id, dispatch.requestId);
    }
    if (this.consumeInterruptedRequest(dispatch.requestId)) {
      this.teamNextActorByRun.set(run.id, actor);
      return;
    }

    const stepSeq = run.stepCount + 1;
    this.session.addTeamStep({
      runId: run.id,
      seq: stepSeq,
      stage: "debate",
      actor,
      dispatchId: dispatch.dispatchId,
      requestId: dispatch.requestId,
      inputText: prompt,
      outputText: result.text,
      result: result.success ? "ok" : "error",
      errorClass: normalizeErrorClass(result.error),
    });

    const control = parseTeamDebateControl(result.text);
    const nextActor =
      control.nextActor && state.availableAgents.includes(control.nextActor)
        ? control.nextActor
        : null;
    if (nextActor) {
      this.teamNextActorByRun.set(run.id, nextActor);
    } else {
      this.teamNextActorByRun.delete(run.id);
    }
    const noProgressCount = result.success && result.text.trim().length > 0
      ? 0
      : run.noProgressCount + 1;
    this.session.updateTeamRunProgress(run.id, {
      stage: "debate",
      stepCount: stepSeq,
      noProgressCount,
    });

    const updated = this.session.getTeamRun(run.id);
    if (!updated || updated.status !== "active") {
      return;
    }
    if (control.done) {
      this.completeTeamRun(updated, "TEAM_DONE control event.", result.text);
      return;
    }
    if (!nextActor) {
      this.completeTeamRun(updated, "No TEAM_NEXT control event.", result.text);
      return;
    }
    if (this.shouldFinalizeRun(updated)) {
      this.completeTeamRun(updated, "Debate limits reached.", result.text);
    }
  }

  private completeTeamRun(run: TeamRun, reason: string, summaryHint?: string): void {
    const summary = summaryHint?.trim() || run.finalSummary || reason;
    this.session.updateTeamRunProgress(run.id, {
      finalSummary: summary,
    });
    this.session.updateTeamRunStatus(run.id, "waiting_user_input", {
      finalSummary: summary,
    });
    this.restoreTeamAdapterModes();
    this.teamNextActorByRun.delete(run.id);
  }

  private restoreTeamAdapterModes(): void {
    if (!this.teamAdapterModeSnapshot) {
      return;
    }
    for (const [agent, mode] of Object.entries(this.teamAdapterModeSnapshot)) {
      if (!mode) {
        continue;
      }
      const adapterConfig = this.config.adapterConfig[agent];
      if (!adapterConfig) {
        continue;
      }
      this.config.adapterConfig[agent] = {
        ...adapterConfig,
        mode,
      };
    }
    this.teamAdapterModeSnapshot = null;
  }

  private createInternalDispatch(targetAdapter: string, reason: string): Dispatch {
    return {
      dispatchId: createId("dsp"),
      requestId: createId("req"),
      targetAdapter,
      priority: 0,
      reason,
    };
  }

  private async runPromptDispatch(
    dispatch: Dispatch,
    prompt: string,
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

    const adapterConfig = withTeamSystemPrompt(
      this.resolveAdapterConfig(dispatch.targetAdapter),
    );
    const persistentLikeMode =
      (adapterConfig.mode === "persistent" || adapterConfig.mode === "agentic") &&
      "sendTurn" in adapter;
    if (persistentLikeMode) {
      return this.session.acquireTurnLock(
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
              outputTransform: sanitizeTeamOutput,
            },
          ),
      );
    }

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

    return this.runLegacyDispatch(dispatch, adapter, adapterConfig, [syntheticMessage], {
      outputTransform: sanitizeTeamOutput,
    });
  }

  private async runDispatch(
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

    const adapterConfig = this.resolveAdapterConfig(dispatch.targetAdapter);
    const isPersistent =
      (adapterConfig.mode === "persistent" || adapterConfig.mode === "agentic") &&
      "sendTurn" in adapter;
    if (isPersistent) {
      return this.session.acquireTurnLock(
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
    }

    return this.runLegacyDispatch(dispatch, adapter, adapterConfig);
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
      this.session.buildContextMessages(state.room, adapterConfig.systemPrompt);
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
        text: applyOutputTransform(finalText, options?.outputTransform),
        error: `${failed.errorClass}: ${failed.message}`,
      };
    }

    const resolvedText = applyOutputTransform(
      finalText.trim() || "(empty response)",
      options?.outputTransform,
    );

    const provider = dispatch.targetAdapter === "codex" ? "openai" : "anthropic";
    const model = dispatch.targetAdapter === "codex" ? "codex" : "claude-code";
    this.session.saveAssistantMessage(
      state.room.id,
      `agent.${dispatch.targetAdapter}`,
      resolvedText,
      dispatch.requestId,
      dispatch.dispatchId,
      provider,
      model,
    );

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
      this.hooks.onAdapterEvent?.(dispatch.targetAdapter, event);

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

    const provider = dispatch.targetAdapter === "codex" ? "openai" : "anthropic";
    const model = dispatch.targetAdapter === "codex" ? "codex" : "claude-code";
    this.session.saveAssistantMessage(
      state.room.id,
      `agent.${dispatch.targetAdapter}`,
      resolvedText,
      dispatch.requestId,
      dispatch.dispatchId,
      provider,
      model,
    );

    return {
      adapter: dispatch.targetAdapter,
      requestId: dispatch.requestId,
      success: true,
      text: resolvedText,
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

  private trackActiveTeamDispatch(
    runId: string,
    adapterName: string,
    requestId: string,
  ): void {
    this.teamActiveDispatchByRun.set(runId, {
      adapterName,
      requestId,
    });
  }

  private clearActiveTeamDispatch(runId: string, requestId: string): void {
    const current = this.teamActiveDispatchByRun.get(runId);
    if (!current || current.requestId !== requestId) {
      return;
    }
    this.teamActiveDispatchByRun.delete(runId);
  }

  private consumeInterruptedRequest(requestId: string): boolean {
    if (!this.interruptedRequestIds.has(requestId)) {
      return false;
    }
    this.interruptedRequestIds.delete(requestId);
    return true;
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

const normalizeErrorClass = (error?: string): TeamStep["errorClass"] => {
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

const sanitizeTeamOutput = (text: string): string => {
  if (!text) {
    return text;
  }

  const withoutReminders = text.replace(
    /<system-reminder>[\s\S]*?<\/system-reminder>/gi,
    "",
  );
  const filteredLines = withoutReminders
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return true;
      }

      if (/^\d+→/.test(trimmed)) {
        return false;
      }
      if (/^now appending to the bridge log:?$/i.test(trimmed)) {
        return false;
      }
      if (isTeamProcessChatterLine(trimmed)) {
        return false;
      }

      return true;
    });

  const cleaned = filteredLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return cleaned;
};

const TEAM_PROCESS_CHATTER_PATTERNS = [
  /\b(i(?:'|’)m|i am|i(?:'|’)ll|i will)\b.*\b(read|scan|check|review|verify|grep|bootstrap|cross-check|inspect|prepare|gather|collect|re-?run|search)\b/i,
  /\b(i hit|quick bootstrap|first pass|next i(?:'|’)m|now i(?:'|’)m)\b/i,
  /\b(зараз|спершу|далі|потім|наступним кроком)\b.*\b(перевір|звір|прочита|скан|подив|підгот|запущ|зроблю)\b/i,
  /\bя\b.*\b(перевірю|прочитаю|запущу|зроблю швидкий)\b/i,
];

const isTeamProcessChatterLine = (line: string): boolean =>
  TEAM_PROCESS_CHATTER_PATTERNS.some((pattern) => pattern.test(line));

interface TeamDebateControl {
  done: boolean;
  nextActor: string | null;
}

const TEAM_DONE_PATTERN = /(?:^|\n)\s*TEAM_DONE(?:\b|:)/i;
const TEAM_NEXT_PATTERN = /(?:^|\n)\s*TEAM_NEXT\s*:\s*@?([a-z0-9._-]+)/i;
const TEAM_STOP_WORD_PATTERNS = [
  /\bAGORYX_STOP\b/i,
  /\bTEAM_STOP\b/i,
];

const parseTeamDebateControl = (text: string): TeamDebateControl => {
  const trimmed = text.trim();
  if (!trimmed) {
    return { done: false, nextActor: null };
  }

  if (
    TEAM_DONE_PATTERN.test(trimmed) ||
    TEAM_STOP_WORD_PATTERNS.some((pattern) => pattern.test(trimmed))
  ) {
    return { done: true, nextActor: null };
  }

  const nextMatch = TEAM_NEXT_PATTERN.exec(trimmed);
  if (nextMatch?.[1]) {
    return {
      done: false,
      nextActor: nextMatch[1].toLowerCase(),
    };
  }

  return { done: false, nextActor: null };
};
