/**
 * Configuration management for Agoryx.
 *
 * Loads config from agoryx.json or uses sensible defaults.
 * Config file is optional — defaults work out of the box.
 */

import { readFileSync, existsSync } from "node:fs";
import type { OrchestrationMode, RoomConfig, TeamConfig } from "../events/types.js";
import type { AdapterConfig, AdapterMode } from "../adapters/adapter.js";
import { defaultTeamConfig, type ChatRuntimeConfig } from "./default.js";
import { type WorkspaceConfig, DEFAULT_WORKSPACE_CONFIG } from "../workspace/collector.js";
import { resolveConfigPathForLoad, resolveDefaultDbPath } from "./paths.js";
export type { WorkspaceConfig };
export { DEFAULT_WORKSPACE_CONFIG };

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

export interface AgentEntry {
  adapter: string;
  mode: AdapterMode;
  timeoutMs: number;
  maxTokens: number;
  systemPrompt?: string;
  skills?: string[];
  workspaceCwd?: string;
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
  team: {
    profile: "enthusiast" | "strict";
    maxSteps: number;
    maxNoProgressSteps: number;
    maxDurationMs: number;
    checksEnabledByDefault: boolean;
    checkCommands: string[];
    strict: {
      maxSteps: number;
      maxNoProgressSteps: number;
      maxDurationMs: number;
      checksEnabledByDefault: boolean;
    };
    finalGate: "proposal";
    singleActive: boolean;
    trigger: {
      autoOnMessage: boolean;
      commandStart: boolean;
    };
  };
  workspace: WorkspaceConfig;
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
      mode: "cli",
      timeoutMs: 120_000,
      maxTokens: 4096,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
    },
    claude: {
      adapter: "claude",
      mode: "cli",
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
    dbPath: resolveDefaultDbPath(),
  },
  team: defaultTeamConfig(),
  workspace: { ...DEFAULT_WORKSPACE_CONFIG },
};

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export function loadConfig(configPath?: string): AgoryxConfig {
  const path = resolveConfigPathForLoad(configPath);

  if (!existsSync(path)) {
    return structuredClone(DEFAULT_CONFIG);
  }

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<AgoryxConfig>;
    return mergeConfig(parsed);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load config from ${path}: ${detail}`);
  }
}

const AGENT_DEFAULTS: Omit<AgentEntry, "adapter"> = {
  mode: "stub",
  timeoutMs: 120_000,
  maxTokens: 4096,
};

export const DEFAULT_AGENT_SKILLS: Record<string, string[]> = {
  codex: ["code", "implement", "debug", "fix", "test", "refactor", "write"],
  claude: ["architecture", "review", "explain", "plan", "docs", "design", "analyze"],
};

function mergeAgents(
  defaults: Record<string, AgentEntry>,
  overrides?: Record<string, Partial<AgentEntry>>,
): Record<string, AgentEntry> {
  const result: Record<string, AgentEntry> = {};

  // Start with all default agents
  for (const [name, entry] of Object.entries(defaults)) {
    result[name] = structuredClone(entry);
  }

  if (!overrides) return result;

  // Deep-merge each agent override
  for (const [name, partial] of Object.entries(overrides)) {
    const base = result[name];
    if (base) {
      // Existing agent — merge fields
      result[name] = { ...base, ...partial } as AgentEntry;
    } else {
      // New agent — fill missing required fields from AGENT_DEFAULTS
      result[name] = {
        adapter: partial.adapter ?? name,
        ...AGENT_DEFAULTS,
        ...partial,
      } as AgentEntry;
    }
  }

  return result;
}

const CHECK_COMMAND_PATTERN = /^[a-zA-Z0-9_./-]+(\s+[^\s|;&`$()<>#]+)*$/;

function validateCheckCommands(commands: string[]): string[] {
  const valid: string[] = [];
  for (const cmd of commands) {
    const trimmed = cmd.trim();
    if (CHECK_COMMAND_PATTERN.test(trimmed)) {
      valid.push(trimmed);
    } else {
      console.error(
        `[config] Rejected check command with unsafe characters: ${trimmed.slice(0, 80)}`,
      );
    }
  }
  return valid;
}

function mergeConfig(partial: Partial<AgoryxConfig>): AgoryxConfig {
  const teamDefaults = DEFAULT_CONFIG.team;
  const teamTrigger = partial.team?.trigger;
  const strictDefaults = teamDefaults.strict;
  const strictOverrides = partial.team?.strict;
  return {
    version: partial.version ?? DEFAULT_CONFIG.version,
    defaultMode: partial.defaultMode ?? DEFAULT_CONFIG.defaultMode,
    agents: mergeAgents(DEFAULT_CONFIG.agents, partial.agents as Record<string, Partial<AgentEntry>> | undefined),
    context: { ...DEFAULT_CONFIG.context, ...partial.context },
    session: { ...DEFAULT_CONFIG.session, ...partial.session },
    team: {
      ...teamDefaults,
      ...partial.team,
      trigger: {
        ...teamDefaults.trigger,
        ...teamTrigger,
      },
      strict: {
        ...strictDefaults,
        ...strictOverrides,
      },
      checkCommands: validateCheckCommands(
        partial.team?.checkCommands?.filter((command) => command.trim().length > 0) ??
        teamDefaults.checkCommands,
      ),
    },
    workspace: { ...DEFAULT_WORKSPACE_CONFIG, ...partial.workspace },
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
    workspaceCwd: entry.workspaceCwd,
  };
}

// ---------------------------------------------------------------------------
// Skills resolution
// ---------------------------------------------------------------------------

export function resolveAgentSkills(
  config: AgoryxConfig,
  activeAgents?: string[],
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  const agents = activeAgents ?? Object.keys(config.agents);
  for (const name of agents) {
    const entry = config.agents[name];
    if (!entry) continue;
    const raw = entry.skills ?? DEFAULT_AGENT_SKILLS[name] ?? [];
    result[name] = raw.map((s) => s.trim().toLowerCase());
  }
  return result;
}

// ---------------------------------------------------------------------------
// Unified runtime config builder
// ---------------------------------------------------------------------------

/**
 * Convert AgoryxConfig into ChatRuntimeConfig that the engine consumes.
 *
 * This is the single entry-point for config → engine pipeline:
 *   loadConfig() → toRuntimeConfig() → new ChatEngine(session, adapters, runtimeConfig)
 *
 * @param config - loaded AgoryxConfig (from file or defaults)
 * @param overrides - optional CLI overrides (roomName, resumeRoomId, agent list)
 */
export function toRuntimeConfig(
  config: AgoryxConfig,
  overrides: {
    roomName?: string;
    resumeRoomId?: string;
    agents?: string[];
  } = {},
): ChatRuntimeConfig {
  const agentNames = overrides.agents ?? Object.keys(config.agents);

  const adapterConfig: Record<string, AdapterConfig> = {};
  for (const name of agentNames) {
    adapterConfig[name] = getAdapterConfig(config, name);
  }

  return {
    dbPath: config.session.dbPath,
    mode: config.defaultMode,
    agents: agentNames,
    adapterConfig,
    roomConfig: toRoomConfig(config),
    roomName: overrides.roomName ?? "default",
    resumeRoomId: overrides.resumeRoomId,
    agentSkills: resolveAgentSkills(config, agentNames),
    team: toTeamConfig(config),
    workspace: { ...config.workspace },
  };
}

function toTeamConfig(config: AgoryxConfig): TeamConfig {
  return {
    profile: config.team.profile,
    maxSteps: config.team.maxSteps,
    maxNoProgressSteps: config.team.maxNoProgressSteps,
    maxDurationMs: config.team.maxDurationMs,
    checksEnabledByDefault: config.team.checksEnabledByDefault,
    checkCommands: [...config.team.checkCommands],
    strict: {
      maxSteps: config.team.strict.maxSteps,
      maxNoProgressSteps: config.team.strict.maxNoProgressSteps,
      maxDurationMs: config.team.strict.maxDurationMs,
      checksEnabledByDefault: config.team.strict.checksEnabledByDefault,
    },
    finalGate: "proposal",
    singleActive: config.team.singleActive,
    trigger: {
      autoOnMessage: config.team.trigger.autoOnMessage,
      commandStart: config.team.trigger.commandStart,
    },
  };
}
