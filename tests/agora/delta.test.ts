import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AGENT_MESSAGE_FULL_CHARS, buildDelta, MAX_DELTA_CHARS, messageGist } from "../../internal/agora/prompts.js";
import { createTestRoom, withTimeout } from "./helpers.js";

const SHIM = join(dirname(fileURLToPath(import.meta.url)), "../../bin/agoryx-agent.mjs");
const filler = (tag: string, n = 5) => Array.from({ length: n }, (_, i) => `${tag} filler paragraph ${i}: ${"background detail ".repeat(20)}`).join("\n\n");

const LONG = [
  "Short version: the store should stay JSONL and we add an index next to it.",
  filler("A"),
  "@claude your snapshot idea breaks recovery when the index is ahead of the log.",
  filler("B"),
  "Я не згоден з тим, що SQLite тут потрібен: один файл на кімнату простіший.",
  filler("C"),
  "So: JSONL plus an index, and I will write the index today.",
].join("\n\n");

test("a long agent message arrives as its gist: start, end, what addresses the reader, what objects — and a pointer to the rest", () => {
  const gist = messageGist({ id: "m7", author: "codex", kind: "agent", text: LONG }, { id: "claude" }, "Ivan");
  assert.ok(gist.length < LONG.length / 3, `the gist is thin (${gist.length} of ${LONG.length})`);
  assert.match(gist, /^Short version: the store should stay JSONL/);
  assert.match(gist, /So: JSONL plus an index, and I will write the index today\./);
  assert.match(gist, /@claude your snapshot idea breaks recovery when the index is ahead of the log\./, "addressed to the reader: whole");
  assert.match(gist, /Я не згоден з тим, що SQLite тут потрібен: один файл на кімнату простіший\./, "an objection: whole");
  assert.doesNotMatch(gist, /filler paragraph/);
  assert.match(gist, /\[…\]/);
  assert.match(gist, /\[excerpt — \d+ of \d+ chars; the omitted part may qualify or reverse what is shown\. Before you agree with it, answer it or build on it: agoryx read m7\]$/);

  // Another reader is not addressed: that paragraph is not kept for them.
  const forGemini = messageGist({ id: "m7", author: "codex", kind: "agent", text: LONG }, { id: "gemini" }, "Ivan");
  assert.doesNotMatch(forGemini, /snapshot idea/);
  assert.match(forGemini, /Я не згоден/);
});

test("a Ukrainian objection in the middle of a long message is kept whole, like an English one", () => {
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `Абзац ${i}: ${"опис підходу без позиції. ".repeat(8)}`).join("\n\n");
  for (const stance of ["Я проти цього кроку: індекс ламає порядок повідомлень.", "Це не так, бо індекс ламає порядок повідомлень."]) {
    const text = `${filler(3)}\n\n${stance}\n\n${filler(3)}`;
    const gist = messageGist({ id: "m9", author: "codex", kind: "agent", text }, { id: "claude" }, "Ivan");
    assert.ok(gist.length < text.length, "the message is shortened");
    assert.ok(gist.includes(stance), `kept whole: ${stance}`);
  }
  // A word that only starts like one is not a stance.
  const text = `${filler(3)}\n\nПротилежний край екрана лишається порожнім.\n\n${filler(3)}`;
  assert.ok(!messageGist({ id: "m10", author: "codex", kind: "agent", text }, { id: "claude" }, "Ivan").includes("Протилежний"));
});

test("the human's words, decisions, Agoryx notices and short agent messages are never shortened", () => {
  const reader = { id: "claude" };
  assert.equal(messageGist({ id: "m1", author: "Ivan", kind: "human", text: LONG }, reader, "Ivan"), LONG);
  assert.equal(messageGist({ id: "m2", author: "codex", kind: "decision", text: LONG }, reader, "Ivan"), LONG);
  assert.equal(messageGist({ id: "m3", author: "agoryx", kind: "system", text: LONG }, reader, "Ivan"), LONG);
  const short = "x ".repeat(AGENT_MESSAGE_FULL_CHARS / 2).trim();
  assert.equal(messageGist({ id: "m4", author: "codex", kind: "agent", text: short }, reader, "Ivan"), short);
  // A fenced block is one paragraph: its inside is never taken apart.
  const fenced = ["Plan:", "```ts\nconst a = 1;\n\nconst b = 2;\n```", filler("D", 6), "Done."].join("\n\n");
  const gist = messageGist({ id: "m5", author: "codex", kind: "agent", text: fenced }, reader, "Ivan");
  assert.doesNotMatch(gist, /const a = 1;\n\n\[…\]/);
});

test("a delta over the bound drops the oldest agent entries, never the human's words", async () => {
  const room = createTestRoom();
  try {
    const events = [
      room.store.append({ type: "message.posted", message: { id: "m1", author: "Ivan", kind: "human", text: `OLD_HUMAN_CONSTRAINT ${"h ".repeat(20_000)}`, mentions: [], wakes: false } }),
    ];
    for (let n = 2; n < 120; n += 1) {
      const text = `AGENT_${n} ${"word ".repeat(220)}`;
      events.push(room.store.append({ type: "message.posted", message: { id: `m${n}`, author: "codex", kind: "agent", text, mentions: [], wakes: false } }));
    }
    const claude = room.store.state.agents.find((agent) => agent.id === "claude")!;
    const delta = buildDelta({ state: room.store.state, events, agent: claude, turnsLeft: 1 });
    assert.ok(delta.length < MAX_DELTA_CHARS + 5_000, `bounded (${delta.length})`);
    assert.match(delta, /OLD_HUMAN_CONSTRAINT/);
    assert.match(delta, /AGENT_119 /, "the newest stay");
    assert.doesNotMatch(delta, /AGENT_2 /, "the oldest agent entries go first");
    assert.match(delta, /\[… \d+ earlier entries omitted to keep this short — `agoryx read` lists the messages\]/);
  } finally {
    await room.cleanup();
  }
});

test("when every old message addresses the reader, the bound still holds: they shrink to stubs that keep the signal", async () => {
  const room = createTestRoom();
  try {
    const events: ReturnType<typeof room.store.append>[] = [];
    for (let n = 1; n < 150; n += 1) {
      const text = `@claude AGENT_${n} I disagree about the index. ${"word ".repeat(220)}`;
      events.push(room.store.append({ type: "message.posted", message: { id: `m${n}`, author: "codex", kind: "agent", text, mentions: ["claude"], wakes: false } }));
    }
    const claude = room.store.state.agents.find((agent) => agent.id === "claude")!;
    const delta = buildDelta({ state: room.store.state, events, agent: claude, turnsLeft: 1 });
    assert.ok(delta.length < MAX_DELTA_CHARS + 5_000, `bounded (${delta.length})`);
    assert.match(delta, /── Codex · \d\d:\d\d · addressed you, took a stance against something — shortened for length; the message: agoryx read m1\n/);
    assert.doesNotMatch(delta, /AGENT_1 /, "the oldest keep the signal, not the prose");
    assert.match(delta, /AGENT_149 I disagree/, "the newest stay as they were");
  } finally {
    await room.cleanup();
  }
});

test("the delta carries the gist, and `agoryx read` prints the whole message from inside the workspace", async () => {
  const room = createTestRoom({
    rules: [
      { agent: "codex", match: "Here is the conversation so far", reply: LONG },
      { agent: "claude", match: "Here is the conversation so far", reply: "Claude: SQLite." },
    ],
  });
  try {
    const ask = `How should we store rooms? ${"Context from the human, all of it matters. ".repeat(60)}`;
    room.engine.postHuman(ask);
    await withTimeout(room.engine.waitIdle());

    const codexMessage = room.store.state.messages.find((message) => message.author === "codex" && message.kind === "agent")!;
    const second = room.invocations("claude")[1]!.prompt!;
    assert.match(second, /^Short version: the store should stay JSONL/m);
    assert.doesNotMatch(second, /filler paragraph/);
    assert.ok(second.includes(`agoryx read ${codexMessage.id}]`));
    // The human's long message went to both agents whole.
    assert.ok(room.invocations("codex")[0]!.prompt!.includes(ask.trim()));
    // The briefing tells agents the tool exists.
    assert.match(room.invocations("claude")[0]!.prompt!, /read m12` prints any message whole/);

    const workspace = room.store.state.workspace;
    const roomId = room.store.state.id;
    const file = join(workspace, ".agoryx", "messages", roomId, `${codexMessage.id}.md`);
    assert.ok(readFileSync(file, "utf8").includes(LONG));

    // As in a room turn: only the workspace and the room's id.
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [SHIM, ...args], { cwd: workspace, encoding: "utf8", env: { PATH: process.env.PATH, AGORYX_ROOM: roomId } });
    const read = run("read", codexMessage.id);
    assert.equal(read.status, 0, read.stderr);
    assert.match(read.stdout, new RegExp(`^# ${codexMessage.id} · codex · .* UTC · turn t\\d+\\n\\n`));
    assert.ok(read.stdout.includes(LONG));
    const list = run("read");
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, new RegExp(`${codexMessage.id} · codex .* chars\\n   Short version`));
    assert.match(run("read", "m999").stderr, /no message m999/);
    assert.match(run("read", "../x").stderr, /not a message id/);

    // Another room in the same workspace has its own m1: neither overwrites the other.
    const other = join(workspace, ".agoryx", "messages", "other-room");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "m1.md"), "# m1 · codex · 2026-09-29 05:00 UTC\n\nfrom the other room\n");
    assert.doesNotMatch(run("read", "m1").stdout, /from the other room/);
    assert.match(run("read", "m1", "--room", "other-room").stdout, /from the other room/);
    assert.ok(readFileSync(join(workspace, ".agoryx", "messages", roomId, "m1.md"), "utf8").includes("How should we store rooms?"));

    // A room from before .agoryx/messages/ existed gets its messages written when it opens again.
    rmSync(join(workspace, ".agoryx", "messages"), { recursive: true, force: true });
    await room.engine.close();
    const { RoomEngine } = await import("../../internal/agora/engine.js");
    const reopened = new RoomEngine({ store: room.store, runners: {}, shimDir: room.shimDir, env: room.env });
    try {
      assert.ok(existsSync(file));
    } finally {
      await reopened.close();
    }
  } finally {
    await room.cleanup();
  }
});

test("a stance left only in prose is pointed out to its author next turn — once, and not when the turn put it on the table", async () => {
  const QUESTION = "Open question for @codex: a price below the smallest unit is quietly rounded. I'd rather refuse it.";
  const room = createTestRoom({
    rules: [
      { agent: "claude", match: "Split the bill", once: true, reply: `Tests are in.\n\n${QUESTION}` },
      { agent: "codex", match: "Split the bill", once: true, reply: "Implementation is in. @claude over to you." },
      { agent: "claude", match: "over to you", once: true, table: [["table", "ask", "Refuse sub-unit prices?"]], reply: "I would still refuse them, @codex." },
      { agent: "codex", match: "still refuse", once: true, reply: "@claude kept rounding for now." },
      { agent: "claude", match: "kept rounding", once: true, reply: "::pass::" },
      { agent: "codex", reply: "::pass::" },
    ],
  });
  try {
    room.engine.postHuman("Split the bill, @claude @codex");
    await withTimeout(room.engine.waitIdle());
    const prompts = room.invocations("claude").map((call) => call.prompt!);
    assert.ok(prompts.length >= 3, `${prompts.length} claude turns`);
    assert.match(prompts[1]!, /Your reply in t\d+ said this only in prose — nothing of it is on the table: "Open question for @codex: a price below/);
    assert.match(prompts[1]!, /agoryx table ask` \/ `object`.*agoryx table concede/);
    // The next turn asked on the table: nothing to point out; and the first stance is not repeated.
    assert.doesNotMatch(prompts[2]!, /said this only in prose/);
    // Codex's plain handover took no stance: nothing for Codex either.
    for (const prompt of room.invocations("codex").map((call) => call.prompt!)) assert.doesNotMatch(prompt, /said this only in prose/);
  } finally {
    await room.cleanup();
  }
});
