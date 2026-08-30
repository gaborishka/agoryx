import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { Adapter, AdapterConfig } from "../adapters/adapter.js";
import type { ChatRuntimeConfig } from "../config/default.js";
import type { TeamPlan, TeamRun } from "../events/types.js";
import type { MemoryService } from "../memory/service.js";
import type { WorktreeManager } from "../worktree/manager.js";
import { createPolicy } from "../orchestrator/factory.js";
import { sanitizeTeamOutput } from "../rendering/sanitize.js";
import { createId } from "../session/ids.js";
import { SessionService } from "../session/service.js";
import type { EngineLogger } from "./logger.js";
import { normalizeErrorClass } from "./dispatch-engine.js";
import { parseTeamPlan } from "./plan-parser.js";
import type {
  ChatEngineHooks,
  DispatchResult,
  EngineState,
  TeamDispatchApi,
  TeamInterruptResult,
  TeamLogResult,
  TeamStatusResult,
} from "./types.js";

export { sanitizeTeamOutput } from "../rendering/sanitize.js";

interface TeamOrchestratorOptions {
  session: SessionService;
  adapters: Record<string, Adapter>;
  config: ChatRuntimeConfig;
  getState: () => EngineState;
  setState: (next: EngineState) => void;
  dispatchApi: TeamDispatchApi;
  hooks: ChatEngineHooks;
  logger: EngineLogger;
  memoryService?: MemoryService;
  worktreeManager?: WorktreeManager;
}

interface ActiveTeamDispatch {
  adapterName: string;
  requestId: string;
}

interface TeamAdapterConfigSnapshot {
  mode: AdapterConfig["mode"];
  workspaceCwd?: string;
  hadWorkspaceCwd: boolean;
}

export class TeamOrchestrator {
  private readonly teamLoopByRoom = new Map<string, Promise<void>>();
  private readonly teamStopFlags = new Set<string>();
  private readonly checksAbortByRun = new Map<string, AbortController>();
  private readonly teamActiveDispatchesByRun = new Map<string, Map<string, ActiveTeamDispatch>>();
  private readonly runStartWarningsByRun = new Map<string, string[]>();
  private readonly interruptedRequestIds = new Set<string>();
  private teamAdapterConfigSnapshot: Partial<Record<string, TeamAdapterConfigSnapshot>> | null =
    null;

  private readonly session: SessionService;
  private readonly adapters: Record<string, Adapter>;
  private readonly config: ChatRuntimeConfig;
  private readonly getState: () => EngineState;
  private readonly setState: (next: EngineState) => void;
  private readonly dispatchApi: TeamDispatchApi;
  private readonly hooks: ChatEngineHooks;
  private readonly logger: EngineLogger;
  private readonly memoryService?: MemoryService;
  private readonly worktreeManager?: WorktreeManager;

  public constructor(options: TeamOrchestratorOptions) {
    this.session = options.session;
    this.adapters = options.adapters;
    this.config = options.config;
    this.getState = options.getState;
    this.setState = options.setState;
    this.dispatchApi = options.dispatchApi;
    this.hooks = options.hooks;
    this.logger = options.logger;
    this.memoryService = options.memoryService;
    this.worktreeManager = options.worktreeManager;
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
    const adapterSnapshot: Partial<Record<string, TeamAdapterConfigSnapshot>> = {};
    for (const agent of state.availableAgents) {
      const adapterConfig = this.config.adapterConfig[agent];
      if (!adapterConfig) {
        continue;
      }
      adapterSnapshot[agent] = {
        mode: adapterConfig.mode,
        workspaceCwd: adapterConfig.workspaceCwd,
        hadWorkspaceCwd: Object.prototype.hasOwnProperty.call(adapterConfig, "workspaceCwd"),
      };
      if (adapterConfig.mode === "cli") {
        this.config.adapterConfig[agent] = {
          ...adapterConfig,
          mode: "agentic",
        };
      }
    }
    if (Object.keys(adapterSnapshot).length > 0) {
      this.teamAdapterConfigSnapshot = adapterSnapshot;
    }

    const runStartWarnings: string[] = [];

    // Auto-create worktrees for each agent
    if (this.worktreeManager) {
      for (const agent of state.availableAgents) {
        try {
          const wt = this.worktreeManager.create(agent);
          // Set workspaceCwd for the agent's adapter config
          const agentConfig = this.config.adapterConfig[agent];
          if (agentConfig) {
            this.config.adapterConfig[agent] = {
              ...agentConfig,
              workspaceCwd: wt.path,
            };
          }
          this.memoryService?.recordWorktreeCreate(
            state.room.id,
            agent,
            wt.path,
            wt.branch,
          );
        } catch (error: unknown) {
          const reason = error instanceof Error ? error.message : String(error);
          runStartWarnings.push(
            `Worktree isolation disabled for ${agent}: ${reason}. Using main repository workspace.`,
          );
          this.logger.log("warn", "team.worktree_create_failed", {
            agent,
            error: reason,
          });
        }
      }
    }

    if (state.room.config.mode !== "team") {
      state.room = this.session.updateRoomMode(state.room, "team");
      state.policy = createPolicy("team", {
        agentSkills: this.config.agentSkills,
      });
      this.setState(state);
    }

    let run: TeamRun;
    try {
      run = this.session.createTeamRun({
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
    } catch (error: unknown) {
      this.restoreTeamAdapterModes();
      throw error;
    }

    this.logger.log("info", "team.run_started", {
      roomId: run.roomId,
      runId: run.id,
      goalLength: trimmedGoal.length,
      checksEnabled,
      strictProfile,
    });

    if (runStartWarnings.length > 0) {
      this.runStartWarningsByRun.set(run.id, runStartWarnings);
    }

    this.launchLoop(run.id, run.roomId);
    return run;
  }

  public consumeRunStartWarnings(runId: string): string[] {
    const warnings = this.runStartWarningsByRun.get(runId);
    if (!warnings || warnings.length === 0) {
      return [];
    }
    this.runStartWarningsByRun.delete(runId);
    return [...warnings];
  }

  public status(runId?: string): TeamStatusResult | null {
    const state = this.getState();
    const run = runId
      ? this.session.getTeamRun(runId)
      : (this.session.getActiveTeamRun(state.room.id) ??
         this.session.getLatestTeamRun(state.room.id));
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
      : (this.session.getLatestResumableTeamRun(state.room.id) ??
         this.session.getLatestTeamRun(state.room.id));
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

    // Commit and merge agent worktrees into the main branch
    const mergeErrors: string[] = [];
    if (this.worktreeManager) {
      for (const agent of state.availableAgents) {
        const result = this.commitAndMergeWorktree(agent, run.goal);
        if (!result.merged && result.error) {
          mergeErrors.push(`${agent}: ${result.error}`);
        }
      }
    }

    if (mergeErrors.length > 0) {
      const errorSummary = "Merge failed:\n" + mergeErrors.join("\n");
      this.session.updateTeamRunProgress(run.id, { finalSummary: errorSummary });
      this.logger.log("error", "team.approve_merge_failed", {
        runId: run.id,
        errors: mergeErrors,
      });
      // Stay in waiting_user_input so user can resolve
      return this.session.getTeamRun(run.id);
    }

    this.session.updateTeamRunStatus(run.id, "done", {
      completedAt: new Date().toISOString(),
    });
    this.restoreTeamAdapterModes();

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
    this.abortActiveChecks(run.id);
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

    const activeDispatches = this.teamActiveDispatchesByRun.get(run.id);
    if (!activeDispatches || activeDispatches.size === 0) {
      return {
        run,
        interrupted: false,
        feedbackQueued,
      };
    }

    // Mark every request id before awaiting any cancellation: while a slow
    // cancel() is in flight, a still-unmarked dispatch could complete and be
    // recorded as a successful step instead of a stopped one.
    const dispatchesToCancel = [...activeDispatches.values()];
    const interruptedRequestIds: string[] = [];
    for (const activeDispatch of dispatchesToCancel) {
      this.interruptedRequestIds.add(activeDispatch.requestId);
      interruptedRequestIds.push(activeDispatch.requestId);
    }
    await Promise.all(
      dispatchesToCancel.map(async (activeDispatch) => {
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
      }),
    );

    this.logger.log("info", "team.run_interrupted", {
      roomId: run.roomId,
      runId: run.id,
      requestIds: interruptedRequestIds,
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
      const mentionTargets = resolveMentionTargets(text, state.availableAgents);
      if (mentionTargets.length === 0) {
        return [];
      }

      const results: DispatchResult[] = [];
      for (const target of mentionTargets) {
        const dispatch = this.dispatchApi.createInternalDispatch(
          target,
          `team:waiting_mention:${target}`,
        );
        results.push(await this.dispatchApi.runDispatch(dispatch));
      }
      return results;
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
    this.abortActiveChecks(run.id);
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
        const activeDispatches = this.teamActiveDispatchesByRun.get(runId);
        if (activeDispatches) {
          for (const activeDispatch of activeDispatches.values()) {
            this.interruptedRequestIds.delete(activeDispatch.requestId);
          }
          this.teamActiveDispatchesByRun.delete(runId);
        }
        this.teamStopFlags.delete(runId);
        this.checksAbortByRun.delete(runId);
      });

    this.teamLoopByRoom.set(roomId, loopPromise);
  }

  private async runLoop(runId: string): Promise<void> {
    const run = this.session.getTeamRun(runId);
    if (!run || run.status !== "active") return;

    if (this.teamStopFlags.has(runId)) {
      this.session.updateTeamRunStatus(run.id, "stopped", {
        completedAt: new Date().toISOString(),
      });
      this.restoreTeamAdapterModes();
      return;
    }

    // Limits guard before any dispatch — a resumed run may already be exhausted.
    const startViolation = this.getLimitViolation(run);
    if (startViolation) {
      this.finalizeForLimits(run, startViolation);
      return;
    }

    // Phase 1: Planning
    const plan = await this.runPlanningPhase(run);
    if (!plan || this.teamStopFlags.has(runId)) {
      if (!this.teamStopFlags.has(runId)) {
        const msg = "Planning phase failed to produce a plan.";
        this.session.updateTeamRunProgress(run.id, { finalSummary: msg });
        this.session.updateTeamRunStatus(run.id, "failed", { finalSummary: msg });
        this.restoreTeamAdapterModes();
      }
      return;
    }

    const planned = this.session.getTeamRun(runId);
    if (!planned || planned.status !== "active") return;
    const postPlanViolation = this.getLimitViolation(planned);
    if (postPlanViolation) {
      this.finalizeForLimits(planned, postPlanViolation);
      return;
    }

    // Phase 2: Parallel execution
    const { skippedAgents, stepIdByAgent } = await this.runParallelExecution(planned, plan);
    if (this.teamStopFlags.has(runId)) return;

    const mergeNotes =
      skippedAgents.length > 0
        ? [`Step budget (maxSteps=${run.maxSteps}) exhausted; skipped agents: ${skippedAgents.join(", ")}.`]
        : [];

    // Phase 3: Checks. Re-check the deadline first — implementation may have
    // consumed the remaining budget, and each check can run up to its own
    // timeout. The merge phase still runs: it dispatches nothing and ends at
    // the user gate, so the change report is not lost to the limit.
    const afterImplement = this.session.getTeamRun(runId);
    if (afterImplement && afterImplement.status === "active") {
      if (this.isPastDeadline(afterImplement)) {
        mergeNotes.push(
          `Checks skipped: run exceeded maxDurationMs (${afterImplement.maxDurationMs}ms).`,
        );
        this.logger.log("warn", "team.checks_skipped_deadline", {
          runId: run.id,
          maxDurationMs: afterImplement.maxDurationMs,
        });
      } else {
        mergeNotes.push(...(await this.runChecksPhase(afterImplement, stepIdByAgent)));
      }
    }
    if (this.teamStopFlags.has(runId)) return;

    // Phase 4: Merge
    await this.runMergePhase(run, mergeNotes);
  }

  /**
   * Runs the configured check commands after the implement phase and records
   * every result into team_checks. Checks are per agent worktree when worktree
   * isolation is on, otherwise a single pass in the main workspace. Failures
   * do not fail the run — per finalGate "proposal" the user sees the outcomes
   * in the merge summary and decides at /team approve.
   */
  private async runChecksPhase(
    run: TeamRun,
    stepIdByAgent: Map<string, string>,
  ): Promise<string[]> {
    if (!run.checksEnabled) return [];
    const commands = this.config.team.checkCommands;
    if (commands.length === 0) return [];

    this.session.updateTeamRunProgress(run.id, { stage: "checks" });
    const state = this.getState();

    const workspaces: Array<{ agent: string | null; cwd: string }> = [];
    // When worktree creation failed for some agent at startRun, that agent
    // worked in the main workspace — checks must cover it too.
    let mainWorkspaceNeeded = !this.worktreeManager;
    if (this.worktreeManager) {
      for (const agent of state.availableAgents) {
        const wt = this.worktreeManager.getForAgent(agent);
        if (wt) {
          workspaces.push({ agent, cwd: wt.path });
        } else {
          mainWorkspaceNeeded = true;
        }
      }
    }
    if (mainWorkspaceNeeded) {
      workspaces.push({
        agent: null,
        cwd: this.worktreeManager?.getRepoRoot() ?? process.cwd(),
      });
    }

    const abortController = new AbortController();
    this.checksAbortByRun.set(run.id, abortController);
    try {
      return await this.executeChecks(run, workspaces, commands, stepIdByAgent, abortController.signal);
    } finally {
      if (this.checksAbortByRun.get(run.id) === abortController) {
        this.checksAbortByRun.delete(run.id);
      }
    }
  }

  private async executeChecks(
    run: TeamRun,
    workspaces: Array<{ agent: string | null; cwd: string }>,
    commands: string[],
    stepIdByAgent: Map<string, string>,
    abortSignal: AbortSignal,
  ): Promise<string[]> {
    let passedCount = 0;
    const failures: string[] = [];
    for (const workspace of workspaces) {
      for (const command of commands) {
        if (this.teamStopFlags.has(run.id) || abortSignal.aborted) {
          return [];
        }
        const outcome = await runCheckCommand(command, workspace.cwd, abortSignal);
        if (outcome.status === "aborted") {
          return [];
        }
        this.session.addTeamCheck({
          runId: run.id,
          stepId: workspace.agent ? (stepIdByAgent.get(workspace.agent) ?? null) : null,
          command,
          status: outcome.status,
          exitCode: outcome.exitCode,
          stdoutText: outcome.stdout,
          stderrText: outcome.stderr,
          durationMs: outcome.durationMs,
        });
        if (outcome.status === "passed") {
          passedCount += 1;
        } else {
          const scope = workspace.agent ? `${workspace.agent}: ` : "";
          const exitInfo = outcome.exitCode === null ? "" : `, exit ${outcome.exitCode}`;
          failures.push(`${scope}${command} (${outcome.status}${exitInfo})`);
        }
        this.logger.log(
          outcome.status === "passed" ? "info" : "warn",
          "team.check_completed",
          {
            runId: run.id,
            agent: workspace.agent,
            command,
            status: outcome.status,
            exitCode: outcome.exitCode,
            durationMs: outcome.durationMs,
          },
        );
      }
    }

    if (failures.length === 0) {
      return [`Checks: ${passedCount} passed.`];
    }
    return [
      `Checks: ${passedCount} passed, ${failures.length} failed:\n  ${failures.join("\n  ")}`,
    ];
  }

  private getLimitViolation(run: TeamRun): string | null {
    if (run.stepCount >= run.maxSteps) {
      return `max steps (${run.maxSteps})`;
    }
    if (run.noProgressCount >= run.maxNoProgressSteps) {
      return `no progress for ${run.noProgressCount} steps`;
    }
    if (this.isPastDeadline(run)) {
      return `max duration (${run.maxDurationMs}ms)`;
    }
    return null;
  }

  private isPastDeadline(run: TeamRun): boolean {
    return Date.now() - Date.parse(run.startedAt) >= run.maxDurationMs;
  }

  private abortActiveChecks(runId: string): void {
    this.checksAbortByRun.get(runId)?.abort();
  }

  private finalizeForLimits(run: TeamRun, reason: string): void {
    const summary = `Team limits reached: ${reason}.`;
    this.session.updateTeamRunProgress(run.id, { finalSummary: summary });
    this.session.updateTeamRunStatus(run.id, "waiting_user_input", { finalSummary: summary });
    this.restoreTeamAdapterModes();

    this.logger.log("warn", "team.run_limits_reached", {
      roomId: run.roomId,
      runId: run.id,
      reason,
    });
  }

  private async runPlanningPhase(run: TeamRun): Promise<TeamPlan | null> {
    const state = this.getState();
    const agents = state.availableAgents;
    if (agents.length < 2) {
      // Single agent — no negotiation needed, auto-generate plan
      return {
        assignments: [{ agent: agents[0]!, task: run.goal, files: [] }],
        accepted: true,
        raw: "",
      };
    }

    let latestPlan: TeamPlan | null = null;
    const baseSeq = run.stepCount;

    // Round 1: First agent proposes
    const proposer = agents[0]!;
    const proposePrompt = this.session.buildTeamPrompt(
      state.room,
      run,
      "plan",
      proposer,
      {
        instructions:
          `You are the PLAN PROPOSER. The team has ${agents.length} agents: ${agents.join(", ")}.\n` +
          `Analyze the goal and create a work plan. Divide the work so each agent handles distinct files.\n` +
          `Output your plan in this exact format:\n\n` +
          `PLAN:\n` +
          `- agent: <name>\n` +
          `  task: <description>\n` +
          `  files: <comma-separated file paths>\n` +
          `- agent: <name>\n` +
          `  task: <description>\n` +
          `  files: <comma-separated file paths>\n` +
          `PLAN_END\n\n` +
          `Every agent must appear in the plan. Assign non-overlapping files.`,
      },
    );

    const proposeDispatch = this.dispatchApi.createInternalDispatch(proposer, `team:plan:propose`);
    this.trackActiveTeamDispatch(run.id, proposer, proposeDispatch.requestId);
    let proposeResult: DispatchResult;
    try {
      proposeResult = await this.dispatchApi.runPromptDispatch(proposeDispatch, proposePrompt, false, {
        outputTransform: sanitizeTeamOutput,
      });
    } finally {
      this.clearActiveTeamDispatch(run.id, proposeDispatch.requestId);
    }

    if (this.consumeInterruptedRequest(proposeDispatch.requestId)) return null;
    if (!proposeResult.success) return null;

    this.session.addTeamStep({
      runId: run.id,
      seq: baseSeq + 1,
      stage: "plan",
      actor: proposer,
      dispatchId: proposeDispatch.dispatchId,
      requestId: proposeDispatch.requestId,
      inputText: proposePrompt,
      outputText: proposeResult.text,
      result: "ok",
      errorClass: null,
    });
    let noProgressCount = isProgressOutput(proposeResult.success, proposeResult.text)
      ? 0
      : run.noProgressCount + 1;
    this.session.updateTeamRunProgress(run.id, {
      stage: "plan",
      stepCount: baseSeq + 1,
      noProgressCount,
    });

    latestPlan = parseTeamPlan(proposeResult.text, agents);

    // Budget/deadline guard between rounds: skip the review dispatch when the
    // proposal already consumed the last allowed step or the run is out of
    // limits — the outer post-plan guard finalizes the run.
    const afterPropose = this.session.getTeamRun(run.id);
    if (
      !afterPropose ||
      afterPropose.status !== "active" ||
      this.getLimitViolation(afterPropose) !== null
    ) {
      return latestPlan;
    }

    // Round 2: Second agent reviews and accepts/amends
    const reviewer = agents[1]!;
    const reviewPrompt = this.session.buildTeamPrompt(
      state.room,
      run,
      "plan",
      reviewer,
      {
        instructions:
          `You are the PLAN REVIEWER. Review the proposed plan below.\n` +
          `If you agree, respond with: PLAN_ACCEPT\n` +
          `If you want changes, output a revised plan in the same format:\n\n` +
          `PLAN:\n- agent: ...\n  task: ...\n  files: ...\nPLAN_END\n\n` +
          `Proposed plan from ${proposer}:\n${proposeResult.text}`,
      },
    );

    const reviewDispatch = this.dispatchApi.createInternalDispatch(reviewer, `team:plan:review`);
    this.trackActiveTeamDispatch(run.id, reviewer, reviewDispatch.requestId);
    let reviewResult: DispatchResult;
    try {
      reviewResult = await this.dispatchApi.runPromptDispatch(reviewDispatch, reviewPrompt, false, {
        outputTransform: sanitizeTeamOutput,
      });
    } finally {
      this.clearActiveTeamDispatch(run.id, reviewDispatch.requestId);
    }

    if (this.consumeInterruptedRequest(reviewDispatch.requestId)) return null;

    this.session.addTeamStep({
      runId: run.id,
      seq: baseSeq + 2,
      stage: "plan",
      actor: reviewer,
      dispatchId: reviewDispatch.dispatchId,
      requestId: reviewDispatch.requestId,
      inputText: reviewPrompt,
      outputText: reviewResult.text,
      result: reviewResult.success ? "ok" : "error",
      errorClass: normalizeErrorClass(reviewResult.error),
    });
    const reviewPlan = reviewResult.success ? parseTeamPlan(reviewResult.text, agents) : null;
    // Accepting or amending the plan is progress even when the reply is short.
    const reviewProgressed =
      reviewResult.success &&
      (reviewPlan?.accepted ||
        (reviewPlan !== null && reviewPlan.assignments.length > 0) ||
        isProgressOutput(true, reviewResult.text));
    noProgressCount = reviewProgressed ? 0 : noProgressCount + 1;
    this.session.updateTeamRunProgress(run.id, {
      stage: "plan",
      stepCount: baseSeq + 2,
      noProgressCount,
    });

    if (!reviewResult.success) return latestPlan;
    if (reviewPlan?.accepted) {
      // Reviewer accepted — use the proposer's plan
      return latestPlan;
    }
    if (reviewPlan && reviewPlan.assignments.length > 0) {
      // Reviewer provided an amended plan
      return reviewPlan;
    }

    // Fallback — use proposer's plan even if reviewer didn't give a clean response
    return latestPlan;
  }

  private async runParallelExecution(
    run: TeamRun,
    plan: TeamPlan,
  ): Promise<{ skippedAgents: string[]; stepIdByAgent: Map<string, string> }> {
    const state = this.getState();
    this.session.updateTeamRunProgress(run.id, { stage: "implement" });

    // Planning steps updated stepCount in the DB after `run` was fetched — refetch
    // so implement seqs continue after the planning seqs instead of colliding.
    const baseSeq = this.session.getTeamRun(run.id)?.stepCount ?? run.stepCount;
    const stepBudget = Math.max(0, run.maxSteps - baseSeq);
    let dispatchedCount = 0;
    const skippedAgents: string[] = [];
    const stepIdByAgent = new Map<string, string>();
    const dispatchPromises: Promise<void>[] = [];

    for (const assignment of plan.assignments) {
      if (!state.availableAgents.includes(assignment.agent)) continue;
      if (this.teamStopFlags.has(run.id)) break;
      if (dispatchedCount >= stepBudget) {
        skippedAgents.push(assignment.agent);
        continue;
      }

      const agent = assignment.agent;
      const prompt = this.session.buildTeamPrompt(
        state.room,
        run,
        "implement",
        agent,
        {
          instructions:
            `You are executing your part of the agreed plan.\n` +
            `YOUR TASK: ${assignment.task}\n` +
            `FILES YOU OWN: ${assignment.files.length > 0 ? assignment.files.join(", ") : "as needed"}\n\n` +
            `Create or modify the files listed above to complete your task. ` +
            `You have full filesystem access in your workspace.\n` +
            `IMPORTANT: After creating/modifying files, commit your changes with git:\n` +
            `  git add -A && git commit -m "feat: <short description>"`,
        },
      );

      const dispatch = this.dispatchApi.createInternalDispatch(
        agent,
        `team:implement:${assignment.agent}`,
      );
      this.trackActiveTeamDispatch(run.id, agent, dispatch.requestId);

      dispatchedCount += 1;
      const stepSeq = baseSeq + dispatchedCount;
      const promise = this.dispatchApi
        .runPromptDispatch(dispatch, prompt, false, {
          outputTransform: sanitizeTeamOutput,
        })
        .then((result) => {
          this.clearActiveTeamDispatch(run.id, dispatch.requestId);

          const interrupted = this.consumeInterruptedRequest(dispatch.requestId);
          const errorClass = interrupted ? null : normalizeErrorClass(result.error);
          const step = this.session.addTeamStep({
            runId: run.id,
            seq: stepSeq,
            stage: "implement",
            actor: agent,
            dispatchId: dispatch.dispatchId,
            requestId: dispatch.requestId,
            inputText: prompt,
            outputText: result.text,
            result: interrupted ? "stopped" : result.success ? "ok" : "error",
            errorClass,
          });
          stepIdByAgent.set(agent, step.id);

          const current = this.session.getTeamRun(run.id);
          if (current && current.status === "active") {
            const progressed =
              !interrupted && isProgressOutput(result.success, result.text);
            this.session.updateTeamRunProgress(run.id, {
              noProgressCount: progressed ? 0 : current.noProgressCount + 1,
            });
          }

          if (!interrupted) {
            this.memoryService?.recordTeamStep(
              run.roomId,
              run.id,
              agent,
              result.text.slice(0, 200),
            );
          }
        })
        .catch((error) => {
          this.clearActiveTeamDispatch(run.id, dispatch.requestId);
          this.logger.log("error", "team.parallel_dispatch_failed", {
            runId: run.id,
            agent,
            error: error instanceof Error ? error.message : String(error),
          });
        });

      dispatchPromises.push(promise);
    }

    // Wait for all agents to complete
    await Promise.all(dispatchPromises);

    const updatedRun = this.session.getTeamRun(run.id);
    if (updatedRun) {
      this.session.updateTeamRunProgress(updatedRun.id, {
        stage: "implement",
        stepCount: baseSeq + dispatchedCount,
      });
    }

    if (skippedAgents.length > 0) {
      this.logger.log("warn", "team.step_budget_exhausted", {
        runId: run.id,
        maxSteps: run.maxSteps,
        skippedAgents,
      });
    }

    return { skippedAgents, stepIdByAgent };
  }

  private async runMergePhase(run: TeamRun, notes: string[] = []): Promise<void> {
    const notePrefix = notes.length > 0 ? notes.join("\n") + "\n\n" : "";
    if (!this.worktreeManager) {
      // No worktree manager — skip merge, just mark done
      const msg = notePrefix + "Run completed (no worktree merge).";
      this.session.updateTeamRunProgress(run.id, { finalSummary: msg });
      this.session.updateTeamRunStatus(run.id, "done", {
        completedAt: new Date().toISOString(),
        finalSummary: msg,
      });
      this.restoreTeamAdapterModes();
      return;
    }

    this.session.updateTeamRunProgress(run.id, { stage: "finalize" });
    const state = this.getState();

    // Collect file changes per agent for user review (do NOT commit yet)
    const changeReport: string[] = [];
    for (const agent of state.availableAgents) {
      const wt = this.worktreeManager.getForAgent(agent);
      if (!wt) continue;

      try {
        const changes = this.getWorktreeReport(wt.path, wt.branch);
        if (changes.length > 0) {
          changeReport.push(`${agent} (${wt.branch}):\n  ${changes.join("\n  ")}`);
        }
      } catch (error: unknown) {
        this.logger.log("warn", "team.worktree_status_failed", {
          runId: run.id,
          agent,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (changeReport.length > 0) {
      const summary =
        notePrefix +
        "Agents completed. Files created/modified:\n\n" +
        changeReport.join("\n\n") +
        "\n\nUse /team approve to commit and merge, or /team stop to discard.";
      this.session.updateTeamRunProgress(run.id, { finalSummary: summary });
      this.session.updateTeamRunStatus(run.id, "waiting_user_input", { finalSummary: summary });
      this.restoreTeamAdapterModes();
    } else {
      // No file changes — nothing to approve, mark as done directly
      const noChangesMsg = notePrefix + "All agents completed (no file changes detected).";
      this.session.updateTeamRunProgress(run.id, { finalSummary: noChangesMsg });
      this.session.updateTeamRunStatus(run.id, "done", {
        completedAt: new Date().toISOString(),
        finalSummary: noChangesMsg,
      });
      this.restoreTeamAdapterModes();
      this.logger.log("info", "team.run_completed_no_changes", {
        roomId: run.roomId,
        runId: run.id,
      });
    }
  }

  private getWorktreeReport(wtPath: string, branch: string): string[] {
    const lines: string[] = [];

    // Uncommitted changes
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: wtPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (status) {
      for (const line of status.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) lines.push(`[uncommitted] ${trimmed}`);
      }
    }

    // Committed changes on this branch (files changed vs merge-base).
    // The merge-base must be computed in the main repo, where HEAD is the
    // base branch: inside the worktree HEAD *is* `branch`, so the merge-base
    // there always equals the branch tip and the diff comes back empty.
    try {
      const repoRoot = this.worktreeManager?.getRepoRoot() ?? wtPath;
      const mergeBase = execFileSync(
        "git",
        ["merge-base", "HEAD", branch],
        { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
      const committed = execFileSync(
        "git",
        ["diff", "--name-status", mergeBase, branch],
        { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
      if (committed) {
        for (const line of committed.split("\n")) {
          const trimmed = line.trim();
          if (trimmed) lines.push(`[committed] ${trimmed}`);
        }
      }
    } catch {
      // Branch comparison may fail; ignore
    }

    return lines;
  }

  private commitAndMergeWorktree(
    agent: string,
    goal: string,
  ): { merged: boolean; error?: string } {
    if (!this.worktreeManager) return { merged: false, error: "no worktree manager" };
    const wt = this.worktreeManager.getForAgent(agent);
    if (!wt) return { merged: false, error: "no worktree for agent" };

    // Commit any uncommitted changes in the agent's worktree branch
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: wt.path,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

    if (status) {
      try {
        execFileSync("git", ["add", "-A"], {
          cwd: wt.path,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        const shortGoal = goal.length > 60 ? goal.slice(0, 57) + "..." : goal;
        execFileSync(
          "git",
          ["commit", "-m", `feat(${agent}): ${shortGoal}`],
          {
            cwd: wt.path,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
      } catch (error: unknown) {
        return { merged: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    // Always attempt merge (agent may have committed its own changes)
    try {
      const result = this.worktreeManager.merge(agent);
      if (!result.success && result.conflicts) {
        return {
          merged: false,
          error: `Merge conflicts: ${result.conflicts.join(", ")}`,
        };
      }
      return { merged: true };
    } catch (error: unknown) {
      return { merged: false, error: error instanceof Error ? error.message : String(error) };
    }
  }


  private restoreTeamAdapterModes(): void {
    if (!this.teamAdapterConfigSnapshot) {
      return;
    }
    for (const [agent, snapshot] of Object.entries(this.teamAdapterConfigSnapshot)) {
      if (!snapshot) {
        continue;
      }
      const adapterConfig = this.config.adapterConfig[agent];
      if (!adapterConfig) {
        continue;
      }
      const restored: AdapterConfig = {
        ...adapterConfig,
        mode: snapshot.mode,
      };
      if (snapshot.hadWorkspaceCwd) {
        restored.workspaceCwd = snapshot.workspaceCwd;
        this.config.adapterConfig[agent] = restored;
      } else {
        const { workspaceCwd: _workspaceCwd, ...withoutWorkspace } = restored;
        this.config.adapterConfig[agent] = withoutWorkspace;
      }
    }
    this.teamAdapterConfigSnapshot = null;
  }

  private trackActiveTeamDispatch(
    runId: string,
    adapterName: string,
    requestId: string,
  ): void {
    let dispatches = this.teamActiveDispatchesByRun.get(runId);
    if (!dispatches) {
      dispatches = new Map<string, ActiveTeamDispatch>();
      this.teamActiveDispatchesByRun.set(runId, dispatches);
    }
    dispatches.set(requestId, {
      adapterName,
      requestId,
    });
  }

  private clearActiveTeamDispatch(runId: string, requestId: string): void {
    const dispatches = this.teamActiveDispatchesByRun.get(runId);
    if (!dispatches) {
      return;
    }
    dispatches.delete(requestId);
    if (dispatches.size === 0) {
      this.teamActiveDispatchesByRun.delete(runId);
    }
  }

  private consumeInterruptedRequest(requestId: string): boolean {
    if (!this.interruptedRequestIds.has(requestId)) {
      return false;
    }
    this.interruptedRequestIds.delete(requestId);
    return true;
  }

}

const execFileAsync = promisify(execFile);

/** Wall-clock limit for a single check command. */
const CHECK_TIMEOUT_MS = 120_000;
/** Cap persisted check output so one noisy command cannot bloat the DB. */
const CHECK_OUTPUT_LIMIT = 20_000;

interface CheckOutcome {
  /** "aborted" means the run was stopped mid-check; the result is not persisted. */
  status: "passed" | "failed" | "timeout" | "aborted";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

const truncateCheckOutput = (text: string): string =>
  text.length > CHECK_OUTPUT_LIMIT ? text.slice(0, CHECK_OUTPUT_LIMIT) + "\n[truncated]" : text;

/**
 * Executes one validated check command without a shell. Safe to split on
 * whitespace: validateCheckCommands rejects shell metacharacters, so every
 * token is a literal argument.
 */
const runCheckCommand = async (
  command: string,
  cwd: string,
  abortSignal?: AbortSignal,
): Promise<CheckOutcome> => {
  const [file, ...args] = command.split(/\s+/);
  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(file!, args, {
      cwd,
      timeout: CHECK_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf-8",
      signal: abortSignal,
    });
    return {
      status: "passed",
      exitCode: 0,
      stdout: truncateCheckOutput(stdout),
      stderr: truncateCheckOutput(stderr),
      durationMs: Date.now() - startedAt,
    };
  } catch (error: unknown) {
    const err = error as {
      code?: number | string;
      killed?: boolean;
      signal?: string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    if (abortSignal?.aborted) {
      return {
        status: "aborted",
        exitCode: null,
        stdout: "",
        stderr: "",
        durationMs: Date.now() - startedAt,
      };
    }
    const timedOut = err.killed === true || err.signal === "SIGTERM";
    return {
      status: timedOut ? "timeout" : "failed",
      exitCode: typeof err.code === "number" ? err.code : null,
      stdout: truncateCheckOutput(err.stdout ?? ""),
      stderr: truncateCheckOutput(err.stderr || (err.message ?? "")),
      durationMs: Date.now() - startedAt,
    };
  }
};

/** A successful step with at least this much output counts as progress. */
const MIN_PROGRESS_LENGTH = 80;

const isProgressOutput = (success: boolean, text: string): boolean =>
  success && text.trim().length >= MIN_PROGRESS_LENGTH;

const MENTION_PATTERN = /@([a-z0-9._-]+)/g;

const resolveMentionTargets = (
  text: string,
  availableAgents: string[],
): string[] => {
  const normalized = text.toLowerCase();
  const targets: string[] = [];
  for (const match of normalized.matchAll(MENTION_PATTERN)) {
    const mention = match[1];
    if (!mention) {
      continue;
    }
    if (mention === "all") {
      return [...availableAgents];
    }
    if (!availableAgents.includes(mention)) {
      continue;
    }
    if (targets.includes(mention)) {
      continue;
    }
    targets.push(mention);
  }
  return targets;
};

