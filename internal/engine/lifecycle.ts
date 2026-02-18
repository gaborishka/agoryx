import type { Adapter, PersistentAdapter } from "../adapters/adapter.js";
import { SessionService } from "../session/service.js";
import type { EngineLogger } from "./logger.js";
import type { EngineState } from "./types.js";
import { TeamOrchestrator } from "./team-orchestrator.js";

interface EngineLifecycleOptions {
  session: SessionService;
  adapters: Record<string, Adapter>;
  getState: () => EngineState | null;
  team: TeamOrchestrator;
  logger: EngineLogger;
}

export class EngineLifecycle {
  private readonly session: SessionService;
  private readonly adapters: Record<string, Adapter>;
  private readonly getState: () => EngineState | null;
  private readonly team: TeamOrchestrator;
  private readonly logger: EngineLogger;

  public constructor(options: EngineLifecycleOptions) {
    this.session = options.session;
    this.adapters = options.adapters;
    this.getState = options.getState;
    this.team = options.team;
    this.logger = options.logger;
  }

  public stopActiveTeamRunOnModeExit(roomId: string): void {
    const run = this.session.getActiveTeamRun(roomId);
    if (run?.status === "active") {
      this.team.stop(run.id);
    }
  }

  public async shutdown(): Promise<void> {
    const state = this.getState();
    if (!state) {
      return;
    }

    await this.team.stopActiveRunForRoom(state.room.id);
    await this.team.waitForRoomLoop(state.room.id);

    const agentSessions = this.session.listActiveAgentSessions(state.room.id);
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
      const results = await Promise.allSettled(destroyOps);
      const failed = results.filter((result) => result.status === "rejected").length;
      if (failed > 0) {
        this.logger.log("warn", "engine.shutdown_destroy_failures", {
          roomId: state.room.id,
          failed,
          total: destroyOps.length,
        });
      }
    }

    this.logger.log("info", "engine.shutdown_complete", {
      roomId: state.room.id,
    });
  }
}
