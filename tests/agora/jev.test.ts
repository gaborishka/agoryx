import assert from "node:assert/strict";
import { test } from "node:test";
import { jevReadMessage, jevSecondLook, jevThreshold, type MessageCase, type ReadMessage, type SecondLookCase } from "../../internal/agora/jev.js";
import { createTestRoom, withTimeout } from "./helpers.js";

test("Jev judges a second look worth a turn: Agoryx says so, and only that agent is woken", async () => {
  const asked: SecondLookCase[] = [];
  const room = createTestRoom({
    rules: [
      { agent: "claude", match: "fix the parser", write: { path: "csv.ts", content: "export const parse = () => [];\n" }, reply: "Fixed csv.ts." },
      { agent: "codex", reply: "Looked: the empty case is wrong." },
    ],
    secondLook: async (entry) => {
      asked.push(entry);
      // Slow on purpose: the run must wait for it rather than end quiet first.
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { worth: { codex: 0.81 }, ms: 300, tokens: 120 };
    },
  });
  try {
    room.engine.postHuman("@claude fix the parser");
    await withTimeout(room.engine.waitIdle());
    assert.equal(asked.length, 1);
    assert.deepEqual(
      { question: asked[0]!.question, by: asked[0]!.answeredBy, answer: asked[0]!.answer, changed: asked[0]!.changed, others: asked[0]!.others },
      { question: "@claude fix the parser", by: "Claude", answer: "Fixed csv.ts.", changed: ["csv.ts +1 −0"], others: [{ id: "codex", label: "Codex" }] },
    );
    const messages = room.store.state.messages;
    const note = messages.find((message) => message.author === "agoryx" && message.text.startsWith("Jev:"))!;
    assert.equal(note.text, "Jev: a second look at Claude's answer seems worth a turn (Codex 81%) — Codex takes a look.");
    assert.deepEqual(note.mentions, ["codex"]);
    const codex = room.invocations("codex");
    assert.equal(codex.length, 1, "woken by the note");
    assert.match(codex[0]!.prompt!, /Fixed csv\.ts\./);
    assert.ok(messages.some((message) => message.author === "codex" && message.text.startsWith("Looked")));
  } finally {
    await room.cleanup();
  }
});

test("Jev unsure, or out of reach: the answer stays with the human and the run ends quiet", async () => {
  for (const secondLook of [
    async () => ({ worth: { codex: 0.2 }, ms: 5, tokens: 50 }),
    async () => Promise.reject(new Error("Jev 503: busy")),
  ]) {
    const room = createTestRoom({ rules: [{ agent: "claude", reply: "Sonnet." }], secondLook });
    try {
      room.engine.postHuman("@claude which model are you on?");
      await withTimeout(room.engine.waitIdle());
      assert.equal(room.invocations("codex").length, 0);
      assert.ok(!room.store.state.messages.some((message) => message.author === "agoryx"));
      assert.equal(room.store.state.runs.at(-1)?.endReason, "quiet");
    } finally {
      await room.cleanup();
    }
  }
});

test("Jev is not asked when the answer already names someone, or the human asked everyone", async () => {
  let asked = 0;
  const room = createTestRoom({
    rules: [
      { agent: "claude", match: "ask codex", reply: "@codex your view?" },
      { reply: "::pass::" },
    ],
    secondLook: async () => {
      asked += 1;
      return { worth: {}, ms: 1, tokens: 1 };
    },
  });
  try {
    room.engine.postHuman("@claude ask codex");
    await withTimeout(room.engine.waitIdle());
    room.engine.postHuman("anything to add?");
    await withTimeout(room.engine.waitIdle());
    assert.equal(asked, 0);
  } finally {
    await room.cleanup();
  }
});

test("Jev is set up from the daemon's environment: a key turns it on, AGORYX_JEV=off keeps it off", async () => {
  assert.equal(jevSecondLook({}), null);
  assert.equal(jevSecondLook({ TYPESAFE_API_KEY: "k", AGORYX_JEV: "off" }), null);
  assert.deepEqual([jevThreshold({}), jevThreshold({ AGORYX_JEV_THRESHOLD: "0.7" }), jevThreshold({ AGORYX_JEV_THRESHOLD: "7" })], [0.5, 0.7, 0.5]);

  const sent: Array<{ url: string; auth: string; body: { model: string; state: Record<string, string>; questions: Record<string, { type: string }> } }> = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, auth: (init.headers as Record<string, string>).Authorization!, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ answers: { "look:codex": { noul: 0.64 } }, usage: { input_tokens: 321 } }), { status: 200 });
  }) as typeof fetch;
  const look = jevSecondLook({ OPENROUTER_API_KEY: "or-key" }, fakeFetch)!;
  const verdict = await look({ question: "@claude fix it", answeredBy: "Claude", answer: "x".repeat(10_000), changed: ["a.ts +1 −0"], others: [{ id: "codex", label: "Codex" }] });
  assert.deepEqual([verdict.worth, verdict.tokens], [{ codex: 0.64 }, 321]);
  assert.equal(sent[0]!.url, "https://openrouter.ai/api/alpha/decisions");
  assert.equal(sent[0]!.auth, "Bearer or-key");
  assert.equal(sent[0]!.body.model, "typesafe/jev-1.13");
  assert.equal(sent[0]!.body.questions["look:codex"]!.type, "noul");
  assert.ok(sent[0]!.body.state.answer!.length < 6_100, "a long answer is sent as its start and end");
  assert.equal(sent[0]!.body.state.files_changed_by_the_answer, "a.ts +1 −0");

  const refusing = jevSecondLook({ TYPESAFE_API_KEY: "k" }, (async () => new Response(JSON.stringify({ detail: "bad key" }), { status: 401 })) as unknown as typeof fetch)!;
  await assert.rejects(refusing({ question: "q", answeredBy: "Claude", answer: "a", changed: [], others: [{ id: "codex", label: "Codex" }] }), /Jev 401: bad key/);
});

/** Jev reading each message: meant for whoever the message names in `meant`, a position in paragraphs matching `stance`. */
const reader =
  (meant: Record<string, string>, stance?: RegExp, seen: MessageCase[] = []): ReadMessage =>
  async (entry) => {
    seen.push(entry);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const text = entry.paragraphs.join("\n\n");
    const addressed = Object.fromEntries(entry.others.map((other) => [other.id, meant[other.id] && text.includes(meant[other.id]!) ? 0.93 : 0.1]));
    return { addressed, stances: entry.paragraphs.map((part) => (stance?.test(part) ? 0.91 : 0.2)), ms: 50, tokens: 500 };
  };

test("Jev reads a mid-turn say as meant for an idle agent, with no @: a note says so, and that agent starts at once", async () => {
  const room = createTestRoom({
    rules: [
      { agent: "codex", once: true, reply: "codex first" },
      { agent: "claude", once: true, sleepMs: 800, table: [["say", "Codex, could you run the daemon tests? Mine time out."]], afterTableMs: 4000, reply: "claude done" },
      { agent: "codex", match: "could you run the daemon tests", once: true, reply: "daemon tests pass" },
    ],
    settings: { budget: 6 },
    readMessage: reader({ codex: "Codex, could you" }),
  });
  try {
    room.engine.postHuman("Split the work");
    await withTimeout(room.engine.waitIdle());
    const state = room.store.state;
    const ask = state.messages.find((message) => message.kind === "update")!;
    assert.equal(ask.wakes, false, "no @: by the @ rule it wakes nobody");
    const note = state.messages.find((message) => message.author === "agoryx" && message.text.startsWith("Jev:"))!;
    assert.equal(note.text, `Jev: Claude's ${ask.id} reads as meant for Codex (Codex 93%), with no @ — Codex is woken to answer it.`);
    assert.deepEqual(note.mentions, ["codex"]);
    const claudeTurn = state.turns.find((turn) => turn.agent === "claude")!;
    const codexAsked = state.turns.filter((turn) => turn.agent === "codex")[1];
    assert.ok(codexAsked, "the agent it was meant for got a turn");
    assert.ok(codexAsked!.seq < claudeTurn.endSeq!, "it started while the asker was still working, not after");
    assert.ok(room.store.since(0).some((event) => event.type === "message.read" && event.messageId === ask.id), "the reading is kept in the room");
  } finally {
    await room.cleanup();
  }
});

test("Jev reads an answer to the human as meant for another agent: that agent is woken, and no second look is asked", async () => {
  let looks = 0;
  const room = createTestRoom({
    rules: [
      { agent: "claude", match: "which tests fail", reply: "Two fail in daemon.test.ts. Codex, can you check whether your runner change caused them?" },
      { agent: "codex", reply: "Not mine: they fail on main too." },
    ],
    readMessage: reader({ codex: "Codex, can you" }),
    secondLook: async () => {
      looks += 1;
      return { worth: { codex: 0.9 }, ms: 1, tokens: 1 };
    },
  });
  try {
    room.engine.postHuman("@claude which tests fail?");
    await withTimeout(room.engine.waitIdle());
    const messages = room.store.state.messages;
    assert.ok(messages.some((message) => message.author === "codex" && message.text.startsWith("Not mine")));
    assert.equal(messages.filter((message) => message.author === "agoryx").length, 1, "one note, not two");
    assert.equal(looks, 0);
    assert.equal(room.invocations("codex").length, 1);
  } finally {
    await room.cleanup();
  }
});

test("Jev reads nothing meant for anyone: the answer to the human alone still gets its second look; a message that already woke everyone wakes nobody twice", async () => {
  let looks = 0;
  const room = createTestRoom({
    rules: [
      { agent: "claude", match: "which model", reply: "Sonnet." },
      { agent: "claude", match: "split", reply: "Codex, you take the parser." },
      { agent: "codex", reply: "::pass::" },
    ],
    readMessage: reader({ codex: "Codex, you take" }),
    secondLook: async () => {
      looks += 1;
      return { worth: { codex: 0.1 }, ms: 1, tokens: 1 };
    },
  });
  try {
    room.engine.postHuman("@claude which model are you on?");
    await withTimeout(room.engine.waitIdle());
    assert.equal(looks, 1);
    assert.equal(room.invocations("codex").length, 0);
    room.engine.postHuman("split the work");
    await withTimeout(room.engine.waitIdle());
    assert.ok(!room.store.state.messages.some((message) => message.author === "agoryx"), "the reply woke Codex already: no note");
  } finally {
    await room.cleanup();
  }
});

test("a position Jev finds in a reply the word lists miss is quoted back to its author, if the turn left it off the table", async () => {
  const room = createTestRoom({
    rules: [
      { agent: "claude", match: "Split the bill", once: true, sleepMs: 300, reply: "Tests are in.\n\nSub-unit prices get rounded half-up; refusing them seems safer to me, but that file is not mine." },
      { agent: "codex", match: "Split the bill", once: true, reply: "Implementation is in. @claude over to you." },
      { agent: "claude", match: "over to you", once: true, reply: "::pass::" },
      { reply: "::pass::" },
    ],
    readMessage: reader({}, /refusing them/),
  });
  try {
    room.engine.postHuman("Split the bill, @claude @codex");
    await withTimeout(room.engine.waitIdle());
    const prompts = room.invocations("claude").map((call) => call.prompt ?? "");
    assert.ok(prompts.length >= 2, `${prompts.length} claude turns`);
    assert.match(prompts[1]!, /said this only in prose — nothing of it is on the table: "Sub-unit prices get rounded half-up; refusing them seems safer/);
    assert.doesNotMatch("Sub-unit prices get rounded half-up; refusing them seems safer to me, but that file is not mine.", /\b(disagree|object|rather|instead|open question|question for)\b/i, "the word lists alone would miss it");
  } finally {
    await room.cleanup();
  }
});

test("Jev's reading sends the message by paragraph and asks who it is meant for", async () => {
  assert.equal(jevReadMessage({}), null);
  assert.equal(jevReadMessage({ TYPESAFE_API_KEY: "k", AGORYX_JEV: "off" }), null);
  const sent: Array<{ state: Record<string, string>; questions: Record<string, { instructions: string }> }> = [];
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ answers: { "to:codex": { noul: 0.97 }, p2: { noul: 0.88 } }, usage: { input_tokens: 612 } }), { status: 200 });
  }) as typeof fetch;
  const read = jevReadMessage({ TYPESAFE_API_KEY: "k" }, fakeFetch)!;
  const verdict = await read({ author: "Claude", paragraphs: ["ok", "Codex, I'd rather refuse sub-unit prices than round them."], others: [{ id: "codex", label: "Codex" }] });
  assert.deepEqual([verdict.addressed, verdict.stances, verdict.tokens], [{ codex: 0.97 }, [null, 0.88], 612]);
  assert.deepEqual(Object.keys(sent[0]!.questions), ["to:codex", "p2"], "a two-letter paragraph is not asked about");
  assert.equal(sent[0]!.state.paragraph_2, "Codex, I'd rather refuse sub-unit prices than round them.");
  assert.match(sent[0]!.questions["to:codex"]!.instructions, /whether or not it writes @codex/);
});
