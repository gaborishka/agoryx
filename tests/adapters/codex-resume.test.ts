import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCodexAppServerArgs,
  buildCodexSpawnArgs,
  buildCodexSpawnEnv,
  extractCodexThreadId,
  shouldConsumeCodexDelta,
  shouldRestartCodexInteractiveRunner,
} from "../../internal/adapters/codex/index.js";

test("buildCodexSpawnArgs cold: exec --json <prompt>", () => {
  const args = buildCodexSpawnArgs("hello", null);
  assert.deepEqual(args, ["exec", "--json", "hello"]);
});

test("buildCodexSpawnArgs resume: exec resume <id> --json <prompt>", () => {
  const args = buildCodexSpawnArgs("hello", "thread_abc");
  assert.deepEqual(args, ["exec", "resume", "thread_abc", "--json", "hello"]);
});

test("buildCodexAppServerArgs starts app-server transport", () => {
  const args = buildCodexAppServerArgs();
  assert.deepEqual(args, ["app-server"]);
});

test("buildCodexSpawnEnv strips CLAUDECODE and preserves other vars", () => {
  const env = buildCodexSpawnEnv({
    PATH: "/usr/bin",
    CLAUDECODE: "1",
    HOME: "/tmp/home",
  });
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/tmp/home");
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

test("shouldRestartCodexInteractiveRunner restarts for cold retry against warm session", () => {
  const restart = shouldRestartCodexInteractiveRunner(
    true,
    false,
    "/workspace",
    "/workspace",
    "session_old",
    null,
  );
  assert.equal(restart, true);
});

test("shouldRestartCodexInteractiveRunner keeps warm runner for same session", () => {
  const restart = shouldRestartCodexInteractiveRunner(
    true,
    false,
    "/workspace",
    "/workspace",
    "session_same",
    "session_same",
  );
  assert.equal(restart, false);
});

test("shouldConsumeCodexDelta locks on first source to avoid duplicate streams", () => {
  assert.equal(shouldConsumeCodexDelta(null, "envelope"), true);
  assert.equal(shouldConsumeCodexDelta("envelope", "legacy"), false);
  assert.equal(shouldConsumeCodexDelta("envelope", "envelope"), true);
  assert.equal(shouldConsumeCodexDelta("legacy", "legacy"), true);
  assert.equal(shouldConsumeCodexDelta("legacy", "envelope"), false);
});
