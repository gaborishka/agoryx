import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ApprovalQueue } from "../../internal/engine/approval-queue.js";
import type { ApprovalRequest } from "../../internal/adapters/adapter.js";

const makeRequest = (id: string): ApprovalRequest => ({
  approvalId: id,
  agent: "codex",
  kind: "command",
  toolName: "Bash",
  description: `Run command ${id}`,
  availableDecisions: ["accept", "decline"],
  raw: {},
});

describe("ApprovalQueue", () => {
  it("presents first enqueued item immediately", () => {
    const queue = new ApprovalQueue();
    let presented: ApprovalRequest | null = null;
    queue.setCallbacks(
      (item) => { presented = item.request; },
      () => {},
    );
    queue.enqueue(makeRequest("a1"), () => {});
    assert.equal(presented?.approvalId, "a1");
  });

  it("queues second item until first is responded", () => {
    const queue = new ApprovalQueue();
    const presented: string[] = [];
    queue.setCallbacks(
      (item) => { presented.push(item.request.approvalId); },
      () => {},
    );
    queue.enqueue(makeRequest("a1"), () => {});
    queue.enqueue(makeRequest("a2"), () => {});
    assert.deepEqual(presented, ["a1"]);

    queue.respondToActive("accept");
    assert.deepEqual(presented, ["a1", "a2"]);
  });

  it("calls respond callback with decision", () => {
    const queue = new ApprovalQueue();
    let decision: string | null = null;
    queue.setCallbacks(() => {}, () => {});
    queue.enqueue(makeRequest("a1"), (d) => { decision = d; });
    queue.respondToActive("decline");
    assert.equal(decision, "decline");
  });

  it("calls onClear when queue empties", () => {
    const queue = new ApprovalQueue();
    let cleared = false;
    queue.setCallbacks(() => {}, () => { cleared = true; });
    queue.enqueue(makeRequest("a1"), () => {});
    queue.respondToActive("accept");
    assert.equal(cleared, true);
  });

  it("rejectAll rejects all pending items", () => {
    const queue = new ApprovalQueue();
    const decisions: string[] = [];
    queue.setCallbacks(() => {}, () => {});
    queue.enqueue(makeRequest("a1"), (d) => decisions.push(d));
    queue.enqueue(makeRequest("a2"), (d) => decisions.push(d));
    queue.rejectAll();
    assert.deepEqual(decisions, ["cancel", "cancel"]);
  });

  it("reports correct pending count", () => {
    const queue = new ApprovalQueue();
    queue.setCallbacks(() => {}, () => {});
    assert.equal(queue.pending, 0);
    queue.enqueue(makeRequest("a1"), () => {});
    assert.equal(queue.pending, 1);
    queue.enqueue(makeRequest("a2"), () => {});
    assert.equal(queue.pending, 2);
    queue.respondToActive("accept");
    assert.equal(queue.pending, 1);
    queue.respondToActive("accept");
    assert.equal(queue.pending, 0);
  });
});
