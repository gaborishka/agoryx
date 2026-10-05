import type { Adapter } from "../adapters/adapter.js";
import { ApprovalQueue } from "./approval-queue.js";
import type { ChatRuntimeConfig } from "../config/default.js";
import type { Message, OrchestrationMode, PinnedContext, Room } from "../events/types.js";
import { isPassResponse } from "../events/pass-token.js";
import type { MemoryService } from "../memory/service.js";
import type { Dispatch } from "../orchestrator/policy.js";
import type { WorktreeManager } from "../worktree/manager.js";
import { createPolicy } from "../orchestrator/factory.js";
import { SessionService } from "../session/service.js";
import { DispatchEngine } from "./dispatch-engine.js";
import { HookRegistry } from "./hooks.js";
import { EngineLifecycle } from "./lifecycle.js";
import type { EngineShutdownReport } from "./lifecycle.js";
import { createDefaultEngineLogger } from "./logger.js";
import type { EngineLogger } from "./logger.js";
import { TeamOrchestrator } from "./team-orchestrator.js";
import type {
  ChatEngineHooks,
  DispatchResult,
  EngineState,
  RetryResult,
  TeamInterruptResult,
  TeamLogResult,
  TeamStatusResult,
} from "./types.js";

interface FreeDispatchQueueItem {
  dispatch: Dispatch;
  triggerMessage: Message | null;
  repeatMode: FreeRepeatMode;
}

type FreeRepeatMode = "none" | "handoff" | "rebuttal";

const FREE_HANDOFF_REASON_PREFIX = "free:agent:handoff:";
const FREE_REBUTTAL_REASON_PREFIX = "free:agent:rebuttal:";
const FREE_HANDOFF_REPEAT_LIMIT = 2;

const normalizeAgentAuthor = (author: string): string =>
  author.toLowerCase().replace(/^agent\./, "");

const getFreeRepeatMode = (dispatch: Dispatch): FreeRepeatMode => {
  if (dispatch.reason.startsWith(FREE_REBUTTAL_REASON_PREFIX)) {
    return "rebuttal";
  }
  if (dispatch.reason.startsWith(FREE_HANDOFF_REASON_PREFIX)) {
    return "handoff";
  }
  return "none";
};

const shouldUpgradeRepeatMode = (
  current: FreeRepeatMode,
  incoming: FreeRepeatMode,
): boolean => {
  const rank: Record<FreeRepeatMode, number> = {
    none: 0,
    handoff: 1,
    rebuttal: 2,
  };
  return rank[incoming] > rank[current];
};

const buildFreeTriggerFingerprint = (text: string): string =>
  text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

export type {
  ChatEngineHooks,
  DispatchResult,
  RetryResult,
  TeamStatusResult,
  TeamLogResult,
  TeamInterruptResult,
} from "./types.js";

export class ChatEngine {
  private state: EngineState | null = null;
  private readonly dispatchEngine: DispatchEngine;
  private readonly hookRegistry: HookRegistry;
  private readonly team: TeamOrchestrator;
  private readonly lifecycle: EngineLifecycle;
  private readonly logger: EngineLogger;
  private readonly approvalQueue: ApprovalQueue;

  public constructor(
    private readonly session: SessionService,
    private readonly adapters: Record<string, Adapter>,
    private readonly config: ChatRuntimeConfig,
    private readonly hooks: ChatEngineHooks = {},
    private readonly memoryService?: MemoryService,
    private readonly worktreeManager?: WorktreeManager,
  ) {
    const logger = hooks.logger ?? createDefaultEngineLogger();
    this.logger = logger;
    this.approvalQueue = new ApprovalQueue();

    this.hookRegistry = new HookRegistry();

    this.dispatchEngine = new DispatchEngine({
      session: this.session,
      adapters: this.adapters,
      config: this.config,
      getState: () => this.getState(),
      onAdapterEvent: this.hooks.onAdapterEvent,
      logger,
      memoryService: this.memoryService,
      approvalQueue: this.approvalQueue,
      hookRegistry: this.hookRegistry,
    });

    this.team = new TeamOrchestrator({
      session: this.session,
      adapters: this.adapters,
      config: this.config,
      getState: () => this.getState(),
      setState: (next) => {
        this.state = next;
      },
      dispatchApi: this.dispatchEngine,
      hooks: this.hooks,
      logger,
      memoryService: this.memoryService,
      worktreeManager: this.worktreeManager,
    });

    this.lifecycle = new EngineLifecycle({
      session: this.session,
      adapters: this.adapters,
      getState: () => this.state,
      team: this.team,
      logger,
    });
  }

  public getApprovalQueue(): ApprovalQueue {
    return this.approvalQueue;
  }

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

    this.state = {
      room: created.room,
      sessionId: created.sessionId,
      policy: createPolicy(created.room.config.mode, {
        agentSkills: this.config.agentSkills,
      }),
      availableAgents: enabledAgents,
    };

    if (this.memoryService) {
      try {
        this.memoryService.checkAndRecover(this.state.room.id);
      } catch (error: unknown) {
        this.logger.log("warn", "engine.init_memory_recovery_failed", {
          roomId: this.state.room.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (this.worktreeManager) {
      try {
        this.worktreeManager.reconcile();
      } catch (error: unknown) {
        this.logger.log("warn", "engine.init_worktree_reconcile_failed", {
          roomId: this.state.room.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

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

  public getHookRegistry(): HookRegistry {
    return this.hookRegistry;
  }

  public setMode(mode: OrchestrationMode): OrchestrationMode {
    const current = this.getState();
    if (current.room.config.mode === "team" && mode !== "team") {
      this.lifecycle.stopActiveTeamRunOnModeExit(current.room.id);
    }

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
    return this.dispatchEngine.getLastFailedRequest(adapter);
  }

  public startTeamRun(
    goal: string,
    options: { strict?: boolean; checksEnabled?: boolean; createdBy?: string } = {},
  ) {
    return this.team.startRun(goal, options);
  }

  public teamStatus(runId?: string): TeamStatusResult | null {
    return this.team.status(runId);
  }

  public consumeTeamRunStartWarnings(runId: string): string[] {
    return this.team.consumeRunStartWarnings(runId);
  }

  public teamLog(limit = 20, runId?: string): TeamLogResult | null {
    return this.team.log(limit, runId);
  }

  public teamResume() {
    return this.team.resume();
  }

  public teamApprove(runId?: string) {
    return this.team.approve(runId);
  }

  public teamStop(runId?: string) {
    return this.team.stop(runId);
  }

  public interruptTeamRun(
    feedbackText?: string,
    runId?: string,
  ): Promise<TeamInterruptResult | null> {
    return this.team.interrupt(feedbackText, runId);
  }

  public queueTeamFeedback(text: string) {
    return this.team.queueFeedback(text);
  }

  public async shutdown(): Promise<EngineShutdownReport> {
    return this.lifecycle.shutdown();
  }

  public async processUserMessage(text: string): Promise<DispatchResult[]> {
    const state = this.getState();

    // @team <goal> triggers a team run from any mode (if no run is active)
    const teamMention = text.match(/^@team\s+(.+)/is);
    if (teamMention) {
      const goal = teamMention[1]!.trim();
      const activeRun = this.session.getActiveTeamRun(state.room.id);
      if (goal && !activeRun) {
        this.session.saveUserMessage(state.room.id, text);
        this.startTeamRun(goal);
        return [];
      }
      // If there's an active run, fall through to team message handling
    }

    if (state.room.config.mode === "team") {
      return this.team.processTeamUserMessage(text);
    }

    const userMessage = this.session.saveUserMessage(state.room.id, text);
    const dispatches = state.policy
      .onUserMessage(state.room, userMessage, {
        availableAgents: state.availableAgents,
      })
      .sort((left, right) => left.priority - right.priority);

    const results = state.room.config.mode === "free"
      ? await this.processFreeDispatches(dispatches)
      : await this.processDispatches(dispatches);

    this.session.maybeCreateCheckpoint(state.room);
    return results;
  }

  public async retryFailed(adapterName: string): Promise<RetryResult | null> {
    return this.dispatchEngine.retryFailed(adapterName);
  }

  private async processDispatches(dispatches: Dispatch[]): Promise<DispatchResult[]> {
    const results: DispatchResult[] = [];
    for (const dispatch of dispatches) {
      results.push(await this.dispatchEngine.runDispatch(dispatch));
    }
    return results;
  }

  private async processFreeDispatches(initialDispatches: Dispatch[]): Promise<DispatchResult[]> {
    const state = this.getState();
    const queue: FreeDispatchQueueItem[] = initialDispatches.map((dispatch) => ({
      dispatch,
      triggerMessage: null,
      repeatMode: "none",
    }));
    const results: DispatchResult[] = [];
    const completedTurnsByAgent = new Map<string, number>();
    const lastRepeatTriggerByAgent = new Map<string, string>();

    while (queue.length > 0) {
      const queued = queue.shift();
      if (!queued) {
        continue;
      }
      const { dispatch, triggerMessage, repeatMode } = queued;

      if (!this.shouldRunFreeDispatch(
        dispatch.targetAdapter,
        triggerMessage,
        repeatMode,
        completedTurnsByAgent,
        lastRepeatTriggerByAgent,
      )) {
        continue;
      }

      const result = await this.dispatchEngine.runDispatch(dispatch);
      results.push(result);
      if (!result.success) {
        continue;
      }

      const recent = this.session.listRecentMessages(state.room.id, 1)[0];
      if (!recent || recent.role !== "assistant") {
        continue;
      }
      if (recent.metadata.requestId && recent.metadata.requestId !== result.requestId) {
        continue;
      }
      if (isPassResponse(recent.text)) {
        continue;
      }
      completedTurnsByAgent.set(
        dispatch.targetAdapter,
        (completedTurnsByAgent.get(dispatch.targetAdapter) ?? 0) + 1,
      );
      if (repeatMode !== "none" && triggerMessage) {
        lastRepeatTriggerByAgent.set(
          dispatch.targetAdapter,
          buildFreeTriggerFingerprint(triggerMessage.text),
        );
      }

      const followUps = state.policy
        .onAgentMessage(state.room, recent, {
          availableAgents: state.availableAgents,
        })
        .sort((left, right) => left.priority - right.priority);
      this.enqueueUniqueTargets(queue, followUps, recent);
    }

    return results;
  }

  private shouldRunFreeDispatch(
    targetAdapter: string,
    triggerMessage: Message | null,
    repeatMode: FreeRepeatMode,
    completedTurnsByAgent: Map<string, number>,
    lastRepeatTriggerByAgent: Map<string, string>,
  ): boolean {
    const completedTurns = completedTurnsByAgent.get(targetAdapter) ?? 0;
    if (completedTurns === 0) {
      return true;
    }
    if (!triggerMessage || repeatMode === "none") {
      return false;
    }
    if (normalizeAgentAuthor(triggerMessage.author) === targetAdapter.toLowerCase()) {
      return false;
    }
    if (repeatMode === "handoff" && completedTurns >= FREE_HANDOFF_REPEAT_LIMIT) {
      return false;
    }
    const fingerprint = buildFreeTriggerFingerprint(triggerMessage.text);
    if (!fingerprint) {
      return false;
    }
    return lastRepeatTriggerByAgent.get(targetAdapter) !== fingerprint;
  }

  private enqueueUniqueTargets(
    queue: FreeDispatchQueueItem[],
    followUps: Dispatch[],
    triggerMessage: Message,
  ): void {
    for (const followUp of followUps) {
      const repeatMode = getFreeRepeatMode(followUp);
      const existing = queue.find(
        (pending) => pending.dispatch.targetAdapter === followUp.targetAdapter,
      );
      if (existing) {
        if (shouldUpgradeRepeatMode(existing.repeatMode, repeatMode)) {
          existing.repeatMode = repeatMode;
          existing.dispatch = followUp;
          existing.triggerMessage = triggerMessage;
        }
        continue;
      }
      queue.push({
        dispatch: followUp,
        triggerMessage,
        repeatMode,
      });
    }
  }
}
