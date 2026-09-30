import assert from "node:assert/strict";
import { test } from "node:test";
import { roomUsage, turnOutcome } from "../../internal/agora/usage.js";
import { createTestRoom, withTimeout } from "./helpers.js";

test("a room's wakes read back from its turns: per agent, how they ended, who woke them, what each ending took", async () => {
  const room = createTestRoom();
  try {
    // Both answer the human, then each is woken by the other's answer and passes.
    room.engine.postHuman("hello");
    await withTimeout(room.engine.waitIdle());
    const state = room.store.state;
    const usage = roomUsage(state, room.store.since(0));
    assert.equal(usage.room, state.id);
    assert.deepEqual(
      usage.agents.map((agent) => [agent.agent, agent.wakes, agent.outcomes.replied.turns, agent.outcomes.passed.turns, agent.outcomes.failed.turns, agent.running]),
      [
        ["claude", 2, 1, 1, 0, 0],
        ["codex", 2, 1, 1, 0, 0],
      ],
    );
    const claude = usage.agents.find((agent) => agent.agent === "claude")!;
    const codex = usage.agents.find((agent) => agent.agent === "codex")!;
    assert.deepEqual(claude.wokenBy, { Ivan: 1, codex: 1 });
    assert.deepEqual(codex.wokenBy, { Ivan: 1, claude: 1 });
    // Claude reports money per turn; Codex only tokens.
    assert.equal(claude.total.costTurns, 2);
    assert.ok(claude.outcomes.passed.costUsd > 0);
    assert.equal(codex.total.costTurns, 0);
    assert.equal(codex.total.inputTokens, 24);
    assert.equal(codex.outcomes.passed.outputTokens, 6);
    // The numbers are the turns' own.
    for (const agent of usage.agents) {
      const turns = state.turns.filter((turn) => turn.agent === agent.agent);
      assert.equal(agent.total.ms, turns.reduce((sum, turn) => sum + (turn.durationMs ?? 0), 0));
      const passed = turns.filter((turn) => turn.status === "pass");
      assert.equal(agent.outcomes.passed.ms, passed.reduce((sum, turn) => sum + (turn.durationMs ?? 0), 0));
    }
    assert.equal(usage.total.turns, 4);
    assert.equal(usage.outcomes.passed.turns, 2);
    assert.equal(usage.from, state.turns[0]!.startedAt);
  } finally {
    await room.cleanup();
  }
});

test("failures are counted by kind, and an agent never woken still has its row", async () => {
  const room = createTestRoom({
    rules: [{ agent: "codex", error: "Error: not logged in", exitCode: 1 }],
    agents: [
      { id: "claude", kind: "claude", label: "Claude" },
      { id: "codex", kind: "codex", label: "Codex" },
      { id: "opus", kind: "claude", label: "Opus" },
    ],
  });
  try {
    room.engine.postHuman("@codex check this");
    await withTimeout(room.engine.waitIdle());
    const usage = roomUsage(room.store.state, room.store.since(0));
    const codex = usage.agents.find((agent) => agent.agent === "codex")!;
    assert.equal(codex.outcomes.failed.turns, 1);
    assert.deepEqual(codex.errors, { auth: 1 });
    assert.deepEqual(codex.wokenBy, { Ivan: 1 });
    const opus = usage.agents.find((agent) => agent.agent === "opus")!;
    assert.equal(opus.wakes, 0);
    assert.equal(opus.total.turns, 0);
  } finally {
    await room.cleanup();
  }
});

test("turn outcomes", () => {
  assert.equal(turnOutcome({ status: "ok" }), "replied");
  assert.equal(turnOutcome({ status: "pass" }), "passed");
  assert.equal(turnOutcome({ status: "error" }), "failed");
  assert.equal(turnOutcome({ status: "interrupted" }), "stopped");
  assert.equal(turnOutcome({ status: "running" }), null);
});
