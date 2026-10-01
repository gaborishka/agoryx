import assert from "node:assert/strict";
import { test } from "node:test";
import { RoomStore } from "../../internal/agora/store.js";
import { createTestRoom, withTimeout } from "./helpers.js";

test("a room can start with one agent, seat another mid-conversation, and send one out", async () => {
  // Each agent answers the human's message, then passes on what the others say.
  const room = createTestRoom({
    agents: [{ id: "claude", kind: "claude", label: "Claude" }],
    rules: [{ match: "── Codex", reply: "::pass::" }, { match: "── Claude", reply: "::pass::" }, { reply: "Done." }],
  });
  try {
    room.engine.postHuman("First question");
    await withTimeout(room.engine.waitIdle());
    assert.equal(room.invocations().length, 1, "one agent, one turn");

    const codex = room.engine.addAgent({ kind: "codex", role: "Reviewer: look for bugs,\n\n\n\ndon't write code." });
    assert.deepEqual(codex, { id: "codex", kind: "codex", label: "Codex", role: "Reviewer: look for bugs,\n\ndon't write code." });
    assert.deepEqual(room.store.state.agents.map((agent) => agent.id), ["claude", "codex"]);
    const seated = room.store.state.messages.at(-1)!;
    assert.deepEqual(seated.sys, { code: "agent.added", by: "Ivan", agent: "Codex", handle: "codex", cli: "codex", role: codex.role });
    await withTimeout(room.engine.waitIdle());
    assert.equal(room.invocations("codex").length, 0, "what was said before it came does not wake it");

    room.engine.postHuman("Second question");
    await withTimeout(room.engine.waitIdle());
    const [first] = room.invocations("codex");
    assert.ok(first, "the next message wakes it");
    assert.match(first.prompt!, /Ivan gave you a role in this room:\n {2}Reviewer: look for bugs,/);
    assert.match(first.prompt!, /First question/, "it reads the conversation from before it came");
    const claudeNext = room.invocations("claude").at(-1)!;
    assert.match(claudeNext.prompt!, /Ivan seated Codex \(@codex, codex CLI\) in the room, with this role/, "the others are told who came");

    // A second agent of the same CLI gets its own handle.
    const second = room.engine.addAgent({ kind: "claude", model: "sonnet" });
    assert.equal(second.id, "claude-2");
    assert.equal(second.label, "Claude 2");
    assert.throws(() => room.engine.addAgent({ kind: "claude", id: "claude-2" }), /two agents are called "claude-2"/);
    assert.throws(() => room.engine.addAgent({ kind: "claude", id: "ivan" }), /Ivan's handle/);
    assert.throws(() => room.engine.addAgent({ kind: "codex", id: "helper" }, "claude"), /only the human seats agents/);

    await room.engine.removeAgent("claude-2");
    await room.engine.removeAgent("codex");
    assert.deepEqual(room.store.state.agents.map((agent) => agent.id), ["claude"]);
    assert.deepEqual(room.store.state.former.map((agent) => agent.id), ["claude-2", "codex"]);
    await assert.rejects(room.engine.removeAgent("claude"), /at least one agent/);
    await assert.rejects(room.engine.removeAgent("codex"), /no agent @codex/);
    assert.throws(() => room.engine.addAgent({ kind: "claude", id: "codex" }), /was a codex agent here/);

    // Back again: its messages were kept under its name, and it goes on from where it left off.
    room.engine.addAgent({ kind: "codex" });
    assert.deepEqual(room.store.state.former.map((agent) => agent.id), ["claude-2"]);
    const reopened = RoomStore.open(room.roomsRoot, room.store.id);
    assert.deepEqual(reopened.state.agents, room.store.state.agents, "the roster is in the event log");
    assert.deepEqual(reopened.state.former, room.store.state.former);
  } finally {
    await room.cleanup();
  }
});

test("sending out an agent at work stops its turn first", async () => {
  const room = createTestRoom({ rules: [{ agent: "codex", sleepMs: 20_000 }, { reply: "::pass::" }] });
  try {
    room.engine.postHuman("Go");
    await withTimeout(
      (async () => {
        while (!room.store.state.turns.some((turn) => turn.agent === "codex" && turn.status === "running")) await new Promise((resolve) => setTimeout(resolve, 20));
      })(),
    );
    await withTimeout(room.engine.removeAgent("codex"));
    assert.ok(room.store.state.turns.every((turn) => turn.status !== "running" || turn.agent !== "codex"));
    await withTimeout(room.engine.waitIdle());
    assert.deepEqual(room.store.state.agents.map((agent) => agent.id), ["claude"]);
  } finally {
    await room.cleanup();
  }
});

test("the human sets an agent's role, name and profile; the room is told", async () => {
  const room = createTestRoom({ rules: [{ reply: "::pass::" }] });
  try {
    const agent = room.engine.updateAgent("codex", { role: "Tester", label: "Codex QA", profile: false, effort: "high" });
    assert.deepEqual(agent, { id: "codex", kind: "codex", label: "Codex QA", effort: "high", role: "Tester", profile: false });
    const notes = room.store.state.messages.map((message) => message.sys);
    assert.deepEqual(notes.at(-1), { code: "agent.set", by: "Ivan", agent: "Codex", role: "Tester", label: "Codex QA", profile: false });
    assert.match(room.store.state.messages.at(-1)!.text, /Ivan renamed Codex \(@codex\) to Codex QA; gave Codex QA this role: "Tester"; stopped giving Codex QA their profile\./);

    assert.throws(() => room.engine.updateAgent("codex", { role: "Boss" }, "claude"), /only the human/);
    assert.throws(() => room.engine.updateAgent("codex", { label: "claude" }), /already called claude/i);
    assert.throws(() => room.engine.updateAgent("codex", { role: "x".repeat(2001) }), /at most 2000/);

    room.engine.postHuman("Start");
    await withTimeout(room.engine.waitIdle());
    const briefing = room.invocations("claude")[0]!.prompt!;
    assert.match(briefing, /You have no assigned role/);
    assert.match(briefing, /- Codex QA \(@codex\):\n {4}Tester/);

    room.engine.updateAgent("codex", { role: null });
    assert.equal(room.store.state.agents[1]!.role, undefined);
    assert.match(room.store.state.messages.at(-1)!.text, /took Codex QA's role away/);
  } finally {
    await room.cleanup();
  }
});
