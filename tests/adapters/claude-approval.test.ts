import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractClaudePermissionDenials,
  buildClaudeInteractiveSpawnArgs,
} from "../../internal/adapters/claude/index.js";

describe("extractClaudePermissionDenials", () => {
  it("extracts denials from result event", () => {
    const resultEvent = {
      type: "result",
      subtype: "success",
      permission_denials: [
        {
          tool_name: "Write",
          tool_use_id: "toolu_01abc",
          tool_input: {
            file_path: "/tmp/test.txt",
            content: "hello",
          },
        },
        {
          tool_name: "Bash",
          tool_use_id: "toolu_02def",
          tool_input: {
            command: "gh repo view",
          },
        },
      ],
    };
    const denials = extractClaudePermissionDenials(resultEvent);
    assert.equal(denials.length, 2);
    assert.equal(denials[0].toolName, "Write");
    assert.equal(denials[0].kind, "file");
    assert.equal(denials[0].filePath, "/tmp/test.txt");
    assert.equal(denials[1].toolName, "Bash");
    assert.equal(denials[1].kind, "command");
    assert.equal(denials[1].command, "gh repo view");
  });

  it("returns empty array when no denials", () => {
    assert.deepEqual(extractClaudePermissionDenials({ type: "result" }), []);
    assert.deepEqual(
      extractClaudePermissionDenials({
        type: "result",
        permission_denials: [],
      }),
      [],
    );
  });

  it("handles Edit tool as file kind", () => {
    const resultEvent = {
      type: "result",
      permission_denials: [
        {
          tool_name: "Edit",
          tool_use_id: "toolu_03",
          tool_input: { file_path: "/tmp/foo.ts" },
        },
      ],
    };
    const denials = extractClaudePermissionDenials(resultEvent);
    assert.equal(denials[0].kind, "file");
  });

  it("handles unknown tools gracefully", () => {
    const resultEvent = {
      type: "result",
      permission_denials: [
        {
          tool_name: "WebSearch",
          tool_use_id: "toolu_04",
          tool_input: {},
        },
      ],
    };
    const denials = extractClaudePermissionDenials(resultEvent);
    assert.equal(denials.length, 1);
    assert.equal(denials[0].toolName, "WebSearch");
    assert.equal(denials[0].kind, "command");
    assert.equal(denials[0].description, "Use tool: WebSearch");
  });
});

describe("buildClaudeInteractiveSpawnArgs with allowedTools", () => {
  it("includes --allowedTools when provided", () => {
    const args = buildClaudeInteractiveSpawnArgs(null, ["Bash", "Read"]);
    assert.ok(args.includes("--allowedTools"));
    const toolsIdx = args.indexOf("--allowedTools");
    assert.equal(args[toolsIdx + 1], "Bash");
    assert.equal(args[toolsIdx + 2], "Read");
  });

  it("omits --allowedTools when empty", () => {
    const args = buildClaudeInteractiveSpawnArgs(null, []);
    assert.ok(!args.includes("--allowedTools"));
  });

  it("omits --allowedTools when undefined", () => {
    const args = buildClaudeInteractiveSpawnArgs(null);
    assert.ok(!args.includes("--allowedTools"));
  });

  it("preserves other flags with allowedTools", () => {
    const args = buildClaudeInteractiveSpawnArgs("ses_123", ["Bash"]);
    assert.ok(args.includes("--resume"));
    assert.ok(args.includes("ses_123"));
    assert.ok(args.includes("--print"));
    assert.ok(args.includes("--allowedTools"));
  });
});
