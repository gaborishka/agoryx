import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCodexSpawnArgs,
  extractCodexThreadId,
} from "../../internal/adapters/codex/index.js";

test("buildCodexSpawnArgs cold: exec --json <prompt>", () => {
  const args = buildCodexSpawnArgs("hello", null);
  assert.deepEqual(args, ["exec", "--json", "hello"]);
});

test("buildCodexSpawnArgs resume: exec resume <id> --json <prompt>", () => {
  const args = buildCodexSpawnArgs("hello", "thread_abc");
  assert.deepEqual(args, ["exec", "resume", "thread_abc", "--json", "hello"]);
});

test("extractCodexThreadId extracts thread_id from thread.started event", () => {
  const line = '{"type":"thread.started","thread_id":"019c6deb-323f-7672-976a-ce4c0587d505"}';
  assert.equal(extractCodexThreadId(line), "019c6deb-323f-7672-976a-ce4c0587d505");
});

test("extractCodexThreadId returns null for non-thread event", () => {
  const line = '{"type":"item.completed","item":{"text":"hello"}}';
  assert.equal(extractCodexThreadId(line), null);
});

test("extractCodexThreadId returns null for non-JSON", () => {
  assert.equal(extractCodexThreadId("not json"), null);
});
