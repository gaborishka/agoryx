import test from "node:test";
import assert from "node:assert/strict";
import { TeamPolicy } from "../../internal/orchestrator/team.js";
import type { TeamRun } from "../../internal/events/types.js";

const baseRun = (overrides: Partial<TeamRun> = {}): TeamRun => ({
  id: "teamrun_1",
  roomId: "room_1",
  strategy: "debate",
  status: "active",
  stage: "debate",
  goal: "Ship a feature",
  participants: ["codex", "claude"],
  stepCount: 0,
  noProgressCount: 0,
  maxSteps: 8,
  maxNoProgressSteps: 2,
  maxDurationMs: 900_000,
  checksEnabled: true,
  createdBy: "user",
  createdAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  completedAt: null,
  finalSummary: null,
  ...overrides,
});

test("debate strategy rotates actors per run", () => {
  const policy = new TeamPolicy();
  const run = baseRun({ strategy: "debate" });
  const agents = ["codex", "claude"];

  const first = policy.selectActor(run, "debate", agents);
  const second = policy.selectActor(run, "debate", agents);
  const third = policy.selectActor(run, "debate", agents);

  assert.equal(first, "codex");
  assert.equal(second, "claude");
  assert.equal(third, "codex");
});

test("first actor follows direct @mention in goal", () => {
  const policy = new TeamPolicy();
  const run = baseRun({ goal: "@claude review docs first" });
  const agents = ["codex", "claude"];

  const first = policy.selectActor(run, "debate", agents);
  const second = policy.selectActor(run, "debate", agents);

  assert.equal(first, "claude");
  assert.equal(second, "codex");
});
