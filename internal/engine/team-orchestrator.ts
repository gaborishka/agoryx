import type { Adapter, AdapterConfig } from "../adapters/adapter.js";
import type { ChatRuntimeConfig } from "../config/default.js";
import type {
  TeamCheck,
  TeamRun,
  TeamStep,
  Message,
  SessionBoundPayload,
} from "../events/types.js";
import { createPolicy } from "../orchestrator/factory.js";
import { TeamPolicy } from "../orchestrator/team.js";
import { createId } from "../session/ids.js";
import { SessionService } from "../session/service.js";
import type { EngineLogger } from "./logger.js";
import { normalizeErrorClass } from "./dispatch-engine.js";
import type {
  ChatEngineHooks,
  DispatchResult,
  EngineState,
  TeamDispatchApi,
  TeamInterruptResult,
  TeamLogResult,
  TeamStatusResult,
} from "./types.js";

interface TeamOrchestratorOptions {
  session: SessionService;
  adapters: Record<string, Adapter>;
  config: ChatRuntimeConfig;
  getState: () => EngineState;
  setState: (next: EngineState) => void;
  dispatchApi: TeamDispatchApi;
  hooks: ChatEngineHooks;
  logger: EngineLogger;
}

interface ActiveTeamDispatch {
  adapterName: string;
  requestId: string;
}

export class TeamOrchestrator {
  private readonly teamPolicy = new TeamPolicy();
  private readonly teamLoopByRoom = new Map<string, Promise<void>>();
  private readonly teamStopFlags = new Set<string>();
  private readonly teamNextActorByRun = new Map<string, string>();
  private readonly teamActiveDispatchByRun = new Map<string, ActiveTeamDispatch>();
  private readonly interruptedRequestIds = new Set<string>();
  private teamAdapterModeSnapshot: Partial<Record<string, AdapterConfig["mode"]>> | null = null;

  private readonly session: SessionService;
  private readonly adapters: Record<string, Adapter>;
  private readonly config: ChatRuntimeConfig;
  private readonly getState: () => EngineState;
  private readonly setState: (next: EngineState) => void;
  private readonly dispatchApi: TeamDispatchApi;
  private readonly hooks: ChatEngineHooks;
  private readonly logger: EngineLogger;

  public constructor(options: TeamOrchestratorOptions) {
    this.session = options.session;
    this.adapters = options.adapters;
    this.config = options.config;
    this.getState = options.getState;
    this.setState = options.setState;
    this.dispatchApi = options.dispatchApi;
    this.hooks = options.hooks;
    this.logger = options.logger;
  }

  public startRun(
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
      this.setState(state);
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

    this.logger.log("info", "team.run_started", {
      roomId: run.roomId,
      runId: run.id,
      goalLength: trimmedGoal.length,
      checksEnabled,
      strictProfile,
    });

    this.launchLoop(run.id, run.roomId);
    return run;
  }

  public status(runId?: string): TeamStatusResult | null {
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

  public log(limit = 20, runId?: string): TeamLogResult | null {
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

  public resume(): TeamRun | null {
    const state = this.getState();
    const run = this.session.getLatestResumableTeamRun(state.room.id);
    if (!run) {
      return null;
    }
    if (run.status === "active") {
      this.launchLoop(run.id, run.roomId);
    }
    return run;
  }

  public approve(runId?: string): TeamRun | null {
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

    this.logger.log("info", "team.run_approved", {
      roomId: run.roomId,
      runId: run.id,
    });

    return this.session.getTeamRun(run.id);
  }

  public stop(runId?: string): TeamRun | null {
    const state = this.getState();
    const run = runId
      ? this.session.getTeamRun(runId)
      : this.session.getActiveTeamRun(state.room.id);
    if (!run) {
      return null;
    }

    this.teamStopFlags.add(run.id);
    void this.interrupt(undefined, run.id).catch((error: unknown) => {
      this.logger.log("warn", "team.stop_interrupt_failed", {
        runId: run.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    this.session.updateTeamRunStatus(run.id, "stopped", {
      completedAt: new Date().toISOString(),
    });
    this.restoreTeamAdapterModes();
    this.teamNextActorByRun.delete(run.id);

    this.logger.log("warn", "team.run_stopped", {
      roomId: run.roomId,
      runId: run.id,
    });

    return this.session.getTeamRun(run.id);
  }

  public async interrupt(
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
    } catch (error: unknown) {
      this.logger.log("warn", "team.interrupt_cancel_failed", {
        runId: run.id,
        requestId: activeDispatch.requestId,
        adapterName: activeDispatch.adapterName,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.logger.log("info", "team.run_interrupted", {
      roomId: run.roomId,
      runId: run.id,
      requestId: activeDispatch.requestId,
      feedbackQueued,
    });

    return {
      run,
      interrupted: true,
      feedbackQueued,
    };
  }

  public queueFeedback(text: string): TeamRun | null {
    const state = this.getState();
    const run = this.session.getActiveTeamRun(state.room.id);
    if (!run || run.status !== "active") {
      return null;
    }
    const message = this.session.saveUserMessage(state.room.id, text);
    this.session.enqueueTeamFeedback(run.id, message.id, text);
    return run;
  }

  public async processTeamUserMessage(text: string): Promise<DispatchResult[]> {
    const state = this.getState();
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
      this.startRun(text);
    } else {
      this.session.saveUserMessage(state.room.id, text);
    }
    return [];
  }

  public async stopActiveRunForRoom(roomId: string): Promise<void> {
    const run = this.session.getActiveTeamRun(roomId);
    if (!run || run.status !== "active") {
      return;
    }

    this.teamStopFlags.add(run.id);
    await this.interrupt(undefined, run.id);
    this.session.updateTeamRunStatus(run.id, "stopped", {
      completedAt: new Date().toISOString(),
    });
    this.restoreTeamAdapterModes();
  }

  public async waitForRoomLoop(roomId: string): Promise<void> {
    const loop = this.teamLoopByRoom.get(roomId);
    if (!loop) {
      return;
    }
    await Promise.allSettled([loop]);
  }

  private launchLoop(runId: string, roomId: string): void {
    if (this.teamLoopByRoom.has(roomId)) {
      return;
    }

    const loopPromise = this.runLoop(runId)
      .catch((error) => {
        const errorMessage = error instanceof Error ? error.message : "Unknown team loop failure";
        this.logger.log("error", "team.run_failed", {
          roomId,
          runId,
          error: errorMessage,
        });
        const run = this.session.getTeamRun(runId);
        if (run && run.status === "active") {
          this.session.updateTeamRunStatus(run.id, "failed", {
            completedAt: new Date().toISOString(),
            finalSummary: errorMessage,
          });
          this.restoreTeamAdapterModes();
        }
        this.hooks.onAdapterEvent?.("team.system", {
          eventId: createId("evt"),
          roomId,
          sessionId: this.getState().sessionId,
          timestamp: new Date().toISOString(),
          source: "engine.team",
          type: "message.error",
          requestId: runId,
          payload: { class: "UNKNOWN", message: `Team run failed: ${errorMessage}` },
        });
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

  private async runLoop(runId: string): Promise<void> {
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
        this.completeRun(run, "Debate limits reached.");
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

    const dispatch = this.dispatchApi.createInternalDispatch(actor, `team:debate:${run.stepCount + 1}`);
    this.trackActiveTeamDispatch(run.id, actor, dispatch.requestId);
    let result: DispatchResult;
    try {
      result = await this.dispatchApi.runPromptDispatch(dispatch, prompt, false, {
        outputTransform: sanitizeTeamOutput,
      });
    } finally {
      this.clearActiveTeamDispatch(run.id, dispatch.requestId);
    }

    if (this.consumeInterruptedRequest(dispatch.requestId)) {
      this.teamNextActorByRun.set(run.id, actor);
      return;
    }
    this.session.consumeTeamFeedback(consumedFeedbackIds);

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

    const MIN_PROGRESS_LENGTH = 80;
    const noProgressCount =
      result.success && result.text.trim().length >= MIN_PROGRESS_LENGTH
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
    if (!result.success) {
      this.session.updateTeamRunStatus(updated.id, "failed", {
        completedAt: new Date().toISOString(),
        finalSummary: result.error ?? "Team debate step failed.",
      });
      this.restoreTeamAdapterModes();
      this.teamNextActorByRun.delete(updated.id);
      return;
    }
    if (control.done) {
      this.completeRun(updated, "TEAM_DONE control event.", result.text);
      return;
    }
    if (!nextActor) {
      this.completeRun(updated, "No TEAM_NEXT control event.", result.text);
      return;
    }
    if (this.shouldFinalizeRun(updated)) {
      this.completeRun(updated, "Debate limits reached.", result.text);
    }
  }

  private completeRun(run: TeamRun, reason: string, summaryHint?: string): void {
    const summary = summaryHint?.trim() || run.finalSummary || reason;
    this.session.updateTeamRunProgress(run.id, {
      finalSummary: summary,
    });
    this.session.updateTeamRunStatus(run.id, "waiting_user_input", {
      finalSummary: summary,
    });
    this.restoreTeamAdapterModes();
    this.teamNextActorByRun.delete(run.id);

    this.logger.log("info", "team.run_waiting_approval", {
      roomId: run.roomId,
      runId: run.id,
      reason,
      summaryLength: summary.length,
    });
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

export const sanitizeTeamOutput = (text: string): string => {
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

const TEAM_DONE_PATTERN = /^\s*TEAM_DONE(?:\b|:)/i;
const TEAM_NEXT_PATTERN = /^\s*TEAM_NEXT\s*:\s*@?([a-z0-9._-]+)/i;
const TEAM_STOP_WORD_PATTERNS = [
  /^\s*AGORYX_STOP\s*$/i,
  /^\s*TEAM_STOP\s*$/i,
];
const INLINE_CODE_WRAPPER_PATTERN = /^(`{1,3})([^`]+)\1$/;

/** Max number of trailing lines to scan for control directives. */
const CONTROL_TAIL_LINES = 5;

export const parseTeamDebateControl = (text: string): TeamDebateControl => {
  const trimmed = text.trim();
  if (!trimmed) {
    return { done: false, nextActor: null };
  }

  const lines = trimmed.split(/\r?\n/);
  const tail = lines.slice(-CONTROL_TAIL_LINES);

  for (const line of tail) {
    const normalizedLine = normalizeTeamControlLine(line);
    if (
      TEAM_DONE_PATTERN.test(normalizedLine) ||
      TEAM_STOP_WORD_PATTERNS.some((pattern) => pattern.test(normalizedLine))
    ) {
      return { done: true, nextActor: null };
    }
  }

  for (const line of tail) {
    const normalizedLine = normalizeTeamControlLine(line);
    const nextMatch = TEAM_NEXT_PATTERN.exec(normalizedLine);
    if (nextMatch?.[1]) {
      return {
        done: false,
        nextActor: nextMatch[1].toLowerCase(),
      };
    }
  }

  return { done: false, nextActor: null };
};

const normalizeTeamControlLine = (line: string): string => {
  const trimmed = line.trim();
  const inlineCodeMatch = INLINE_CODE_WRAPPER_PATTERN.exec(trimmed);
  if (!inlineCodeMatch) {
    return trimmed;
  }
  return inlineCodeMatch[2]?.trim() ?? trimmed;
};
