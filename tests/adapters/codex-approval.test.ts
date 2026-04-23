import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseCodexServerRequest,
  buildCodexApprovalResponse,
} from "../../internal/adapters/codex/index.js";

describe("parseCodexServerRequest", () => {
  it("parses commandExecution approval request", () => {
    const params = {
      threadId: "t1",
      turnId: "turn1",
      itemId: "item1",
      command: "/bin/zsh -lc 'gh repo view'",
      cwd: "/tmp",
      commandActions: [{ type: "unknown", command: "gh repo view" }],
      availableDecisions: ["accept", "acceptForSession", "decline"],
    };
    const result = parseCodexServerRequest(
      "item/commandExecution/requestApproval",
      params,
    );
    assert.ok(result);
    assert.equal(result.kind, "command");
    assert.equal(result.toolName, "Bash");
    assert.ok(result.command?.includes("gh repo view"));
    assert.deepEqual(result.availableDecisions, [
      "accept",
      "acceptForSession",
      "decline",
    ]);
  });

  it("parses fileChange approval request", () => {
    const params = {
      threadId: "t1",
      turnId: "turn1",
      itemId: "item1",
      reason: "wants to write file",
    };
    const result = parseCodexServerRequest(
      "item/fileChange/requestApproval",
      params,
    );
    assert.ok(result);
    assert.equal(result.kind, "file");
    assert.equal(result.toolName, "FileChange");
  });

  it("parses permissions approval request", () => {
    const params = {
      threadId: "t1",
      turnId: "turn1",
      itemId: "item1",
      reason: "needs network access",
    };
    const result = parseCodexServerRequest(
      "item/permissions/requestApproval",
      params,
    );
    assert.ok(result);
    assert.equal(result.kind, "permissions");
    assert.equal(result.toolName, "Permissions");
  });

  it("returns null for unknown method", () => {
    const result = parseCodexServerRequest("unknown/method", {});
    assert.equal(result, null);
  });

  it("handles null params gracefully", () => {
    const result = parseCodexServerRequest(
      "item/commandExecution/requestApproval",
      null,
    );
    assert.ok(result);
    assert.equal(result.kind, "command");
    assert.equal(result.command, "");
  });
});

describe("buildCodexApprovalResponse", () => {
  it("builds accept response", () => {
    const response = buildCodexApprovalResponse(
      "item/commandExecution/requestApproval",
      "accept",
    );
    assert.deepEqual(response, { decision: "accept" });
  });

  it("builds acceptForSession response", () => {
    const response = buildCodexApprovalResponse(
      "item/commandExecution/requestApproval",
      "acceptForSession",
    );
    assert.deepEqual(response, { decision: "acceptForSession" });
  });

  it("builds decline response", () => {
    const response = buildCodexApprovalResponse(
      "item/commandExecution/requestApproval",
      "decline",
    );
    assert.deepEqual(response, { decision: "decline" });
  });
});
