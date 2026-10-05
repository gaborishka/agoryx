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

test("team steps are returned in seq order", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const runId = createRun(store);
    store.addTeamStep({
      runId,
      seq: 1,
      stage: "debate",
      actor: "codex",
      dispatchId: "dsp_1",
      requestId: "req_1",
      inputText: "Prompt 1",
      outputText: "Answer 1",
      result: "ok",
    });
    store.addTeamStep({
      runId,
      seq: 2,
      stage: "debate",
      actor: "claude",
      dispatchId: "dsp_2",
      requestId: "req_2",
      inputText: "Prompt 2",
      outputText: "Answer 2",
      result: "ok",
    });

    const steps = store.listTeamSteps(runId, 10);
    assert.equal(steps.length, 2);
    assert.equal(steps[0]?.seq, 1);
    assert.equal(steps[1]?.seq, 2);
  } finally {
    store.close();
  }
});

test("feedback queue supports enqueue/list/consume", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const runId = createRun(store);
    const first = store.enqueueTeamFeedback(runId, "msg_1", "First feedback");
    const second = store.enqueueTeamFeedback(runId, "msg_2", "Second feedback");

    const pending = store.listPendingTeamFeedback(runId, 10);
    assert.equal(pending.length, 2);
    assert.equal(store.countPendingTeamFeedback(runId), 2);

    store.consumeTeamFeedback([first.id, second.id]);
    assert.equal(store.countPendingTeamFeedback(runId), 0);
  } finally {
    store.close();
  }
});
