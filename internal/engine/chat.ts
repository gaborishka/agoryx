import type { Adapter } from "../adapters/adapter.js";
import type { ChatRuntimeConfig } from "../config/default.js";
import type { Message, OrchestrationMode, PinnedContext, Room } from "../events/types.js";
import type { MemoryService } from "../memory/service.js";
import type { WorktreeManager } from "../worktree/manager.js";
import { createPolicy } from "../orchestrator/factory.js";
import { SessionService } from "../session/service.js";
import { DispatchEngine } from "./dispatch-engine.js";
import { EngineLifecycle } from "./lifecycle.js";
import { createDefaultEngineLogger } from "./logger.js";
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
  private readonly team: TeamOrchestrator;
  private readonly lifecycle: EngineLifecycle;

  public constructor(
    private readonly session: SessionService,
    private readonly adapters: Record<string, Adapter>,
    private readonly config: ChatRuntimeConfig,
    private readonly hooks: ChatEngineHooks = {},
    private readonly memoryService?: MemoryService,
    private readonly worktreeManager?: WorktreeManager,
  ) {
    const logger = hooks.logger ?? createDefaultEngineLogger();

    this.dispatchEngine = new DispatchEngine({
      session: this.session,
      adapters: this.adapters,
      config: this.config,
      getState: () => this.getState(),
      onAdapterEvent: this.hooks.onAdapterEvent,
      logger,
      memoryService: this.memoryService,
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

    this.memoryService?.checkAndRecover(this.state.room.id);
    this.worktreeManager?.reconcile();

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

  public async shutdown(): Promise<void> {
    await this.lifecycle.shutdown();
  }

  public async processUserMessage(text: string): Promise<DispatchResult[]> {
    const state = this.getState();
    if (state.room.config.mode === "team") {
      return this.team.processTeamUserMessage(text);
    }

    const userMessage = this.session.saveUserMessage(state.room.id, text);
    const dispatches = state.policy
      .onUserMessage(state.room, userMessage, {
        availableAgents: state.availableAgents,
      })
      .sort((left, right) => left.priority - right.priority);

    const results: DispatchResult[] = [];
    for (const dispatch of dispatches) {
      results.push(await this.dispatchEngine.runDispatch(dispatch));
    }

    this.session.maybeCreateCheckpoint(state.room);
    return results;
  }

  public async retryFailed(adapterName: string): Promise<RetryResult | null> {
    return this.dispatchEngine.retryFailed(adapterName);
  }
}
