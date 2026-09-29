import assert from "node:assert/strict";
import { test } from "node:test";
import { jevSecondLook, jevThreshold, type SecondLookCase } from "../../internal/agora/jev.js";
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
