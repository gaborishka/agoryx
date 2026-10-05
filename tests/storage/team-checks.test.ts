import test from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../../internal/storage/sqlite.js";

const createRun = (store: SQLiteStore): string => {
  const room = store.createRoom("team-room", ["user", "agent.codex", "agent.claude"], {
    mode: "team",
    checkpointThreshold: 50,
    maxHistoryMessages: 100,
    maxContextTokens: 30_000,
  });
  return store.createTeamRun({
    roomId: room.id,
    strategy: "debate",
    stage: "debate",
    goal: "Goal",
    participants: ["codex", "claude"],
    maxSteps: 8,
    maxNoProgressSteps: 2,
    maxDurationMs: 900_000,
    checksEnabled: true,
    createdBy: "user",
  }).id;
};

test("team checks persist execution result and order", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const runId = createRun(store);
    store.addTeamCheck({
      runId,
      command: "npm run typecheck",
      status: "passed",
      exitCode: 0,
      stdoutText: "ok",
      stderrText: "",
      durationMs: 1200,
    });
    store.addTeamCheck({
      runId,
      command: "npm test",
      status: "failed",
      exitCode: 1,
      stdoutText: "",
      stderrText: "failed",
      durationMs: 2400,
    });

    const checks = store.listTeamChecks(runId, 10);
    assert.equal(checks.length, 2);
    const byCommand = new Map(checks.map((check) => [check.command, check]));
    assert.equal(byCommand.get("npm run typecheck")?.status, "passed");
    assert.equal(byCommand.get("npm test")?.status, "failed");
    assert.equal(byCommand.get("npm test")?.exitCode, 1);
  } finally {
    store.close();
  }
});
