import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  setFeatureOverride,
  clearAllFeatureOverrides,
} from "../../internal/config/features.js";
import { ApprovalQueue } from "../../internal/engine/approval-queue.js";
import type { ApprovalRequest } from "../../internal/adapters/adapter.js";

const makeRequest = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  approvalId: `appr-${Math.random().toString(36).slice(2)}`,
  agent: "codex",
  kind: "command",
  toolName: "Bash",
  description: "Run a command",
  command: "ls -la",
  availableDecisions: ["allow", "deny"],
  raw: {},
  ...overrides,
});

describe("ApprovalQueue risk classification integration", () => {
  beforeEach(() => {
    clearAllFeatureOverrides();
  });

  afterEach(() => {
    clearAllFeatureOverrides();
  });

  it("auto-approves LOW risk request with 'low' policy", () => {
    setFeatureOverride("RISK_LEVELS", true);
    const queue = new ApprovalQueue();
    queue.setAutoApprovePolicy("low");

    const decisions: string[] = [];
    const request = makeRequest({ command: "ls -la" }); // LOW risk

    queue.enqueue(request, (decision) => {
      decisions.push(decision);
    });

    // Should have been auto-approved — not in queue
    assert.equal(queue.pending, 0);
    assert.deepEqual(decisions, ["allow"]);
  });

  it("does NOT auto-approve HIGH risk request with 'low' policy", () => {
    setFeatureOverride("RISK_LEVELS", true);
    const queue = new ApprovalQueue();
    queue.setAutoApprovePolicy("low");

    const decisions: string[] = [];
    const request = makeRequest({ command: "rm -rf /tmp/foo" }); // HIGH risk

    queue.enqueue(request, (decision) => {
      decisions.push(decision);
    });

    // Should NOT have been auto-approved — remains in queue
    assert.equal(queue.pending, 1);
    assert.deepEqual(decisions, []);
  });

  it("attaches risk level to queued item when RISK_LEVELS enabled", () => {
    setFeatureOverride("RISK_LEVELS", true);
    const queue = new ApprovalQueue();
    queue.setAutoApprovePolicy("none");

    const request = makeRequest({ command: "rm -rf /tmp/foo" }); // HIGH risk

    queue.enqueue(request, () => {});

    assert.equal(queue.pending, 1);
    const item = queue.active;
    assert.ok(item);
    assert.equal(item.riskLevel, "high");
    assert.ok(item.riskReason);
  });

  it("does NOT classify risk when RISK_LEVELS feature is disabled", () => {
    setFeatureOverride("RISK_LEVELS", false);
    const queue = new ApprovalQueue();
    queue.setAutoApprovePolicy("low");

    const decisions: string[] = [];
    const request = makeRequest({ command: "ls -la" }); // Would be LOW risk

    queue.enqueue(request, (decision) => {
      decisions.push(decision);
    });

    // With feature disabled: no auto-approve, no risk classification
    assert.equal(queue.pending, 1);
    assert.deepEqual(decisions, []);
    const item = queue.active;
    assert.ok(item);
    assert.equal(item.riskLevel, undefined);
    assert.equal(item.riskReason, undefined);
  });

  it("auto-approves MEDIUM risk with 'medium' policy", () => {
    setFeatureOverride("RISK_LEVELS", true);
    const queue = new ApprovalQueue();
    queue.setAutoApprovePolicy("medium");

    const decisions: string[] = [];
    const request = makeRequest({ command: "npm install express" }); // MEDIUM risk

    queue.enqueue(request, (decision) => {
      decisions.push(decision);
    });

    assert.equal(queue.pending, 0);
    assert.deepEqual(decisions, ["allow"]);
  });

  it("does NOT auto-approve MEDIUM risk with 'low' policy", () => {
    setFeatureOverride("RISK_LEVELS", true);
    const queue = new ApprovalQueue();
    queue.setAutoApprovePolicy("low");

    const decisions: string[] = [];
    const request = makeRequest({ command: "npm install express" }); // MEDIUM risk

    queue.enqueue(request, (decision) => {
      decisions.push(decision);
    });

    assert.equal(queue.pending, 1);
    assert.deepEqual(decisions, []);
  });
});
