import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JEV_CHATGPT_MODEL, jevProvider, jevReadMessage, jevSecondLook } from "../../internal/agora/jev.js";
import { chatgptDir, readAccounts, saveAccount, type ChatGptAccount } from "../../internal/chatgpt/credentials.js";
import { runChatGpt } from "../../cmd/agoryx/chatgpt.js";
import { createTestRoom, withTimeout } from "./helpers.js";

const home = (): NodeJS.ProcessEnv => ({ AGORYX_HOME: join(mkdtempSync(join(tmpdir(), "agoryx-jev-chatgpt-")), "agora") });

const account = (overrides: Partial<ChatGptAccount> = {}): ChatGptAccount => ({
  clientId: "oaiapp_first",
  issuer: "https://auth.openai.com",
  subject: "user-1",
  email: "ivan@example.com",
  name: null,
  scopes: ["chatgpt.tokens.use.direct", "openid"],
  idToken: "idt",
  accessToken: "at-1",
  refreshToken: "rt-1",
  expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  earliestRefreshAt: null,
  savedAt: new Date().toISOString(),
  ...overrides,
});

const signedIn = (overrides: Partial<ChatGptAccount> = {}, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const env = { ...home(), ...extra };
  saveAccount(chatgptDir(env), account(overrides));
  return env;
};

/** api.openai.com answering /v1/responses with `reply` as the streamed JSON text; each request body is kept. */
const plan = (reply: Record<string, unknown> | ((body: Record<string, unknown>) => Response | Record<string, unknown>)) => {
  const sent: Array<{ url: string; auth: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sent.push({ url: String(url), auth: (init?.headers as Record<string, string>).Authorization!, body });
    const answer = typeof reply === "function" ? reply(body) : reply;
    if (answer instanceof Response) return answer;
    const text = JSON.stringify(answer);
    const events = [
      { type: "response.output_text.delta", delta: text.slice(0, 5) },
      { type: "response.output_text.delta", delta: text.slice(5) },
      { type: "response.completed", response: { usage: { input_tokens: 240, output_tokens: 12 } } },
    ];
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as typeof fetch;
  return { sent, fetchImpl };
};

const lookCase = { question: "@claude fix it", answeredBy: "Claude", answer: "Fixed.", changed: [], others: [{ id: "codex", label: "Codex" }] };

test("a ChatGPT sign-in with plan use stands in for a Jev key; a key, a declined plan, a sign-out or AGORYX_JEV=off does not", () => {
  const env = signedIn();
  assert.deepEqual(jevProvider(env), {
    name: "chatgpt",
    label: JEV_CHATGPT_MODEL,
    via: "ChatGPT plan, ivan@example.com",
    model: JEV_CHATGPT_MODEL,
    dir: chatgptDir(env),
  });
  assert.ok(jevSecondLook(env));
  assert.ok(jevReadMessage(env));

  assert.equal(jevProvider(home()), null, "nobody signed in");
  assert.equal(jevProvider(signedIn({ scopes: ["openid"] })), null, "plan use declined");
  assert.equal(jevProvider(signedIn({ accessToken: null, refreshToken: null })), null, "signed out");
  assert.equal(jevProvider({ ...env, AGORYX_JEV: "off" }), null);

  assert.equal(jevProvider({ ...env, TYPESAFE_API_KEY: "k" })?.name, "typesafe", "a Jev key goes first");
  assert.equal(jevProvider({ ...env, TYPESAFE_API_KEY: "k", JEV_PROVIDER: "chatgpt" })?.name, "chatgpt");
  assert.equal(jevProvider({ ...env, JEV_PROVIDER: "openrouter" }), null, "the key it names, or nobody");
  assert.equal(jevProvider({ ...env, AGORYX_JEV_MODEL: "gpt-5.5" })?.label, "gpt-5.5");
});

test("the second look goes to the plan as one structured request: a probability per question, quickly, not stored", async () => {
  const env = signedIn();
  const { sent, fetchImpl } = plan({ "look:codex": 0.72 });
  const verdict = await jevSecondLook(env, fetchImpl)!(lookCase);
  assert.deepEqual(verdict, { worth: { codex: 0.72 }, ms: verdict.ms, tokens: 240, by: JEV_CHATGPT_MODEL });

  const { url, auth, body } = sent[0]!;
  assert.equal(url, "https://api.openai.com/v1/responses");
  assert.equal(auth, "Bearer at-1");
  assert.equal(body.model, JEV_CHATGPT_MODEL);
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.deepEqual(body.reasoning, { effort: "none" });
  const format = (body.text as { format: { type: string; strict: boolean; schema: { required: string[]; additionalProperties: boolean } } }).format;
  assert.equal(format.type, "json_schema");
  assert.equal(format.strict, true);
  assert.deepEqual(format.schema.required, ["look:codex"]);
  assert.equal(format.schema.additionalProperties, false);
  const input = JSON.parse((body.input as Array<{ content: string }>)[0]!.content) as {
    situation: Record<string, string>;
    questions: Record<string, { question: string; yes: string; no: string }>;
  };
  assert.equal(input.situation.answer, "Fixed.");
  assert.match(input.questions["look:codex"]!.question, /worth waking Codex/);
  assert.equal(input.questions["look:codex"]!.yes, "Yes, wake Codex");
});

test("the reading of a message comes back per agent and paragraph, clamped to 0–1", async () => {
  const { fetchImpl } = plan({ "to:codex": 1.4, p2: 0.88 });
  const verdict = await jevReadMessage(signedIn(), fetchImpl)!({
    author: "Claude",
    paragraphs: ["ok", "Codex, I'd rather refuse sub-unit prices than round them."],
    others: [{ id: "codex", label: "Codex" }],
  });
  assert.deepEqual([verdict.addressed, verdict.stances, verdict.by], [{ codex: 1 }, [null, 0.88], JEV_CHATGPT_MODEL]);
});

test("a model that takes no reasoning effort 'none' is asked without it, then and after", async () => {
  const env = signedIn({}, { AGORYX_JEV_MODEL: "gpt-5.5" });
  const { sent, fetchImpl } = plan((body) =>
    body.reasoning
      ? new Response(JSON.stringify({ error: { message: "Unsupported value: 'none'", param: "reasoning.effort", code: "unsupported_value" } }), { status: 400 })
      : { "look:codex": 0.3 },
  );
  const look = jevSecondLook(env, fetchImpl)!;
  assert.deepEqual((await look(lookCase)).worth, { codex: 0.3 });
  assert.deepEqual((await look(lookCase)).worth, { codex: 0.3 });
  assert.deepEqual(
    sent.map((entry) => [entry.body.model, entry.body.reasoning ?? null]),
    [
      ["gpt-5.5", { effort: "none" }],
      ["gpt-5.5", null],
      ["gpt-5.5", null],
    ],
  );
});

test("the plan out of reach, or signed out since, rejects: the room goes by @names alone", async () => {
  const env = signedIn();
  const refusing = plan(() => new Response(JSON.stringify({ error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } }), { status: 429 }));
  await assert.rejects(jevSecondLook(env, refusing.fetchImpl)!(lookCase), /limit/);
  const look = jevSecondLook(env, plan({ "look:codex": 0.9 }).fetchImpl)!;
  saveAccount(chatgptDir(env), account({ accessToken: null, refreshToken: null }));
  await assert.rejects(look(lookCase), /not signed in/);
  const garbled = plan(() => new Response('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"sure!"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{}}\n\n', { status: 200 }));
  await assert.rejects(jevSecondLook(signedIn(), garbled.fetchImpl)!(lookCase), /did not answer in JSON/);
});

test("the room is told which model judged, not Jev", async () => {
  const room = createTestRoom({
    rules: [
      { agent: "claude", match: "fix the parser", reply: "Fixed csv.ts." },
      { agent: "codex", reply: "Looked." },
      { reply: "::pass::" },
    ],
    secondLook: async () => ({ worth: { codex: 0.81 }, ms: 2000, tokens: 240, by: "gpt-5.6-luna" }),
  });
  try {
    room.engine.postHuman("@claude fix the parser");
    await withTimeout(room.engine.waitIdle());
    const note = room.store.state.messages.find((message) => message.author === "agoryx")!;
    assert.equal(note.text, "gpt-5.6-luna: a second look at Claude's answer seems worth a turn (Codex 81%) — Codex takes a look.");
  } finally {
    await room.cleanup();
  }
});

test("an agent's commands cannot use or end the human's ChatGPT sign-in", async () => {
  const env = signedIn();
  const saved = { home: process.env.AGORYX_HOME, agent: process.env.AGORYX_AGENT };
  const errors: string[] = [];
  const error = console.error;
  process.env.AGORYX_HOME = env.AGORYX_HOME;
  process.env.AGORYX_AGENT = "codex";
  console.error = (line: string) => errors.push(line);
  try {
    assert.equal(await runChatGpt("logout", ["chatgpt"]), 1);
    assert.equal(await runChatGpt("chatgpt", ["test"]), 1);
  } finally {
    console.error = error;
    for (const [name, value] of [["AGORYX_HOME", saved.home], ["AGORYX_AGENT", saved.agent]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  assert.match(errors[0]!, /not for an agent's commands/);
  assert.equal(readAccounts(chatgptDir(env)).accounts.oaiapp_first?.refreshToken, "rt-1", "still signed in");
});
