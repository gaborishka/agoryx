import type { RiskLevel } from "./risk-classifier.js";

export type AutoApprovePolicy = "none" | "low" | "medium" | "all";

/** Determine if a request should be auto-approved based on policy. */
export function shouldAutoApprove(
  level: RiskLevel,
  policy: AutoApprovePolicy,
): boolean {
  if (policy === "none") return false;
  if (policy === "all") return true;
  if (policy === "low") return level === "low";
  if (policy === "medium") return level === "low" || level === "medium";
  return false;
}
