import test from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../../internal/storage/sqlite.js";
import type { Room } from "../../internal/events/types.js";

const createRoom = (store: SQLiteStore): Room =>
  store.createRoom("team-room", ["user", "agent.codex", "agent.claude"], {
    mode: "team",
    checkpointThreshold: 50,
    maxHistoryMessages: 100,
    maxContextTokens: 30_000,
  });

test("team run storage allows parallel active runs when runtime policy permits", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const room = createRoom(store);
    const first = store.createTeamRun({
      roomId: room.id,
      strategy: "debate",
      stage: "debate",
      goal: "Goal A",
      participants: ["codex", "claude"],
      maxSteps: 8,
      maxNoProgressSteps: 2,
      maxDurationMs: 900_000,
      checksEnabled: true,
      createdBy: "user",
    });
    assert.equal(first.status, "active");

    const second = store.createTeamRun({
      roomId: room.id,
      strategy: "debate",
      stage: "debate",
      goal: "Goal B",
      participants: ["codex", "claude"],
      maxSteps: 8,
      maxNoProgressSteps: 2,
      maxDurationMs: 900_000,
      checksEnabled: true,
      createdBy: "user",
    });
    assert.equal(second.status, "active");
    assert.notEqual(second.id, first.id);
  } finally {
    store.close();
  }
});

test("team run can be recreated after previous run is done", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const room = createRoom(store);
    const first = store.createTeamRun({
      roomId: room.id,
      strategy: "debate",
      stage: "debate",
      goal: "Goal A",
      participants: ["codex", "claude"],
      maxSteps: 8,
      maxNoProgressSteps: 2,
      maxDurationMs: 900_000,
      checksEnabled: true,
      createdBy: "user",
    });

    store.updateTeamRunStatus(first.id, "done", {
      completedAt: new Date().toISOString(),
    });

    const second = store.createTeamRun({
      roomId: room.id,
      strategy: "debate",
      stage: "debate",
      goal: "Goal B",
      participants: ["codex", "claude"],
      maxSteps: 8,
      maxNoProgressSteps: 2,
      maxDurationMs: 900_000,
      checksEnabled: false,
      createdBy: "user",
    });

    assert.equal(second.status, "active");
    assert.equal(second.strategy, "debate");
  } finally {
    store.close();
  }
});

test("latest resumable run returns waiting_user_input run", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const room = createRoom(store);
    const run = store.createTeamRun({
      roomId: room.id,
      strategy: "debate",
      stage: "debate",
      goal: "Goal A",
      participants: ["codex", "claude"],
      maxSteps: 8,
      maxNoProgressSteps: 2,
      maxDurationMs: 900_000,
      checksEnabled: true,
      createdBy: "user",
    });
    store.updateTeamRunStatus(run.id, "waiting_user_input", {
      stage: "finalize",
      finalSummary: "Proposal",
    });

    const resumable = store.getLatestResumableTeamRun(room.id);
    assert.ok(resumable);
    assert.equal(resumable.status, "waiting_user_input");
    assert.equal(resumable.finalSummary, "Proposal");
  } finally {
    store.close();
  }
});
