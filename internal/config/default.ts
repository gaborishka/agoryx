import type { AdapterConfig } from "../adapters/adapter.js";
import type { OrchestrationMode, RoomConfig } from "../events/types.js";

export interface ChatRuntimeConfig {
  dbPath: string;
  mode: OrchestrationMode;
  agents: string[];
  adapterConfig: Record<string, AdapterConfig>;
  roomConfig: RoomConfig;
  roomName: string;
  resumeRoomId?: string;
}

export const defaultRoomConfig = (mode: OrchestrationMode): RoomConfig => ({
  mode,
  checkpointThreshold: 50,
  maxHistoryMessages: 200,
  maxContextTokens: 30_000,
});

export const createDefaultAdapterConfig = (): Record<string, AdapterConfig> => ({
  codex: {
    mode: "stub",
    timeoutMs: 120_000,
    maxTokens: 4_000,
    systemPrompt: "You are a collaborative agent in a multi-agent room.",
  },
  claude: {
    mode: "stub",
    timeoutMs: 120_000,
    maxTokens: 4_000,
    systemPrompt: "You are a collaborative agent in a multi-agent room.",
  },
});
