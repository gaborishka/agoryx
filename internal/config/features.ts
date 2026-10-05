/**
 * Runtime feature flags.
 *
 * Flags can be set via:
 *  1. Environment variable: AGORYX_FF_<FLAG_NAME>=1
 *  2. Programmatic override (for tests)
 *  3. Defaults defined here
 */

export type FeatureFlag =
  | "GEMINI_ADAPTER"      // future adapter
  | "OLLAMA_ADAPTER"      // future adapter
  | "MCP_INTEGRATION"     // MCP protocol support
  | "CONTEXT_CACHE"       // static/dynamic context split
  | "MESSAGE_SNIPPING"    // auto-compress old messages
  | "DREAM_CONSOLIDATION" // background memory consolidation
  | "HOOK_SYSTEM"         // dispatch hooks
  | "RISK_LEVELS";        // approval risk classification

const DEFAULTS: Record<FeatureFlag, boolean> = {
  GEMINI_ADAPTER: false,
  OLLAMA_ADAPTER: false,
  MCP_INTEGRATION: false,
  CONTEXT_CACHE: false,
  MESSAGE_SNIPPING: false,
  DREAM_CONSOLIDATION: false,
  HOOK_SYSTEM: false,
  RISK_LEVELS: false,
};

const overrides = new Map<FeatureFlag, boolean>();

/** Check if a feature is enabled. */
export function isFeatureEnabled(flag: FeatureFlag): boolean {
  // Programmatic override first
  if (overrides.has(flag)) return overrides.get(flag)!;
  // Environment variable
  const envKey = `AGORYX_FF_${flag}`;
  const envVal = process.env[envKey];
  if (envVal !== undefined) return envVal === "1" || envVal === "true";
  // Default
  return DEFAULTS[flag];
}

/** Set a programmatic override (useful for tests). */
export function setFeatureOverride(flag: FeatureFlag, enabled: boolean): void {
  overrides.set(flag, enabled);
}

/** Clear a specific override. */
export function clearFeatureOverride(flag: FeatureFlag): void {
  overrides.delete(flag);
}

/** Clear all overrides. */
export function clearAllFeatureOverrides(): void {
  overrides.clear();
}

/** List all flags with their current resolved values. */
export function listFeatureFlags(): Record<FeatureFlag, boolean> {
  const result = { ...DEFAULTS };
  for (const flag of Object.keys(result) as FeatureFlag[]) {
    result[flag] = isFeatureEnabled(flag);
  }
  return result;
}
