/**
 * Risk classifier for approval requests.
 *
 * Assigns a risk level based on heuristics about what the
 * adapter is being asked to do, so the UI can surface colour
 * indicators and auto-approve low-risk items.
 */

export type RiskLevel = "low" | "medium" | "high";

export interface RiskAssessment {
  level: RiskLevel;
  reason: string;
}

export interface ApprovalRequest {
  adapter: string;
  action: string;
  description?: string;
}

const HIGH_RISK_ACTIONS = new Set([
  "delete",
  "drop",
  "remove",
  "destroy",
  "reset",
  "force-push",
  "truncate",
]);

const MEDIUM_RISK_ACTIONS = new Set([
  "write",
  "update",
  "patch",
  "install",
  "execute",
  "run",
  "exec",
]);

export function classifyApprovalRequest(request: ApprovalRequest): RiskAssessment {
  const action = request.action.toLowerCase();

  if (HIGH_RISK_ACTIONS.has(action)) {
    return { level: "high", reason: `Action "${action}" is destructive` };
  }

  if (MEDIUM_RISK_ACTIONS.has(action)) {
    return { level: "medium", reason: `Action "${action}" modifies state` };
  }

  return { level: "low", reason: "Action is read-only or informational" };
}
