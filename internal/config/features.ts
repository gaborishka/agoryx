/**
 * Feature flags for Agoryx.
 *
 * Simple in-process feature toggle. Flags default to OFF unless
 * explicitly enabled via setFeatureOverride() or environment variable
 * AGORYX_FEATURE_<FLAG_NAME>=1.
 */

export type FeatureFlag =
  | "CONTEXT_CACHE"
  | "MESSAGE_SNIPPING"
  | "FILE_CACHE"
  | "CONSOLIDATION";

const overrides = new Map<FeatureFlag, boolean>();

/**
 * Check if a feature flag is enabled.
 *
 * Resolution order:
 * 1. In-process override (setFeatureOverride)
 * 2. Environment variable AGORYX_FEATURE_<flag> === "1"
 * 3. Default: false
 */
export function isFeatureEnabled(flag: FeatureFlag): boolean {
  const override = overrides.get(flag);
  if (override !== undefined) return override;

  const envKey = `AGORYX_FEATURE_${flag}`;
  return process.env[envKey] === "1";
}

/**
 * Set an in-process override for a feature flag.
 * Useful for tests and programmatic toggling.
 */
export function setFeatureOverride(flag: FeatureFlag, enabled: boolean): void {
  overrides.set(flag, enabled);
}

/**
 * Clear a single feature override, falling back to env/default.
 */
export function clearFeatureOverride(flag: FeatureFlag): void {
  overrides.delete(flag);
}

/**
 * Clear all in-process overrides. Typically used in test teardown.
 */
export function clearAllFeatureOverrides(): void {
  overrides.clear();
}
