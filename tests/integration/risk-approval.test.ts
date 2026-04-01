import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  setFeatureEnabled,
  resetFeatureFlags,
} from "../../internal/config/features.js";
import { ApprovalQueue } from "../../internal/engine/approval-queue.js";
import type { ApprovalRequest } from "../../internal/engine/approval-queue.js";

describe("ApprovalQueue risk classification integration", () => {
  beforeEach(() => {
    resetFeatureFlags();
  });

  afterEach(() => {
    resetFeatureFlags();
  });

  it("auto-approves LOW risk request with 'low' policy", () => {
    setFeatureEnabled("RISK_LEVELS", true);
    const queue = new ApprovalQueue();
    queue.setAutoApprovePolicy("low");

    const decisions: string[] = [];
    const request: ApprovalRequest = {
      adapter: "codex",
      action: "read",
      description: "Read a file",
    };

    queue.enqueue(request, (decision) => {
      decisions.push(decision);
    });

    // Should have been auto-approved — not in queue
    assert.equal(queue.size(), 0);
    assert.deepEqual(decisions, ["allow"]);
  });

  it("does NOT auto-approve HIGH risk request with 'low' policy", () => {
    setFeatureEnabled("RISK_LEVELS", true);
    const queue = new ApprovalQueue();
    queue.setAutoApprovePolicy("low");

    const decisions: string[] = [];
    const request: ApprovalRequest = {
      adapter: "codex",
      action: "delete",
      description: "Delete a database table",
    };

    queue.enqueue(request, (decision) => {
      decisions.push(decision);
    });

    // Should NOT have been auto-approved — remains in queue
    assert.equal(queue.size(), 1);
    assert.deepEqual(decisions, []);
  });

  it("attaches risk level to queued item when RISK_LEVELS enabled", () => {
    setFeatureEnabled("RISK_LEVELS", true);
    const queue = new ApprovalQueue();
    // autoApprovePolicy = "none" so nothing is auto-approved
    queue.setAutoApprovePolicy("none");

    const request: ApprovalRequest = {
      adapter: "codex",
      action: "delete",
      description: "Drop a table",
    };

    queue.enqueue(request, () => {});

    assert.equal(queue.size(), 1);
    const items = queue.pending();
    assert.equal(items[0]?.riskLevel, "high");
    assert.ok(items[0]?.riskReason);
    assert.match(items[0]!.riskReason!, /destructive/i);
  });

  it("does NOT classify risk when RISK_LEVELS feature is disabled", () => {
    setFeatureEnabled("RISK_LEVELS", false);
    const queue = new ApprovalQueue();
    queue.setAutoApprovePolicy("low");

    const decisions: string[] = [];
    const request: ApprovalRequest = {
      adapter: "codex",
      action: "read",
      description: "Read a file",
    };

    queue.enqueue(request, (decision) => {
      decisions.push(decision);
    });

    // With feature disabled: no auto-approve, no risk classification
    assert.equal(queue.size(), 1);
    assert.deepEqual(decisions, []);
    const items = queue.pending();
    assert.equal(items[0]?.riskLevel, undefined);
    assert.equal(items[0]?.riskReason, undefined);
  });

  it("auto-approves MEDIUM risk with 'medium' policy", () => {
    setFeatureEnabled("RISK_LEVELS", true);
    const queue = new ApprovalQueue();
    queue.setAutoApprovePolicy("medium");

    const decisions: string[] = [];
    const request: ApprovalRequest = {
      adapter: "codex",
      action: "write",
      description: "Write to a file",
    };

    queue.enqueue(request, (decision) => {
      decisions.push(decision);
    });

    assert.equal(queue.size(), 0);
    assert.deepEqual(decisions, ["allow"]);
  });

  it("does NOT auto-approve MEDIUM risk with 'low' policy", () => {
    setFeatureEnabled("RISK_LEVELS", true);
    const queue = new ApprovalQueue();
    queue.setAutoApprovePolicy("low");

    const decisions: string[] = [];
    const request: ApprovalRequest = {
      adapter: "codex",
      action: "write",
      description: "Write to a file",
    };

    queue.enqueue(request, (decision) => {
      decisions.push(decision);
    });

    // Medium risk should NOT pass with "low" policy
    assert.equal(queue.size(), 1);
    assert.deepEqual(decisions, []);
  });
});
