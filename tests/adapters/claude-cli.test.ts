import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClaudeSpawnArgs,
  buildClaudeSpawnCwd,
  buildClaudeSpawnEnv,
} from "../../internal/adapters/claude/index.js";

test("claude CLI args include stream-json verbose mode", () => {
  const args = buildClaudeSpawnArgs("hello");
  assert.deepEqual(args, [
    "-p",
    "hello",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ]);
});

test("claude CLI env strips CLAUDECODE and keeps other vars", () => {
  const env = buildClaudeSpawnEnv({
    PATH: "/usr/bin",
    CLAUDECODE: "1",
    ANTHROPIC_API_KEY: "secret",
  });

  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.ANTHROPIC_API_KEY, "secret");
});

test("claude CLI cwd defaults to tmpdir and allows AGORYX_CLAUDE_CWD override", () => {
  const defaultCwd = buildClaudeSpawnCwd({});
  assert.ok(defaultCwd.length > 0);

  const custom = buildClaudeSpawnCwd({ AGORYX_CLAUDE_CWD: "/tmp/custom-claude-cwd" });
  assert.equal(custom, "/tmp/custom-claude-cwd");
});
