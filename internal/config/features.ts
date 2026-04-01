/**
 * Feature flags for gating new functionality.
 *
 * Flags default to `false` so existing behaviour is unchanged
 * until explicitly opted in via environment variables.
 */

export type FeatureFlag = "HOOK_SYSTEM" | "RISK_LEVELS";

const ENV_PREFIX = "AGORYX_FF_";

const FLAG_DEFAULTS: Record<FeatureFlag, boolean> = {
  HOOK_SYSTEM: false,
  RISK_LEVELS: false,
};

/**
 * Runtime override map.  Tests and internal code can call
 * `setFeatureEnabled` to flip flags without touching env vars.
 */
const overrides = new Map<FeatureFlag, boolean>();

export function isFeatureEnabled(flag: FeatureFlag): boolean {
  if (overrides.has(flag)) {
    return overrides.get(flag)!;
  }
  const envValue = process.env[`${ENV_PREFIX}${flag}`];
  if (envValue !== undefined) {
    return envValue === "1" || envValue.toLowerCase() === "true";
  }
  return FLAG_DEFAULTS[flag];
}

/** Programmatic override — mainly for tests. */
export function setFeatureEnabled(flag: FeatureFlag, enabled: boolean): void {
  overrides.set(flag, enabled);
}

/** Clear all programmatic overrides. */
export function resetFeatureFlags(): void {
  overrides.clear();
}
