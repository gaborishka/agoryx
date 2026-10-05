import type { ApprovalRequest } from "../adapters/adapter.js";
import { classifyApprovalRequest, type RiskLevel } from "./risk-classifier.js";
import { shouldAutoApprove, type AutoApprovePolicy } from "./auto-approve.js";
import { isFeatureEnabled } from "../config/features.js";

export interface ApprovalQueueItem {
  request: ApprovalRequest;
  respond: (decision: string) => void;
  riskLevel?: RiskLevel;
  riskReason?: string;
}

type PresentCallback = (item: ApprovalQueueItem) => void;
type ClearCallback = () => void;

export class ApprovalQueue {
  private queue: ApprovalQueueItem[] = [];
  private activeItem: ApprovalQueueItem | null = null;
  private onPresent: PresentCallback = () => {};
  private onClear: ClearCallback = () => {};
  private autoApprovePolicy: AutoApprovePolicy = "none";

  public setCallbacks(onPresent: PresentCallback, onClear: ClearCallback): void {
    this.onPresent = onPresent;
    this.onClear = onClear;
  }

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

    const item: ApprovalQueueItem = { request, respond };

    // Classify and attach risk info when feature enabled
    if (isFeatureEnabled("RISK_LEVELS")) {
      const assessment = classifyApprovalRequest(request);
      item.riskLevel = assessment.level;
      item.riskReason = assessment.reason;
    }

    if (!this.activeItem) {
      this.activeItem = item;
      this.onPresent(item);
    } else {
      this.queue.push(item);
    }
  }

  public respondToActive(decision: string): void {
    if (!this.activeItem) {
      return;
    }
    const item = this.activeItem;
    this.activeItem = null;
    item.respond(decision);
    this.advance();
  }

  public rejectAll(): void {
    if (this.activeItem) {
      this.activeItem.respond("cancel");
      this.activeItem = null;
    }
    for (const item of this.queue) {
      item.respond("cancel");
    }
    this.queue = [];
    this.onClear();
  }

  public get pending(): number {
    return this.queue.length + (this.activeItem ? 1 : 0);
  }

  public get active(): ApprovalQueueItem | null {
    return this.activeItem;
  }

  private advance(): void {
    const next = this.queue.shift();
    if (next) {
      this.activeItem = next;
      this.onPresent(next);
    } else {
      this.onClear();
    }
  }
}
