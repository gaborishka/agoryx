import assert from "node:assert/strict";
import { test } from "node:test";
import { limitText } from "../../internal/agora/duration.js";
import { turnClock } from "../../ui/src/lib/room.js";
import { sysLine } from "../../ui/src/lib/system.js";
import { createTestRoom, withTimeout } from "./helpers.js";

// A turn's time limit is said as it was set: a 90-second limit is "1:30", not "2 min" (rounded to minutes,
// a limit under half a minute was "0 min").

test("a time limit is said as it was set, to the second", () => {
  assert.equal(limitText(90_000), "1:30");
  assert.equal(limitText(30_000), "30s");
  assert.equal(limitText(20 * 60_000), "20 min");
  assert.equal(limitText(15.5 * 60_000), "15:30");
  assert.equal(limitText(60 * 60_000), "1 h");
  assert.equal(limitText(2.5 * 3_600_000), "2 h 30 min");
  assert.equal(limitText(3_600_000 + 15_000), "1:00:15");
  assert.equal(limitText(24 * 3_600_000), "24 h");
  // Not whole seconds: rounded down, as the turn clock rounds it, never up to the next minute.
  assert.equal(limitText(119_700), "1:59");
  assert.equal(limitText(90_600), "1:30");
});

for (const live of [false, true]) {
  test(`a turn that runs past its limit says the limit as it was set, for either CLI${live ? ", in a live process" : ""}`, async () => {
    // Below what the room's settings take (30 s), so the test is quick; the runners take whatever limit they are given.
    const room = createTestRoom({ live, settings: { turnTimeoutMs: 2_000 }, rules: [{ match: "slow", sleepMs: 10_000, reply: "late" }] });
    try {
      room.engine.postHuman("@all slow");
      await withTimeout(room.engine.waitIdle());
      for (const agent of ["claude", "codex"]) {
        const turn = room.store.state.turns.find((entry) => entry.agent === agent);
        assert.equal(turn?.status, "error", `${agent}'s turn`);
        const note = room.store.state.messages.find((message) => message.sys?.code === "turn.failed" && message.sys.cli === agent);
        assert.ok(note?.sys?.code === "turn.failed", `${agent}'s failed turn is in the room`);
        assert.equal(note.sys.error, "timeout");
        assert.equal(note.sys.message, "turn exceeded 2s");
      }
    } finally {
      await room.cleanup();
    }
  });
}

test("the room says a timed-out turn's limit as it was set", () => {
  const line = (message: string) => sysLine({ text: "", sys: { code: "turn.failed", agent: "Codex", cli: "codex", error: "timeout", message } });
  assert.equal(line("turn exceeded 1:30"), "Codex: the turn could not finish — the turn ran past its time limit (1:30)");
  assert.equal(line("turn exceeded 45s"), "Codex: the turn could not finish — the turn ran past its time limit (45s)");
  // What older rooms said stays as it was.
  assert.equal(line("turn exceeded 20 min"), "Codex: the turn could not finish — the turn ran past its time limit (20 min)");
});

test("the turn clock never shows the limit as reached before it is", () => {
  // A limit that is not whole seconds (the room takes any whole number of ms): rounded down, both sides read 1:30.
  assert.equal(turnClock(90_200, 90_400), "1:29 of 1:30");
  assert.equal(turnClock(90_200, 90_400, true), "1:29");
  assert.equal(turnClock(90_400, 90_400), "over 1:30");
  // Nor in minutes: 3 h and half a minute is "3 h", and 3 h 10 s into it is not yet "3 h of 3 h".
  assert.equal(turnClock(3 * 3_600_000 + 10_000, 3 * 3_600_000 + 30_000), "2 h 59 min of 3 h");
  // Whole limits read as before.
  assert.equal(turnClock(89_999, 90_000), "1:29 of 1:30");
  assert.equal(turnClock(65_000, 90_000), "1:05 of 1:30");
  assert.equal(turnClock(18 * 60_000 + 59_000, 20 * 60_000), "18 of 20 min");
});
