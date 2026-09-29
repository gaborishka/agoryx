import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRoom } from "../../internal/agora/service.js";
import { DEFAULT_SETTINGS } from "../../internal/agora/types.js";
import { createTestRoom, withTimeout } from "./helpers.js";

test("a room has no turn limit unless the human sets one", () => {
  assert.equal(DEFAULT_SETTINGS.budget, null);
  const home = mkdtempSync(join(tmpdir(), "agora-budget-"));
  const env = { ...process.env, AGORYX_HOME: home, AGORYX_HUMAN: "Ivan" };
  try {
    assert.equal(createRoom({ name: "Open", env }).state.settings.budget, null);
    assert.equal(createRoom({ name: "Capped", env, budget: 6 }).state.settings.budget, 6);
    assert.equal(createRoom({ name: "Said none", env, budget: null }).state.settings.budget, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("without a limit the run ends when everyone passes, and nobody is told to count turns", async () => {
  // Each agent answers once, then passes.
  const room = createTestRoom({ rules: [{ agent: "claude", once: true, reply: "done on my side" }, { agent: "codex", once: true, reply: "same here" }] });
  try {
    room.engine.postHuman("Say one thing each");
    await withTimeout(room.engine.waitIdle());
    const run = room.store.state.runs.at(-1)!;
    assert.equal(run.budget, null);
    assert.equal(run.endReason, "quiet");
    assert.ok(!room.store.state.messages.some((message) => /Turn budget reached/.test(message.text)));
    const prompts = [...room.invocations("claude"), ...room.invocations("codex")].map((entry) => entry.prompt!);
    assert.ok(prompts.length >= 3);
    assert.ok(prompts.every((prompt) => !/Turns left in this run|last agent turn of this run|turn budget/.test(prompt)));
    assert.match(room.invocations("claude")[0]!.prompt!, /There is no turn limit: the room goes on until everyone passes/);

    // "Another round" in such a room is not a hidden cap either.
    room.engine.continueRun();
    await withTimeout(room.engine.waitIdle());
    assert.equal(room.store.state.runs.at(-1)!.budget, null);
    assert.equal(room.store.state.runs.at(-1)!.endReason, "quiet");
  } finally {
    await room.cleanup();
  }
});

test("the limit can be set and taken off again; a limited room still counts down", async () => {
  const room = createTestRoom({ rules: [{ reply: "I still disagree." }] });
  try {
    room.engine.updateSettings({ budget: 3 });
    room.engine.postHuman("Argue");
    await withTimeout(room.engine.waitIdle());
    const capped = room.store.state.runs.at(-1)!;
    assert.equal(capped.budget, 3);
    assert.equal(capped.endReason, "budget");
    assert.ok(room.invocations("claude").some((entry) => /Turns left in this run after yours/.test(entry.prompt!)));

    room.engine.updateSettings({ budget: null });
    assert.equal(room.store.state.settings.budget, null);
    // Out-of-range values are ignored, not stored.
    room.engine.updateSettings({ budget: 0 });
    assert.equal(room.store.state.settings.budget, null);
    // The finished run keeps the limit it had.
    assert.equal(room.store.state.runs.at(-1)!.budget, 3);
  } finally {
    await room.cleanup();
  }
});
