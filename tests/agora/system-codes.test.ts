import assert from "node:assert/strict";
import { test } from "node:test";
import { RoomEngine } from "../../internal/agora/engine.js";
import { RoomStore } from "../../internal/agora/store.js";
import type { MessageEntry, SystemNote } from "../../internal/agora/types.js";
import { roomPreview } from "../../ui/src/lib/format.js";
import { legacyNote, sysError, sysLine } from "../../ui/src/lib/system.js";
import { createTestRoom, withTimeout } from "./helpers.js";

/** Lines Agoryx wrote, with their codes. */
const coded = (messages: MessageEntry[]) => messages.filter((message) => message.sys).map((message) => [message.author, message.sys]);

/**
 * An older room has only the English: the UI reads it back and says the same thing. `who`: as the UI passes it,
 * for a line an agent's action wrote.
 */
const sameInOldRooms = (message: MessageEntry, who?: string) => {
  assert.ok(message.sys, message.text);
  assert.equal(sysLine({ text: message.text }, who), sysLine(message, who), message.text);
  assert.equal(sysError({ text: message.text }), sysError(message), message.text);
};

test("the lines a run writes carry codes: budget reached, a turn that failed", async () => {
  const room = createTestRoom({
    settings: { budget: 3 },
    rules: [{ agent: "codex", error: "stream error: 429 Too Many Requests" }, { agent: "claude", reply: "Still thinking." }],
  });
  try {
    room.engine.tableOp({ op: "ask", text: "Which parser?" });
    room.engine.postHuman("Argue it out");
    await withTimeout(room.engine.waitIdle());
    const lines = room.store.state.messages.filter((message) => message.author === "agoryx");
    const failed = lines.find((message) => message.sys?.code === "turn.failed")!;
    const { message, ...rest } = failed.sys as Extract<SystemNote, { code: "turn.failed" }>;
    assert.deepEqual(rest, { code: "turn.failed", agent: "Codex", cli: "codex", error: "rate_limit" });
    assert.match(message, /429/);
    assert.doesNotMatch(message, /rate limit —/, "the code's message is the CLI's own, without the English hint");
    assert.match(failed.text, /^Codex could not finish its turn: .*429.* \(rate limit — it will retry on the next message\)$/s, "the English stays for the terminal");
    assert.ok(sysError(failed));
    assert.match(sysLine(failed), /^Codex: the turn could not finish — .*429.* \(rate limit — it will try again with the next message\)$/s);
    sameInOldRooms(failed);

    const budget = lines.find((message) => message.sys?.code === "run.budget")!;
    assert.deepEqual(budget.sys, { code: "run.budget", turns: 3, open: { questions: 1, options: 0, steps: 0, disputes: 0 } });
    assert.equal(sysError(budget), false);
    assert.equal(sysLine(budget), "The agents took 3 turns — the conversation is waiting for you. Still open on the table: 1 question.");
    sameInOldRooms(budget);
  } finally {
    await room.cleanup();
  }
});

test("what the human and agents do is said with a code: settings, rename, model, rounds, stops, decisions", async () => {
  const room = createTestRoom({ rules: [{ agent: "claude", match: "Long job", sleepMs: 20_000 }, { reply: "::pass::" }] });
  try {
    room.engine.updateSettings({ doc: "notes.md" });
    room.engine.updateSettings({ doc: null });
    room.engine.updateSettings({ network: false, budget: 5 }, "claude");
    room.engine.rename("Parser work", "codex");
    room.engine.updateAgent("claude", { model: "opus", effort: "high" });
    room.engine.updateAgent("codex", { effort: "low" }, "claude");
    room.engine.tableOp({ op: "ask", text: "Name?" });
    room.engine.tableOp({ op: "propose", title: "Agora" }, "claude");
    room.engine.tableOp({ op: "decide", target: "P1", note: "short and Greek" });
    await withTimeout(room.engine.waitIdle());
    room.engine.continueRun("claude");
    await withTimeout(room.engine.waitIdle());
    room.engine.postHuman("Long job");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await room.engine.stop();
    room.engine.postHuman("Long job");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await room.engine.stop("human", "codex");
    room.engine.postHuman("Long job");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await room.engine.stop("shutdown", "codex");

    const messages = room.store.state.messages;
    assert.deepEqual(coded(messages), [
      ["agoryx", { code: "doc.set", path: "notes.md" }],
      ["agoryx", { code: "doc.cleared" }],
      ["claude", { code: "settings.changed", by: "Claude", patch: { budget: 5, network: false } }],
      ["codex", { code: "room.renamed", by: "Codex", name: "Parser work" }],
      ["Ivan", { code: "agent.changed", by: "Ivan", agent: "Claude", model: "opus", effort: "high" }],
      ["claude", { code: "agent.changed", by: "Claude", agent: "Codex", effort: "low" }],
      ["Ivan", { code: "decision", n: 1, option: "P1", title: "Agora", note: "short and Greek", by: "Ivan" }],
      ["claude", { code: "run.continued", by: "Claude" }],
      ["agoryx", { code: "run.stopped", by: "Ivan" }],
      ["codex", { code: "run.stopped", by: "Codex" }],
      ["codex", { code: "daemon.stopped", by: "Codex" }],
    ]);

    // The UI's words, by code; an agent's own line is said by the name the UI gives it.
    const say = (code: string, who?: string) => sysLine(messages.find((message) => message.sys?.code === code && (!who || message.author !== "agoryx"))!, who);
    assert.equal(say("doc.set"), "The room’s shared document is now `notes.md`.");
    assert.equal(say("settings.changed", "Claude"), "Claude changes the settings: a limit of 5 turns per conversation, network off.");
    assert.equal(say("room.renamed", "Codex"), "Codex renames the room to “Parser work”.");
    assert.equal(say("agent.changed"), "Ivan changes Claude: model `opus`, effort — high.");
    assert.equal(say("decision"), "Decision #1: P1 “Agora” — short and Greek (decided by Ivan)");
    assert.equal(say("daemon.stopped", "Codex"), "Codex stops Agoryx, so the conversation was stopped.");
    const [humanStop, agentStop] = messages.filter((message) => message.sys?.code === "run.stopped");
    assert.equal(sysLine(humanStop!), "The conversation was stopped.");
    assert.equal(sysLine(agentStop!, "Codex"), "Codex stops the conversation.");
    assert.ok(messages.filter((message) => message.sys).every((message) => !sysError(message)), "none of them is an error");

    // An older room, English only, reads the same.
    for (const message of messages.filter((entry) => entry.sys)) sameInOldRooms(message, message.author === "agoryx" || message.author === "Ivan" ? undefined : message.author === "claude" ? "Claude" : "Codex");
    // A decision is a room's last line in the list, said in the UI's words.
    const decision = messages.find((message) => message.kind === "decision")!;
    assert.equal(roomPreview({ author: decision.author, text: decision.text, sys: decision.sys }), "You: Decision #1: P1 “Agora” — short and Greek (decided by Ivan)");
  } finally {
    await room.cleanup();
  }
});

test("a run cut short by a restart says so with a code", async () => {
  const room = createTestRoom();
  try {
    await room.engine.close();
    const crashed = RoomStore.open(room.roomsRoot, room.store.id);
    crashed.append({ type: "run.started", runId: "r9", trigger: null, budget: 4 });
    const reopened = RoomStore.open(room.roomsRoot, room.store.id);
    const engine = new RoomEngine({ store: reopened, runners: {}, env: room.env });
    const line = reopened.state.messages.at(-1)!;
    assert.deepEqual(line.sys, { code: "run.restarted" });
    assert.match(line.text, /^Agoryx restarted in the middle of a run/);
    sameInOldRooms(line);
    await engine.close();
  } finally {
    await room.cleanup();
  }
});

test("older rooms: lines no code covers are shown as written, and errors are still told by their words", () => {
  assert.equal(legacyNote("Something new happened."), null);
  assert.equal(sysLine({ text: "Something new happened." }), "Something new happened.");
  assert.equal(sysError({ text: "Hook error in the workspace." }), true);
  // "X set Y to Z." is an agent change only when every part is a model or an effort.
  assert.equal(legacyNote("I set the timeout to 5."), null);
  assert.deepEqual(legacyNote("Ivan set Claude to the CLI's default model, effort xhigh."), { code: "agent.changed", by: "Ivan", agent: "Claude", model: null, effort: "xhigh" });
  assert.equal(sysLine({ text: "Codex could not finish its turn: turn exceeded 20 min" }), "Codex: the turn could not finish — the turn ran past its time limit (20 min)");
  assert.equal(
    sysLine({ text: "Codex could not finish its turn: spawn ENOENT (is `codex` installed and on PATH?)" }),
    "Codex: the turn could not finish — spawn ENOENT (is `codex` installed and on your PATH?)",
  );
  assert.equal(
    sysLine({ text: "Turn budget reached (4 agent turns). Still open on the table: 2 open questions, 1 contested point — write anything, or ask for another round, to continue." }),
    "The agents took 4 turns — the conversation is waiting for you. Still open on the table: 2 questions, 1 disputed point.",
  );
});
