/**
 * Configuration management for Agoryx.
 *
 * Loads config from agoryx.json or uses sensible defaults.
 * Config file is optional — defaults work out of the box.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { OrchestrationMode, RoomConfig } from "../events/types.js";
import type { AdapterConfig, AdapterMode } from "../adapters/adapter.js";

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

export interface AgentEntry {
  adapter: string;
  mode: AdapterMode;
  timeoutMs: number;
  maxTokens: number;
  systemPrompt?: string;
}

export interface AgoryxConfig {
  version: string;
  defaultMode: OrchestrationMode;
  agents: Record<string, AgentEntry>;
  context: {
    maxHistoryMessages: number;
    checkpointThreshold: number;
    maxContextTokens: number;
  };
  session: {
    dbPath: string;
  };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_SYSTEM_PROMPT =
  "You are a collaborative participant in a multi-agent group discussion. " +
  "Other AI agents are also participating. Read the full conversation history " +
  "and respond thoughtfully, building on or respectfully challenging what others have said.";

export const DEFAULT_CONFIG: AgoryxConfig = {
  version: "0.1",
  defaultMode: "manual",
  agents: {
    codex: {
      adapter: "codex",
      mode: "stub",
      timeoutMs: 120_000,
      maxTokens: 4096,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
    },
    claude: {
      adapter: "claude",
      mode: "stub",
      timeoutMs: 120_000,
      maxTokens: 4096,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
    },
  },
  context: {
    maxHistoryMessages: 100,
    checkpointThreshold: 50,
    maxContextTokens: 30_000,
  },
  session: {
    dbPath: "./agoryx.db",
  },
};

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export function loadConfig(configPath?: string): AgoryxConfig {
  const path = configPath ?? resolve(process.cwd(), "agoryx.json");

  if (!existsSync(path)) {
    return structuredClone(DEFAULT_CONFIG);
  }

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<AgoryxConfig>;
    return mergeConfig(parsed);
  } catch (err) {
    console.warn(`[config] Failed to load ${path}, using defaults:`, err);
    return structuredClone(DEFAULT_CONFIG);
  }
}

function mergeConfig(partial: Partial<AgoryxConfig>): AgoryxConfig {
  return {
    version: partial.version ?? DEFAULT_CONFIG.version,
    defaultMode: partial.defaultMode ?? DEFAULT_CONFIG.defaultMode,
    agents: { ...DEFAULT_CONFIG.agents, ...partial.agents },
    context: { ...DEFAULT_CONFIG.context, ...partial.context },
    session: { ...DEFAULT_CONFIG.session, ...partial.session },
  };
}

/**
 * Convert AgoryxConfig to RoomConfig for room creation.
 */
export function toRoomConfig(config: AgoryxConfig): RoomConfig {
  return {
    mode: config.defaultMode,
    checkpointThreshold: config.context.checkpointThreshold,
    maxHistoryMessages: config.context.maxHistoryMessages,
    maxContextTokens: config.context.maxContextTokens,
  };
}

/**
 * Get adapter config for a named agent.
 */
export function getAdapterConfig(
  config: AgoryxConfig,
  agentName: string,
): AdapterConfig {
  const entry = config.agents[agentName];
  if (!entry) {
    throw new Error(`No agent config found for: ${agentName}`);
  }
  return {
    mode: entry.mode,
    timeoutMs: entry.timeoutMs,
    maxTokens: entry.maxTokens,
    systemPrompt: entry.systemPrompt,
  };
}
