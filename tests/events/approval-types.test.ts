import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toolApprovalRequested, toolApprovalResponded } from "../../internal/adapters/event-factory.js";

describe("tool approval event factories", () => {
  const base = {
    roomId: "room_1",
    sessionId: "ses_1",
    requestId: "req_1",
    source: "adapter.codex",
  };

  it("creates tool.approval.requested event", () => {
    const event = toolApprovalRequested(base, {
      approvalId: "apr_1",
      agent: "codex",
      kind: "command",
      toolName: "Bash",
      description: "Run: echo hello",
      command: "echo hello",
      availableDecisions: ["accept", "decline"],
      raw: {},
    });
    assert.equal(event.type, "tool.approval.requested");
    const payload = event.payload as { approvalId: string; kind: string };
    assert.equal(payload.approvalId, "apr_1");
    assert.equal(payload.kind, "command");
  });

  it("creates tool.approval.responded event", () => {
    const event = toolApprovalResponded(base, {
      approvalId: "apr_1",
      decision: "accept",
    });
    assert.equal(event.type, "tool.approval.responded");
    const payload = event.payload as { decision: string };
    assert.equal(payload.decision, "accept");
  });
});
