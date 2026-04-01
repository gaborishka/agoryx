/**
 * ApprovalQueue — holds pending approval requests for human review.
 *
 * When RISK_LEVELS is enabled, incoming requests are classified and
 * optionally auto-approved based on the configured policy.
 */

import { classifyApprovalRequest } from "./risk-classifier.js";
import type { ApprovalRequest } from "./risk-classifier.js";
import type { RiskLevel } from "./risk-classifier.js";
import { shouldAutoApprove, type AutoApprovePolicy } from "./auto-approve.js";
import { isFeatureEnabled } from "../config/features.js";

export type { ApprovalRequest } from "./risk-classifier.js";

export interface ApprovalQueueItem {
  request: ApprovalRequest;
  respond: (decision: string) => void;
  riskLevel?: RiskLevel;
  riskReason?: string;
}

export class ApprovalQueue {
  private readonly queue: ApprovalQueueItem[] = [];
  private autoApprovePolicy: AutoApprovePolicy = "none";

  public setAutoApprovePolicy(policy: AutoApprovePolicy): void {
    this.autoApprovePolicy = policy;
  }

  public getAutoApprovePolicy(): AutoApprovePolicy {
    return this.autoApprovePolicy;
  }

  public enqueue(request: ApprovalRequest, respond: (decision: string) => void): void {
    // Risk-based auto-approve (when feature enabled)
    if (isFeatureEnabled("RISK_LEVELS") && this.autoApprovePolicy !== "none") {
      const assessment = classifyApprovalRequest(request);
      if (shouldAutoApprove(assessment.level, this.autoApprovePolicy)) {
        respond("allow");
        return;
      }
    }

    // Classify and attach risk info when feature enabled
    const item: ApprovalQueueItem = { request, respond };
    if (isFeatureEnabled("RISK_LEVELS")) {
      const assessment = classifyApprovalRequest(request);
      item.riskLevel = assessment.level;
      item.riskReason = assessment.reason;
    }

    this.queue.push(item);
  }

  public pending(): readonly ApprovalQueueItem[] {
    return this.queue;
  }

  public size(): number {
    return this.queue.length;
  }

  public dequeue(): ApprovalQueueItem | undefined {
    return this.queue.shift();
  }

  public clear(): void {
    this.queue.length = 0;
  }
}
