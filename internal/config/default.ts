import type { AdapterConfig } from "../adapters/adapter.js";
import type { OrchestrationMode, RoomConfig, TeamConfig } from "../events/types.js";

export interface ChatRuntimeConfig {
  dbPath: string;
  mode: OrchestrationMode;
  agents: string[];
  adapterConfig: Record<string, AdapterConfig>;
  roomConfig: RoomConfig;
  roomName: string;
  resumeRoomId?: string;
  agentSkills?: Record<string, string[]>;
  team: TeamConfig;
}

export const defaultRoomConfig = (mode: OrchestrationMode): RoomConfig => ({
  mode,
  checkpointThreshold: 50,
  maxHistoryMessages: 200,
  maxContextTokens: 30_000,
});

export const createDefaultAdapterConfig = (): Record<string, AdapterConfig> => ({
  codex: {
    mode: "cli",
    timeoutMs: 120_000,
    maxTokens: 4_000,
    systemPrompt: "You are a collaborative agent in a multi-agent room.",
  },
  claude: {
    mode: "cli",
    timeoutMs: 120_000,
    maxTokens: 4_000,
    systemPrompt: "You are a collaborative agent in a multi-agent room.",
  },
});

export const defaultTeamConfig = (): TeamConfig => ({
  profile: "enthusiast",
  maxSteps: 24,
  maxNoProgressSteps: 8,
  maxDurationMs: 3_600_000,
  checksEnabledByDefault: false,
  checkCommands: ["npm run typecheck", "npm test"],
  strict: {
    maxSteps: 8,
    maxNoProgressSteps: 2,
    maxDurationMs: 900_000,
    checksEnabledByDefault: true,
  },
  finalGate: "proposal",
  singleActive: true,
  trigger: {
    autoOnMessage: true,
    commandStart: true,
  },
});
