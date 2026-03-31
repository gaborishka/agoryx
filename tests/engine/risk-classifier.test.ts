import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyCommand,
  classifyFileOp,
  classifyApprovalRequest,
} from "../../internal/engine/risk-classifier.js";

describe("classifyCommand", () => {
  it("rm -rf / classified as HIGH", () => {
    const result = classifyCommand("rm -rf /");
    assert.equal(result.level, "high");
  });

  it("git push --force classified as HIGH", () => {
    const result = classifyCommand("git push --force");
    assert.equal(result.level, "high");
  });

  it("sudo apt install classified as HIGH", () => {
    const result = classifyCommand("sudo apt install");
    assert.equal(result.level, "high");
  });

  it("ls -la classified as LOW", () => {
    const result = classifyCommand("ls -la");
    assert.equal(result.level, "low");
  });

  it("git status classified as LOW", () => {
    const result = classifyCommand("git status");
    assert.equal(result.level, "low");
  });

  it("npm install express classified as MEDIUM", () => {
    const result = classifyCommand("npm install express");
    assert.equal(result.level, "medium");
  });

  it("node server.js classified as MEDIUM", () => {
    const result = classifyCommand("node server.js");
    assert.equal(result.level, "medium");
  });
});

describe("classifyFileOp", () => {
  it("file read classified as LOW", () => {
    const result = classifyFileOp("src/index.ts", "read");
    assert.equal(result.level, "low");
  });

  it("file write classified as MEDIUM", () => {
    const result = classifyFileOp("src/index.ts", "write");
    assert.equal(result.level, "medium");
  });

  it("file delete classified as HIGH", () => {
    const result = classifyFileOp("src/index.ts", "delete");
    assert.equal(result.level, "high");
  });

  it(".env file write classified as HIGH", () => {
    const result = classifyFileOp(".env", "write");
    assert.equal(result.level, "high");
  });
});

describe("classifyApprovalRequest", () => {
  it("permissions kind always HIGH", () => {
    const result = classifyApprovalRequest({
      kind: "permissions",
      toolName: "chmod",
    });
    assert.equal(result.level, "high");
  });
});
