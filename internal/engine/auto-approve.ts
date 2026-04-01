/**
 * Auto-approve policy for risk-classified approval requests.
 *
 * Determines whether a given risk level should be auto-approved
 * based on the configured policy threshold.
 */

import type { RiskLevel } from "./risk-classifier.js";

/**
 * - "none"   — never auto-approve (manual review for everything)
 * - "low"    — auto-approve only low-risk actions
 * - "medium" — auto-approve low and medium-risk actions
 * - "all"    — auto-approve everything (dangerous, for trusted envs)
 */
export type AutoApprovePolicy = "none" | "low" | "medium" | "all";

const RISK_ORDER: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

const POLICY_THRESHOLD: Record<AutoApprovePolicy, number> = {
  none: -1,   // nothing passes
  low: 0,     // only low
  medium: 1,  // low + medium
  all: 2,     // everything
};

export function shouldAutoApprove(
  level: RiskLevel,
  policy: AutoApprovePolicy,
): boolean {
  if (policy === "none") {
    return false;
  }
  return RISK_ORDER[level] <= POLICY_THRESHOLD[policy];
}
