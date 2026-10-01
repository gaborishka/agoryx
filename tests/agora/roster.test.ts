import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentKey } from "../../internal/agora/actor.js";
import { AgoraDaemon } from "../../internal/agora/daemon.js";
import { locateNativeSession } from "../../internal/agora/native.js";
import { DEFAULT_AGENTS, parseAgents, readRoster, RosterError, rosterPath } from "../../internal/agora/roster.js";
import { buildClaudeArgs, createClaudeRunner } from "../../internal/agora/runners/claude.js";
import { buildCodexArgs, createCodexRunner } from "../../internal/agora/runners/codex.js";
import { createRoom, resumeCommands } from "../../internal/agora/service.js";
import { RoomStore } from "../../internal/agora/store.js";
import { DEFAULT_SETTINGS } from "../../internal/agora/types.js";
import { agentCliScript } from "../../internal/agora/workspace.js";
import { names, roomPreview } from "../../ui/src/lib/format.js";
import { buildFeed } from "../../ui/src/lib/room.js";
import { createTestRoom, withTimeout, writeFakeBins, type TestRoom } from "./helpers.js";

/** Two Claudes on different models and Codex: the example the concept promises costs only JSON. */
const TRIO = [
  { id: "opus", kind: "claude", model: "opus" },
  { id: "sonnet", kind: "claude", model: "sonnet" },
  { kind: "codex" },
];

const scratch = () => mkdtempSync(join(tmpdir(), "agora-roster-"));

const waitUntil = async (check: () => boolean, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const started = (room: TestRoom, turnId: string) =>
  room.store.events.find((event) => event.type === "turn.started" && event.turnId === turnId)!.seq;
const ended = (room: TestRoom, turnId: string) => room.store.events.find((event) => event.type === "turn.ended" && event.turnId === turnId)!.seq;
/** Every fake CLI call made for one room agent (the room sets AGORYX_AGENT to its id). */
const callsOf = (room: TestRoom, id: string) => room.invocations().filter((entry) => entry.env?.AGORYX_AGENT === id);

// --- the JSON ------------------------------------------------------------------------------

test("a roster is a few lines of JSON: kind picks the CLI, the rest has defaults", () => {
  assert.deepEqual(parseAgents(TRIO), [
    { id: "opus", kind: "claude", label: "Opus", model: "opus" },
    { id: "sonnet", kind: "claude", label: "Sonnet", model: "sonnet" },
    { id: "codex", kind: "codex", label: "Codex" },
  ]);
  assert.deepEqual(parseAgents({ agents: [{ kind: "claude" }, { kind: "codex" }] }), DEFAULT_AGENTS);
  assert.deepEqual(parseAgents([{ id: "gpt5", kind: "codex", label: "GPT-5 high", model: " gpt-5 " }]), [
    { id: "gpt5", kind: "codex", label: "GPT-5 high", model: "gpt-5" },
  ]);
  assert.deepEqual(readRoster(JSON.stringify(TRIO)).map((agent) => agent.id), ["opus", "sonnet", "codex"]);
});

test("a roster the room could not work with is refused, naming the entry", () => {
  const refused = (raw: unknown, pattern: RegExp) => assert.throws(() => parseAgents(raw), (error: unknown) => error instanceof RosterError && pattern.test(error.message));
  refused([], /non-empty list/);
  refused({ kind: "claude" }, /non-empty list/);
  refused([{ kind: "gemini" }], /agents\[0\]: "kind" must be one of claude, codex/);
  refused([{ kind: "claude", modle: "opus" }], /unknown field "modle"/);
  // Two of a kind need their own ids: both would be "claude", and messages are told apart by author.
  refused([{ kind: "claude", model: "opus" }, { kind: "claude", model: "sonnet" }], /agents\[1\]: two agents are called "claude"/);
  // @mentions are lower-cased, so an id with capitals could never be addressed.
  refused([{ id: "Opus", kind: "claude" }], /lower-case/);
  refused([{ id: "o", kind: "claude" }], /"id" must be/);
  refused([{ id: "gpt 5", kind: "codex" }], /"id" must be/);
  refused([{ id: "all", kind: "claude" }], /reserved/);
  refused([{ id: "agoryx", kind: "claude" }], /reserved/);
  refused([{ id: "opus", kind: "claude", label: "Claude" }, { id: "claude", kind: "claude" }], /two agents are labelled "Claude"/);
  refused([{ kind: "claude", model: "--dangerously-skip-permissions" }], /"model" must be a model name/);
  refused([{ kind: "codex", effort: 'xhigh" -c sandbox_mode="danger-full-access' }], /"effort" must be a level name/);
  refused([{ kind: "claude", effort: "--max" }], /"effort" must be a level name/);
  assert.throws(() => readRoster("[{"), /not valid JSON/);
  assert.throws(() => readRoster("missing-roster.json", scratch()), /cannot read .*missing-roster\.json/);
});

test("new rooms seat the roster in AGORYX_HOME/agents.json; a room's own roster wins; the room keeps its roster", () => {
  const home = scratch();
  const env: NodeJS.ProcessEnv = { ...process.env, AGORYX_HOME: join(home, "agora"), AGORYX_USER: "Ivan" };
  const dir = (name: string) => {
    const path = join(home, name);
    mkdirSync(path, { recursive: true });
    return path;
  };
  try {
    assert.deepEqual(createRoom({ name: "Default", dir: dir("a"), env }).state.agents, DEFAULT_AGENTS, "no file: Claude and Codex");

    mkdirSync(join(home, "agora"), { recursive: true });
    writeFileSync(rosterPath(env), JSON.stringify(TRIO, null, 2));
    const trio = createRoom({ name: "Trio", dir: dir("b"), env });
    assert.deepEqual(trio.state.agents.map((agent) => [agent.id, agent.kind, agent.model]), [
      ["opus", "claude", "opus"],
      ["sonnet", "claude", "sonnet"],
      ["codex", "codex", undefined],
    ]);
    const own = createRoom({ name: "Own", dir: dir("c"), env, agents: [{ id: "haiku", kind: "claude", model: "haiku" }, { kind: "codex" }] });
    assert.deepEqual(own.state.agents.map((agent) => agent.id), ["haiku", "codex"]);

    // Changing the file changes only new rooms: the roster is in the room's own log.
    writeFileSync(rosterPath(env), JSON.stringify([{ kind: "codex" }]));
    assert.deepEqual(RoomStore.open(join(home, "agora", "rooms"), trio.state.id).state.agents.map((agent) => agent.id), ["opus", "sonnet", "codex"]);

    // A roster that came as JSON over the API is checked like the file.
    assert.throws(() => createRoom({ name: "Bad", dir: dir("d"), env, agents: [{ kind: "claude" }, { kind: "claude" }] }), RosterError);
    writeFileSync(rosterPath(env), "{ not json");
    assert.throws(() => createRoom({ name: "Broken", dir: dir("e"), env }), /agents\.json: not valid JSON/);
    // A human named like an agent's label would be taken for that agent, not only one named like its id.
    assert.throws(
      () => createRoom({ name: "Clash", dir: dir("f"), env, human: "Opus", agents: [{ id: "opus4", kind: "claude", label: "Opus" }] }),
      /taken by an agent/,
    );

    // A refused room leaves nothing behind: Agoryx claims a workspace folder only once all the checks pass.
    const workspaces = join(home, "workspaces");
    const noDir = { ...env, AGORYX_WORKSPACES: workspaces };
    assert.throws(() => createRoom({ name: "Bad roster", env: noDir, agents: [{ kind: "gemini" }] }), RosterError);
    assert.throws(() => createRoom({ name: "Bad budget", env: noDir, agents: [{ kind: "codex" }], budget: 0 }), /turn budget/);
    assert.throws(() => createRoom({ name: "Bad human", env: noDir, agents: [{ kind: "codex" }], human: "codex" }), /taken by an agent/);
    assert.equal(existsSync(workspaces), false, "no folder for a room that was refused");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// --- three agents in one room --------------------------------------------------------------

test("three agents: a blind round of three in parallel, then one at a time; each Claude on its own model and session", async () => {
  const room = createTestRoom({
    agents: parseAgents(TRIO),
    rules: [
      { id: "opus", match: "Hello all", sleepMs: 300, reply: "Opus: event log.", once: true },
      { id: "sonnet", match: "Hello all", sleepMs: 300, reply: "Sonnet: SQLite.", once: true },
      { id: "codex", match: "Hello all", sleepMs: 300, reply: "Codex: JSONL.", once: true },
      { id: "codex", match: "Sonnet: SQLite.", reply: "Codex answers Sonnet.", once: true },
    ],
  });
  try {
    room.engine.postHuman("Hello all");
    await withTimeout(room.engine.waitIdle());
    const { turns, messages, sessions } = room.store.state;
    const [a, b, c, ...rest] = turns;
    assert.deepEqual([a, b, c].map((turn) => turn!.agent).sort(), ["codex", "opus", "sonnet"]);
    const firstEnd = Math.min(...[a, b, c].map((turn) => ended(room, turn!.id)));
    for (const turn of [a, b, c]) assert.ok(started(room, turn!.id) < firstEnd, `${turn!.agent} answered the human blind, in parallel`);
    assert.ok(rest.length >= 3, `the conversation went on, got ${rest.length} more turns`);
    for (let i = 1; i < rest.length; i += 1) assert.ok(started(room, rest[i]!.id) > ended(room, rest[i - 1]!.id), "then one at a time");

    // The parallel round starts from the same point: no prompt carries another's first answer.
    for (const id of ["opus", "sonnet", "codex"]) {
      const first = callsOf(room, id)[0]!.prompt!;
      assert.match(first, /Hello all/);
      for (const other of ["Opus: event log.", "Sonnet: SQLite.", "Codex: JSONL."]) assert.doesNotMatch(first, new RegExp(other));
    }
    // Everyone is introduced to both others, by name and @handle.
    assert.match(callsOf(room, "opus")[0]!.prompt!, /You are Opus \(@opus\), in an Agoryx room — one shared conversation between Ivan \(human, @ivan\) and Sonnet \(@sonnet\), Codex \(@codex\)\./);
    // Two agents of one kind: each its own model, its own native session, resumed as itself.
    const opus = callsOf(room, "opus");
    const sonnet = callsOf(room, "sonnet");
    assert.deepEqual(opus[0]!.args!.slice(opus[0]!.args!.indexOf("--model"), opus[0]!.args!.indexOf("--model") + 2), ["--model", "opus"]);
    assert.deepEqual(sonnet[0]!.args!.slice(sonnet[0]!.args!.indexOf("--model"), sonnet[0]!.args!.indexOf("--model") + 2), ["--model", "sonnet"]);
    assert.ok(!callsOf(room, "codex")[0]!.args!.includes("-m"));
    assert.notEqual(sessions.opus!.sessionId, sessions.sonnet!.sessionId);
    assert.equal(opus[1]!.sessionId, sessions.opus!.sessionId);
    assert.equal(opus[1]!.resumed, true);
    assert.equal(sonnet[1]!.sessionId, sessions.sonnet!.sessionId);
    // Opus's next turn has both other answers; the agents answer each other.
    assert.match(opus[1]!.prompt!, /Sonnet · \d\d:\d\d\nSonnet: SQLite\./);
    assert.match(opus[1]!.prompt!, /Codex · \d\d:\d\d\nCodex: JSONL\./);
    assert.ok(messages.some((message) => message.author === "codex" && message.text === "Codex answers Sonnet."));

    // "Open in Claude Code" resumes each on the model it runs on.
    const commands = resumeCommands(room.store, { claude: createClaudeRunner("claude"), codex: createCodexRunner("codex") });
    assert.match(commands.opus!, new RegExp(`--resume ${sessions.opus!.sessionId} --model opus$`));
    assert.match(commands.sonnet!, / --model sonnet$/);
    assert.doesNotMatch(commands.codex!, / -m /);

    // The room list names the author, whichever agent spoke last (a third agent is not "you").
    const summary = room.store.summary();
    assert.ok(summary.lastMessage);
    const lastAgent = room.store.state.agents.find((agent) => agent.id === summary.lastMessage!.author);
    assert.equal(summary.lastMessage.label, lastAgent?.label);
    assert.equal(roomPreview({ author: "sonnet", text: "Use **SQLite**.", label: "Sonnet" }), "Sonnet: Use SQLite.");
    assert.equal(roomPreview({ author: "Ivan", text: "Hello" }), "You: Hello");

    // The web feed groups the three blind answers and names all three.
    const group = buildFeed(room.store.state, []).rows.find((row) => row.type === "group");
    assert.ok(group && group.type === "group");
    assert.equal(group.items.length, 3);
    assert.match(group.text, /^(Opus|Sonnet|Codex), (Opus|Sonnet|Codex) and (Opus|Sonnet|Codex) started at the same time from your message$/);
  } finally {
    await room.cleanup();
  }
});

test("names reads right for one, two and three agents", () => {
  assert.equal(names(["Claude"]), "Claude");
  assert.equal(names(["Claude", "Codex"]), "Claude and Codex");
  assert.equal(names(["Opus", "Sonnet", "Codex"]), "Opus, Sonnet and Codex");
});

test("@sonnet wakes only Sonnet, not the other Claude; the others read its answer in their next turn", async () => {
  const room = createTestRoom({
    agents: parseAgents(TRIO),
    rules: [{ id: "sonnet", match: "@Sonnet", reply: "Sonnet looked: fine.", once: true }],
  });
  try {
    room.engine.postHuman("@Sonnet take a look");
    await withTimeout(room.engine.waitIdle());
    assert.deepEqual(room.store.state.turns.map((turn) => turn.agent), ["sonnet"], "its answer went to the human alone");
    room.engine.postHuman("Thoughts, everyone?");
    await withTimeout(room.engine.waitIdle());
    assert.match(callsOf(room, "opus")[0]!.prompt!, /Sonnet looked: fine\./);
    assert.match(callsOf(room, "codex")[0]!.prompt!, /Sonnet looked: fine\./);
  } finally {
    await room.cleanup();
  }
});

test("an edit no one can be credited with during a three-way blind round is theirs, all three", async () => {
  const room = createTestRoom({
    agents: parseAgents(TRIO),
    settings: { doc: "README.md" },
    rules: [
      { id: "opus", match: "essay", sleepMs: 1200, reply: "Thinking.", once: true },
      { id: "sonnet", match: "essay", sleepMs: 1000, reply: "Thinking too.", once: true },
      { id: "codex", match: "essay", sleepMs: 200, write: { path: "README.md", content: "# Time\n\nA draft.\n", via: "shell" }, reply: "Drafted.", once: true },
    ],
  });
  try {
    room.engine.postHuman("Write an essay on time");
    await withTimeout(room.engine.waitIdle());
    const revision = room.store.state.docRevisions.at(-1)!;
    assert.deepEqual(revision.among?.sort(), ["codex", "opus", "sonnet"]);
    assert.equal(revision.by.split(" or ").length, 3);
    assert.equal(room.store.state.docRevisions.some((entry) => entry.by === room.store.state.human), false);
  } finally {
    await room.cleanup();
  }
});

// --- two of a kind, outside a room turn ------------------------------------------------------

/** Run the agent tool the way an agent's own session would: in the workspace, with no room-turn env. */
const agentTool = (room: TestRoom, args: string[], env: Record<string, string> = {}) =>
  new Promise<{ code: number; out: string; err: string }>((resolve) => {
    const base = Object.fromEntries(
      Object.entries(room.env).filter(([key]) => !/^(AGORYX_|CLAUDECODE$|CODEX_SANDBOX)/.test(key)),
    ) as Record<string, string>;
    const child = spawn(process.execPath, [agentCliScript(), "table", ...args], { cwd: room.store.state.workspace, env: { ...base, ...env } });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("exit", (code) => resolve({ code: code ?? 1, out, err }));
  });

const jsonl = (lines: unknown[]) => lines.map((line) => `${JSON.stringify(line)}\n`).join("");
let n = 0;
const ts = () => new Date(Date.UTC(2026, 8, 29, 10, 0, n++)).toISOString();
const cUser = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: "user",
  isSidechain: false,
  uuid: `u${n}`,
  promptId: `p${n}`,
  timestamp: ts(),
  message: { role: "user", content },
  ...extra,
});
const cAssistant = (content: unknown[], stop: string) => ({ type: "assistant", isSidechain: false, uuid: `a${n}`, timestamp: ts(), message: { role: "assistant", stop_reason: stop, content } });
const toolUse = { type: "tool_use", id: "t", name: "Bash", input: { command: "ls" } };

test("two Claudes, one called claude: Claude Code's hint is not taken for that one; the room asks or finds who is working", async () => {
  const room = createTestRoom({
    agents: parseAgents([{ kind: "claude" }, { id: "opus", kind: "claude", model: "opus" }, { kind: "codex" }]),
  });
  try {
    room.engine.postHuman("Hello all");
    await withTimeout(room.engine.waitIdle());
    assert.match(callsOf(room, "opus")[0]!.prompt!, /table … --as opus/);

    // Claude Code's shell only says "a Claude": with two, nobody working, the room refuses to guess —
    // and names the two it could be, not Codex.
    const hinted = await agentTool(room, ["ask", "Which store?"], { CLAUDECODE: "1" });
    assert.equal(hinted.code, 1, hinted.out);
    assert.match(hinted.err, /add --as claude or --as opus$/m);
    assert.equal(room.store.state.table.questions.length, 0, "not credited to the agent whose id happens to be the kind");

    // While Ivan is mid-exchange with Opus in its own session, the hint is Opus.
    const opusFile = locateNativeSession("claude", room.store.state.sessions.opus!.sessionId, room.store.state.workspace, room.env)!;
    appendFileSync(opusFile, jsonl([cUser("Open a question about storage", { origin: { kind: "human" } }), cAssistant([toolUse], "tool_use")]));
    await waitUntil(() => room.engine.presence().opus === "native");
    assert.equal(room.engine.presence().claude, "idle", "one session is not the other");
    const asked = await agentTool(room, ["ask", "Which store?"], { CLAUDECODE: "1" });
    assert.equal(asked.code, 0, asked.err);
    assert.equal(room.store.state.table.questions[0]!.by, "opus");

    // That exchange, when it ends, is imported as Opus's, not as the other Claude's.
    appendFileSync(opusFile, jsonl([cUser([{ type: "tool_result", tool_use_id: "t", content: "ok" }]), cAssistant([{ type: "text", text: "Opened Q1." }], "end_turn")]));
    await waitUntil(() => room.store.state.messages.some((message) => message.native && message.text === "Opened Q1."));
    const reply = room.store.state.messages.find((message) => message.text === "Opened Q1.")!;
    assert.equal(reply.author, "opus");
    assert.equal(reply.native!.agent, "opus");

    // An explicit id is that agent; a bare kind from an older shim is read as the hint it was.
    const signed = await agentTool(room, ["ask", "Which index?", "--as", "claude"]);
    assert.equal(signed.code, 0, signed.err);
    assert.equal(room.store.state.table.questions.at(-1)!.by, "claude");
    const codex = await agentTool(room, ["ask", "Which lock?"], { CODEX_SANDBOX: "seatbelt" });
    assert.equal(codex.code, 0, codex.err);
    assert.equal(room.store.state.table.questions.at(-1)!.by, "codex", "one Codex: its hint is enough");
  } finally {
    await room.cleanup();
  }
});

test("a bare kind signs for the one agent of that kind, whatever its id", async () => {
  const room = createTestRoom({ agents: parseAgents([{ id: "opus", kind: "claude" }, { kind: "codex" }]) });
  try {
    room.engine.postHuman("Hello");
    await withTimeout(room.engine.waitIdle());
    for (const env of [{ CLAUDECODE: "1" }, {}]) {
      const args = env.CLAUDECODE ? ["ask", "Hinted?"] : ["ask", "Legacy?", "--as", "claude"];
      const result = await agentTool(room, args, env);
      assert.equal(result.code, 0, result.err);
      assert.equal(room.store.state.table.questions.at(-1)!.by, "opus");
    }
  } finally {
    await room.cleanup();
  }
});

// --- through the daemon ----------------------------------------------------------------------

const call = (port: number, token: string, method: string, path: string, body?: unknown) =>
  new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          host: `127.0.0.1:${port}`,
          "x-agoryx-token": token,
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : {} }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });

test("the daemon shows the default roster and creates a room with its own", async () => {
  const home = scratch();
  const { fakeClaude, fakeCodex } = writeFakeBins(home);
  const env: NodeJS.ProcessEnv = { ...process.env, AGORYX_HOME: join(home, "agora"), AGORYX_USER: "Ivan" };
  const daemon = new AgoraDaemon({ env, port: 0, advertise: false, runners: { claude: createClaudeRunner(fakeClaude), codex: createCodexRunner(fakeCodex) } });
  const { port } = await daemon.start();
  const api = (method: string, path: string, body?: unknown) => call(port, daemon.token, method, path, body);
  try {
    assert.deepEqual((await api("GET", "/api/info")).json.agents, DEFAULT_AGENTS);
    mkdirSync(join(home, "agora"), { recursive: true });
    writeFileSync(rosterPath(env), JSON.stringify(TRIO));
    assert.deepEqual(((await api("GET", "/api/info")).json.agents as Array<{ id: string }>).map((agent) => agent.id), ["opus", "sonnet", "codex"]);

    const dir = join(home, "work");
    mkdirSync(dir);
    const made = await api("POST", "/api/rooms", { name: "Pair", dir, agents: [{ id: "haiku", kind: "claude", model: "haiku" }, { kind: "codex" }] });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    const id = (made.json.room as { id: string }).id;
    const snapshot = await api("GET", `/api/rooms/${id}`);
    assert.deepEqual((snapshot.json.state as { agents: Array<{ id: string; model?: string }> }).agents.map((agent) => [agent.id, agent.model]), [
      ["haiku", "haiku"],
      ["codex", undefined],
    ]);
    const fromFile = await api("POST", "/api/rooms", { name: "Trio", dir });
    assert.equal(fromFile.status, 201);
    const trioId = (fromFile.json.room as { id: string }).id;
    assert.deepEqual(RoomStore.open(join(home, "agora", "rooms"), trioId).state.agents.map((agent) => agent.id), ["opus", "sonnet", "codex"]);

    const bad = await api("POST", "/api/rooms", { name: "Twins", dir, agents: [{ kind: "claude" }, { kind: "claude" }] });
    assert.equal(bad.status, 400);
    assert.match(String(bad.json.error), /two agents are called "claude"/);
    writeFileSync(rosterPath(env), "[");
    assert.match(String((await api("GET", "/api/info")).json.rosterError), /not valid JSON/);
  } finally {
    await daemon.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("the settings screen edits the profile and the roster; an agent can read them but never change them", async () => {
  const home = scratch();
  const { fakeClaude, fakeCodex } = writeFakeBins(home);
  const env: NodeJS.ProcessEnv = { ...process.env, AGORYX_HOME: join(home, "agora"), AGORYX_USER: "Ivan" };
  const daemon = new AgoraDaemon({ env, port: 0, advertise: false, runners: { claude: createClaudeRunner(fakeClaude), codex: createCodexRunner(fakeCodex) } });
  const { port } = await daemon.start();
  const api = (method: string, path: string, body?: unknown) => call(port, daemon.token, method, path, body);
  try {
    assert.equal(typeof (await api("GET", "/api/info")).json.version, "string");

    // The profile: empty until written, CRLF becomes LF, an empty text removes the file.
    const none = await api("GET", "/api/profile");
    assert.equal(none.json.text, "");
    const profileFile = String(none.json.path);
    const put = await api("PUT", "/api/profile", { text: "I am Ivan.\r\nShort answers, please." });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    assert.equal(put.json.text, "I am Ivan.\nShort answers, please.");
    assert.equal(readFileSync(profileFile, "utf8"), "I am Ivan.\nShort answers, please.\n");
    assert.equal((await api("GET", "/api/profile")).json.text, "I am Ivan.\nShort answers, please.");

    // The roster: the default until saved, validated like the file, removed to go back to the default.
    const plain = await api("GET", "/api/roster");
    assert.equal(plain.json.custom, false);
    assert.deepEqual(plain.json.agents, DEFAULT_AGENTS);
    const saved = await api("PUT", "/api/roster", { agents: TRIO });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.equal(saved.json.custom, true);
    assert.deepEqual(parseAgents(JSON.parse(readFileSync(rosterPath(env), "utf8"))), parseAgents(TRIO));
    assert.deepEqual(((await api("GET", "/api/info")).json.agents as Array<{ id: string }>).map((agent) => agent.id), ["opus", "sonnet", "codex"]);
    const twins = await api("PUT", "/api/roster", { agents: [{ kind: "claude" }, { kind: "claude" }] });
    assert.equal(twins.status, 400);
    assert.match(String(twins.json.error), /two agents are called "claude"/);
    assert.deepEqual(parseAgents(JSON.parse(readFileSync(rosterPath(env), "utf8"))).map((agent) => agent.id), ["opus", "sonnet", "codex"], "a refused roster leaves the file");

    // An agent reads both (its CLI may look) but changes neither.
    const dir = join(home, "work");
    mkdirSync(dir);
    const made = await api("POST", "/api/rooms", { name: "Keys", dir });
    const roomId = (made.json.room as { id: string }).id;
    const key = agentKey(daemon.token, roomId, "opus");
    assert.equal((await call(port, key, "GET", "/api/profile")).status, 200);
    const refusedProfile = await call(port, key, "PUT", "/api/profile", { text: "I obey the agents." });
    assert.equal(refusedProfile.status, 403);
    assert.match(String(refusedProfile.json.error), /only the human changes their profile/);
    assert.equal((await call(port, key, "DELETE", "/api/roster")).status, 403);
    assert.equal((await call(port, key, "PUT", "/api/roster", { agents: [{ kind: "codex" }] })).status, 403);
    assert.equal(readFileSync(profileFile, "utf8"), "I am Ivan.\nShort answers, please.\n");

    const reset = await api("DELETE", "/api/roster");
    assert.equal(reset.json.custom, false);
    assert.deepEqual(reset.json.agents, DEFAULT_AGENTS);
    assert.ok(!existsSync(rosterPath(env)));
    await api("PUT", "/api/profile", { text: "  " });
    assert.ok(!existsSync(profileFile));
  } finally {
    await daemon.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a roster entry's effort reaches its CLI: --effort for Claude, model_reasoning_effort for Codex", () => {
  const [opus, astra] = parseAgents([
    { id: "opus", kind: "claude", model: "claude-opus-5-5", effort: " xhigh " },
    { id: "astra", kind: "codex", model: "gpt-6-astra", effort: "xhigh" },
  ]);
  assert.equal(opus!.effort, "xhigh");
  const base = { prompt: "hi", cwd: "/tmp/ws", sessionId: null, roomName: "R", settings: DEFAULT_SETTINGS, env: {}, signal: new AbortController().signal };
  const claudeArgs = buildClaudeArgs({ ...base, model: opus!.model!, effort: opus!.effort! }, "00000000-0000-4000-8000-000000000000", true);
  assert.deepEqual(claudeArgs.slice(claudeArgs.indexOf("--effort"), claudeArgs.indexOf("--effort") + 2), ["--effort", "xhigh"]);
  const codexArgs = buildCodexArgs({ ...base, model: astra!.model!, effort: astra!.effort! });
  assert.ok(codexArgs.join(" ").includes('-c model_reasoning_effort="xhigh"'));
  // Resumed turns keep it too.
  assert.ok(buildCodexArgs({ ...base, sessionId: "s1", effort: "xhigh" }).join(" ").includes('model_reasoning_effort="xhigh"'));
  // No effort: nothing is passed, the CLI's own default applies.
  assert.ok(!buildCodexArgs(base).join(" ").includes("model_reasoning_effort"));
});
