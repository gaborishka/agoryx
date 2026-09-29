import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { agentCliScript } from "../../internal/agora/workspace.js";
import { buildFeed } from "../../ui/src/lib/room.js";
import { createTestRoom, tableOutputs, withTimeout } from "./helpers.js";

const run = promisify(execFile);

test("an agent says what it is doing while it works: posted at once, not a turn, the other reads it mid-turn", async () => {
  const room = createTestRoom({
    rules: [
      {
        agent: "claude",
        once: true,
        table: [["say", "taking a.ts — leaving the CLI to @codex"], ["say", "a.ts done, now its tests"], ["say", "tests pass"], ["say", "writing it up"]],
        reply: "claude done",
      },
      // Codex looks at what was said while both were working, before it touches anything.
      { agent: "codex", once: true, sleepMs: 1500, table: [["read", "new"], ["say", "then I take the CLI"]], reply: "codex done" },
    ],
    settings: { budget: 4 },
  });
  try {
    room.engine.postHuman("Split the work on a.ts and the CLI");
    await withTimeout(room.engine.waitIdle());
    const state = room.store.state;

    const updates = state.messages.filter((message) => message.kind === "update");
    assert.deepEqual(
      updates.map((message) => [message.author, message.text]),
      [
        ["claude", "taking a.ts — leaving the CLI to @codex"],
        ["claude", "a.ts done, now its tests"],
        ["claude", "tests pass"],
        ["claude", "writing it up"],
        ["codex", "then I take the CLI"],
      ],
    );
    const claudeTurn = state.turns.find((turn) => turn.agent === "claude")!;
    const claudeReply = state.messages.find((message) => message.id === claudeTurn.messageId)!;
    for (const update of updates.filter((message) => message.author === "claude")) {
      assert.equal(update.turnId, claudeTurn.id, "an update belongs to the turn it was said in");
      assert.equal(update.wakes, false, "an update wakes nobody — the reply does");
      assert.ok(update.seq < claudeReply.seq, "posted while working, before the turn's reply");
    }
    assert.equal(claudeReply.kind, "agent");
    assert.equal(claudeReply.text, "claude done");

    // Five updates in a budget of four turns: they are not turns and are not counted.
    const r1 = state.runs[0]!;
    assert.equal(r1.used, state.turns.length);
    assert.ok(state.turns.length <= 4);

    const outputs = tableOutputs(room);
    const claudeSaid = outputs.find((entry) => entry.kind === "claude")!.tableOutputs!;
    assert.deepEqual(claudeSaid, ["m2 · posted to the room", "m3 · posted to the room", "m4 · posted to the room", "m5 · posted to the room"]);
    const codexRead = outputs.find((entry) => entry.kind === "codex")!.tableOutputs![0]!;
    assert.match(codexRead, /taking a\.ts/);
    assert.match(codexRead, /writing it up/);
    assert.doesNotMatch(codexRead, /Split the work/, "read new is what came after the reader's delta");

    // The next delta shows the others' updates for what they were, and never an agent its own.
    const codexCalls = room.invocations("codex");
    const claudeCalls = room.invocations("claude");
    assert.ok(codexCalls.length >= 2 && claudeCalls.length >= 2);
    assert.match(codexCalls[1]!.prompt!, /── Claude · while working · \d\d:\d\d\ntaking a\.ts/);
    assert.match(claudeCalls[1]!.prompt!, /── Codex · while working · \d\d:\d\d\nthen I take the CLI/);
    assert.doesNotMatch(claudeCalls[1]!.prompt!, /taking a\.ts/);
    // The briefing tells them how.
    assert.match(claudeCalls[0]!.prompt!, /say "taking internal\/x\.ts/);
    assert.match(claudeCalls[0]!.prompt!, /read new/);

    // The feed still shows the two first replies as one blind moment; the updates stand before it.
    const rows = buildFeed(state, []).rows;
    const group = rows.findIndex((row) => row.type === "group");
    assert.ok(group >= 0, "the blind answers are still grouped");
    const g = rows[group]!;
    assert.ok(g.type === "group" && g.blind && g.items.length === 2);
    const updateRows = rows.flatMap((row, index) => (row.type === "msg" && row.m.kind === "update" ? [index] : []));
    assert.equal(updateRows.length, 5);
    assert.ok(updateRows.every((index) => index < group));
  } finally {
    await room.cleanup();
  }
});

test("say needs a room turn; outside one it is refused, not posted", async () => {
  const room = createTestRoom();
  const poll = setInterval(() => room.engine.ingestOps(), 50);
  try {
    room.engine.postHuman("hello");
    await withTimeout(room.engine.waitIdle());
    const before = room.store.state.messages.length;
    const env = { ...room.env, PATH: process.env.PATH };
    for (const key of Object.keys(env)) if (key.startsWith("AGORYX_") || key === "CLAUDECODE") delete env[key];
    const refused = await run(process.execPath, [agentCliScript(), "say", "--as", "claude", "just a note"], { cwd: room.store.state.workspace, env }).catch(
      (error: { stderr: string; code: number }) => error,
    );
    assert.equal((refused as { code: number }).code, 1);
    assert.match((refused as { stderr: string }).stderr, /'say' is for while you work in a room turn/);
    assert.equal(room.store.state.messages.length, before);

    const empty = await run(process.execPath, [agentCliScript(), "say"], { cwd: room.store.state.workspace, env }).catch((error: { stderr: string }) => error);
    assert.match((empty as { stderr: string }).stderr, /'say' needs text/);
  } finally {
    clearInterval(poll);
    await room.cleanup();
  }
});
