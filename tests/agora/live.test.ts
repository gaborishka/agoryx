import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { locateNativeSession } from "../../internal/agora/native.js";
import { createClaudeRunner } from "../../internal/agora/runners/claude.js";
import { buildCodexThreadParams, createCodexRunner, execShapedItem, describeCodexItem } from "../../internal/agora/runners/codex.js";
import { runJsonlProcess } from "../../internal/agora/runners/process.js";
import type { TurnRequest } from "../../internal/agora/runners/types.js";
import { applyTurnContext, clearTurnContext, turnContextPath, writeTurnContext } from "../../internal/agora/turn-context.js";
import { DEFAULT_SETTINGS, type RoomAgent } from "../../internal/agora/types.js";
import { createTestRoom, withTimeout, type FakeLogEntry, type TestRoom } from "./helpers.js";

// One CLI process kept up across an agent's turns, and the turn that ends when the CLI says its answer is ready.
// The fake CLIs (fixtures/fake-agent.mjs) speak both: process-per-turn, and the live protocols of the real ones.

const run = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const shim = join(repo, "bin", "agoryx-agent.mjs");

const CLAUDE_ONLY: RoomAgent[] = [{ id: "claude", kind: "claude", label: "Claude" }];
const CODEX_ONLY: RoomAgent[] = [{ id: "codex", kind: "codex", label: "Codex" }];

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitUntil = async (check: () => boolean, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
};
const say = async (room: TestRoom, text: string) => {
  room.engine.postHuman(text);
  await withTimeout(room.engine.waitIdle());
};
const logLines = (room: TestRoom): Array<Record<string, any>> =>
  readFileSync(room.env.FAKE_LOG!, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

// --- 1. The turn ends when the CLI says its answer is ready -----------------------------------------------------

for (const [kind, agents] of [["claude", CLAUDE_ONLY], ["codex", CODEX_ONLY]] as const) {
  test(`${kind}: the turn ends when the answer is ready, not when the process has shut down; nothing is left running`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "agora-tail-"));
    const room = createTestRoom({
      agents: [...agents],
      // The process lingers 6 s after its answer (hooks, MCP servers, state) and would write a file during that time.
      rules: [{ reply: "the answer", tailMs: 6000, background: true, pidFile: join(dir, "pid"), lateWrite: { path: "late.txt", content: "too late", afterMs: 2500 } }],
    });
    try {
      const started = Date.now();
      await say(room, "go");
      const turn = room.store.state.turns[0]!;
      assert.equal(turn.status, "ok");
      assert.ok(Date.now() - started < 4500, `the turn took ${Date.now() - started} ms; it waited for the process to exit`);
      assert.equal(room.store.state.messages.find((message) => message.id === turn.messageId)?.text, "the answer");

      // The process (and the tool it left in the background) is gone once the turn is: no orphans.
      const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
      const background = logLines(room).find((line) => line.backgroundPid)!.backgroundPid as number;
      await waitUntil(() => !alive(pid) && !alive(background), 4000);
      // What it would have written after its answer never lands, so it can be credited to nobody.
      assert.equal(existsSync(join(room.store.state.workspace, "late.txt")), false);
      assert.deepEqual(turn.files ?? [], []);
    } finally {
      await room.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("a file written before the answer is the turn's even though the process is stopped right after it", async () => {
  const room = createTestRoom({
    agents: CODEX_ONLY,
    rules: [{ reply: "wrote it", write: { path: "a.txt", content: "hello" }, tailMs: 5000 }],
  });
  try {
    await say(room, "write a.txt");
    const turn = room.store.state.turns[0]!;
    assert.deepEqual(turn.files, ["a.txt"]);
    assert.equal(readFileSync(join(room.store.state.workspace, "a.txt"), "utf8"), "hello");
  } finally {
    await room.cleanup();
  }
});

test("runJsonlProcess: a ready event ends the wait, the group is taken down, and the exit code says nothing", async () => {
  const script = `console.log(JSON.stringify({type:"go"}));setTimeout(()=>{},60000)`;
  const started = Date.now();
  const outcome = await runJsonlProcess({
    bin: process.execPath,
    args: ["-e", script],
    cwd: tmpdir(),
    env: process.env,
    onJson: () => {},
    readyWhen: (value) => value.type === "go",
  });
  assert.equal(outcome.ready, true);
  assert.equal(outcome.aborted, false);
  assert.equal(outcome.timedOut, false);
  assert.ok(Date.now() - started < 3000);
});

// --- 2. and 3. A CLI process kept up between an agent's turns ---------------------------------------------------

const turnsOf = (room: TestRoom, agent: string) => room.store.state.turns.filter((turn) => turn.agent === agent);
const turnFileOf = (room: TestRoom, agent: string) => turnContextPath(room.store.dir, agent);

for (const [kind, agents] of [["claude", CLAUDE_ONLY], ["codex", CODEX_ONLY]] as const) {
  test(`${kind}: one live process serves the agent's turns; each turn is seen as itself, and its cost is its own`, async () => {
    const room = createTestRoom({
      agents: [...agents],
      live: true,
      agentKey: (id) => `key-of-${id}`,
      rules: [{ reply: "LIVE-ONE", match: "FIRST-Q" }, { reply: "LIVE-TWO", match: "SECOND-Q" }, { reply: "LIVE-THREE", match: "THIRD-Q" }],
    });
    try {
      await say(room, "FIRST-Q");
      await say(room, "SECOND-Q");
      await say(room, "THIRD-Q");
      const calls = room.invocations(kind);
      assert.equal(calls.length, 3);
      assert.ok(calls.every((call) => call.live), "every turn ran in a live process");
      assert.equal(new Set(calls.map((call) => call.pid)).size, 1, "one process for all three turns");
      assert.ok(alive(calls[0]!.pid!), "and it is still up between turns");
      // The session is the same one throughout; from the second turn on it is resumed, not started.
      assert.equal(new Set(calls.map((call) => call.sessionId)).size, 1);
      assert.equal(room.store.state.sessions[kind]?.sessionId, calls[0]!.sessionId);

      const turns = turnsOf(room, kind);
      assert.deepEqual(turns.map((turn) => turn.status), ["ok", "ok", "ok"]);
      assert.deepEqual(
        room.store.state.messages.filter((message) => message.kind === "agent").map((message) => message.text),
        ["LIVE-ONE", "LIVE-TWO", "LIVE-THREE"],
      );
      // What the tools of turn N see is turn N's: not the first turn's (the environment the process started with).
      assert.deepEqual(calls.map((call) => call.env?.AGORYX_TURN), turns.map((turn) => turn.id));
      assert.equal(new Set(calls.map((call) => call.env?.AGORYX_SEEN)).size, 3, "the delta the turn covered moves on");
      // Nothing about a turn is in the process's own environment, and no key either; only where to look.
      for (const call of calls) {
        assert.equal(call.procEnv?.AGORYX_TURN, undefined);
        assert.equal(call.procEnv?.AGORYX_SEEN, undefined);
        assert.equal(call.procEnv?.AGORYX_AGENT_KEY, undefined);
        assert.equal(call.procEnv?.AGORYX_TURN_FILE, turnFileOf(room, kind));
        assert.equal(call.env?.AGORYX_AGENT_KEY, `key-of-${kind}`, "but the current turn's tools sign with the agent's key");
      }
      // Between turns nothing is left to leak.
      assert.equal(existsSync(turnFileOf(room, kind)), false);
      // Claude's cost is cumulative in a live process; a turn is charged its own.
      if (kind === "claude") for (const turn of turns) assert.ok(Math.abs((turn.usage?.costUsd ?? 0) - 0.001) < 1e-9, `turn cost ${turn.usage?.costUsd}`);
    } finally {
      await room.cleanup();
    }
  });
}

test("without live, every turn is its own process, as before", async () => {
  const room = createTestRoom({ agents: CLAUDE_ONLY, rules: [] });
  try {
    await say(room, "one");
    await say(room, "two");
    const calls = room.invocations("claude");
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => !call.live));
    assert.notEqual(calls[0]!.pid, calls[1]!.pid);
  } finally {
    await room.cleanup();
  }
});

test("read new in a live process's later turn shows what was said since that turn began, not since the first", async () => {
  const room = createTestRoom({
    live: true,
    rules: [
      { agent: "codex", match: "BETA-Q", reply: "CODEX-SAYS-BETA" },
      { agent: "codex", match: "ALPHA-Q", reply: "CODEX-SAYS-ALPHA" },
      { agent: "claude", match: "BETA-Q", once: true, waitForText: "CODEX-SAYS-BETA", table: [["read", "new"]], reply: "claude beta" },
      { agent: "claude", match: "ALPHA-Q", once: true, waitForText: "CODEX-SAYS-ALPHA", table: [["read", "new"]], reply: "claude alpha" },
    ],
  });
  try {
    await say(room, "ALPHA-Q");
    await say(room, "BETA-Q");
    const outputs = logLines(room).filter((entry) => entry.tableOutputs);
    assert.equal(outputs.length, 2, "one read new per claude turn that asked");
    const [first, second] = outputs.map((entry) => entry.tableOutputs.join("\n"));
    assert.match(first, /CODEX-SAYS-ALPHA/);
    assert.match(second, /CODEX-SAYS-BETA/, "turn 2 sees turn 2's news");
    assert.doesNotMatch(second, /CODEX-SAYS-ALPHA/, "and not the first turn's");
    assert.ok(room.invocations("claude").every((call) => call.live));
    assert.equal(new Set(room.invocations("claude").map((call) => call.pid)).size, 1, "all in one process");
  } finally {
    await room.cleanup();
  }
});

test("a tool run between turns has no turn and no key: it is refused, never sent as the agent's last turn or the human's", async () => {
  const room = createTestRoom({ agents: CLAUDE_ONLY, live: true, agentKey: () => "key-of-claude", rules: [] });
  try {
    await say(room, "one");
    const call = room.invocations("claude")[0]!;
    assert.ok(alive(call.pid!));
    // What the live process's shell would run now: its own environment, and no turn in progress.
    const processEnv = { ...process.env, AGORYX_AGENT: "claude", AGORYX_ROOM: room.store.state.id, AGORYX_TURN_FILE: turnFileOf(room, "claude"), AGORYX_TURN: "t-stale", AGORYX_SEEN: "m1", AGORYX_AGENT_KEY: "stale-key" };
    const result = await run(process.execPath, [shim, "read", "new"], { env: processEnv }).then(
      (ok) => ({ ok: true, out: ok.stdout + ok.stderr }),
      (error) => ({ ok: false, out: `${error.stdout}${error.stderr}` }),
    );
    assert.ok(!/t-stale/.test(result.out));
    assert.equal(result.ok, false, `expected a refusal, got: ${result.out}`);
  } finally {
    await room.cleanup();
  }
});

test("applyTurnContext and the agents' shim apply the turn file by the same rules", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agora-ctx-"));
  try {
    const file = turnContextPath(dir, "claude");
    const base = { AGORYX_AGENT: "claude", AGORYX_ROOM: "r1", AGORYX_TURN_FILE: file } as NodeJS.ProcessEnv;
    const stale = { AGORYX_TURN: "t1", AGORYX_SEEN: "m1", AGORYX_AGENT_KEY: "old" };

    // No file: the turn is over; the stale variables go.
    let env: NodeJS.ProcessEnv = { ...base, ...stale };
    applyTurnContext(env);
    assert.equal(env.AGORYX_TURN, undefined);
    assert.equal(env.AGORYX_SEEN, undefined);
    assert.equal(env.AGORYX_AGENT_KEY, undefined);

    // The current turn's file: its turn, its delta, its key.
    writeTurnContext(file, { room: "r1", agent: "claude", turn: "t7", seen: "m40", key: "k7" });
    env = { ...base, ...stale };
    applyTurnContext(env);
    assert.deepEqual([env.AGORYX_TURN, env.AGORYX_SEEN, env.AGORYX_AGENT_KEY], ["t7", "m40", "k7"]);
    assert.equal(statSyncMode(file), 0o600);

    // No key this turn: an old one does not stay.
    writeTurnContext(file, { room: "r1", agent: "claude", turn: "t8", seen: "m41" });
    env = { ...base, ...stale };
    applyTurnContext(env);
    assert.deepEqual([env.AGORYX_TURN, env.AGORYX_AGENT_KEY], ["t8", undefined]);

    // Another agent's or another room's file is not this agent's turn.
    writeTurnContext(file, { room: "r1", agent: "codex", turn: "t9", seen: "m1", key: "codex-key" });
    env = { ...base, ...stale };
    applyTurnContext(env);
    assert.deepEqual([env.AGORYX_TURN, env.AGORYX_AGENT_KEY], [undefined, undefined]);
    writeTurnContext(file, { room: "other", agent: "claude", turn: "t9", seen: "m1", key: "other-key" });
    env = { ...base, ...stale };
    applyTurnContext(env);
    assert.deepEqual([env.AGORYX_TURN, env.AGORYX_AGENT_KEY], [undefined, undefined]);

    // Garbage is no turn.
    writeFileSync(file, "{nope");
    env = { ...base, ...stale };
    applyTurnContext(env);
    assert.equal(env.AGORYX_TURN, undefined);

    // Without AGORYX_TURN_FILE (a process started for one turn) nothing is touched.
    env = { AGORYX_AGENT: "claude", ...stale };
    applyTurnContext(env);
    assert.equal(env.AGORYX_TURN, "t1");

    clearTurnContext(file);
    assert.equal(existsSync(file), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const statSyncMode = (path: string): number => Number(require_statSync(path).mode & 0o777);
import { statSync as require_statSync } from "node:fs";

// --- 5. Lifecycle -----------------------------------------------------------------------------------------------

test("a change to the room's settings restarts the live process; the next turn runs under them", async () => {
  const room = createTestRoom({ agents: CLAUDE_ONLY, live: true, rules: [] });
  try {
    await say(room, "one");
    await say(room, "two");
    room.engine.updateSettings({ network: true });
    await say(room, "three");
    const [a, b, c] = room.invocations("claude");
    assert.equal(a!.pid, b!.pid);
    assert.notEqual(b!.pid, c!.pid, "a settings change is a new process");
    assert.ok(c!.args!.includes("--input-format"));
    assert.equal(alive(a!.pid!), false, "the old one is gone");
  } finally {
    await room.cleanup();
  }
});

test("a change of model, effort, access or network is a different live process; the same ones are not", async () => {
  const request = (patch: Partial<TurnRequest> = {}, settings: Partial<typeof DEFAULT_SETTINGS> = {}): TurnRequest => ({
    prompt: "x",
    cwd: "/tmp/w",
    sessionId: "s1",
    roomName: "r",
    settings: { ...DEFAULT_SETTINGS, network: false, ...settings },
    env: { A: "1" },
    signal: new AbortController().signal,
    ...patch,
  });
  for (const runner of [createClaudeRunner("claude"), createCodexRunner("codex")]) {
    const base = runner.liveFingerprint!(request());
    assert.equal(runner.liveFingerprint!(request({ prompt: "other", sessionId: "s2" })), base, "prompt and session do not restart it");
    assert.notEqual(runner.liveFingerprint!(request({ model: "some-model" })), base);
    assert.notEqual(runner.liveFingerprint!(request({ effort: "xhigh" })), base);
    assert.notEqual(runner.liveFingerprint!(request({}, { network: true })), base);
    assert.notEqual(runner.liveFingerprint!(request({}, { access: "readonly" })), base);
    assert.notEqual(runner.liveFingerprint!(request({ cwd: "/tmp/other" })), base);
    assert.notEqual(runner.liveFingerprint!(request({ env: { A: "2" } })), base);
  }
});

test("the human writing into the agent's own session restarts the live process", async () => {
  const room = createTestRoom({ agents: CLAUDE_ONLY, live: true, rules: [] });
  try {
    await say(room, "one");
    const before = room.invocations("claude")[0]!;
    const file = locateNativeSession("claude", room.store.state.sessions.claude!.sessionId, room.store.state.workspace, room.env)!;
    assert.ok(file);
    const stamp = new Date().toISOString();
    appendFileSync(
      file,
      [
        { type: "user", isSidechain: false, uuid: "h1", promptId: "h1", timestamp: stamp, message: { role: "user", content: "a side question in my own terminal" }, origin: { kind: "human" } },
        { type: "assistant", isSidechain: false, uuid: "h2", timestamp: stamp, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "a side answer" }] } },
      ].map((line) => `${JSON.stringify(line)}\n`).join(""),
    );
    await waitUntil(() => room.store.state.messages.some((message) => message.native));
    await waitUntil(() => !alive(before.pid!));
    await say(room, "two");
    const after = room.invocations("claude").at(-1)!;
    assert.notEqual(after.pid, before.pid);
    assert.equal(after.live, true);
  } finally {
    await room.cleanup();
  }
});

test("an idle live process is closed after the idle time; the next turn starts a new one", async () => {
  const room = createTestRoom({ agents: CLAUDE_ONLY, live: { idleMs: 300 }, rules: [] });
  try {
    await say(room, "one");
    const first = room.invocations("claude")[0]!;
    assert.ok(alive(first.pid!));
    await waitUntil(() => !alive(first.pid!), 5000);
    await say(room, "two");
    const second = room.invocations("claude")[1]!;
    assert.notEqual(second.pid, first.pid);
    assert.equal(second.resumed, true, "the session carries on in the new process");
  } finally {
    await room.cleanup();
  }
});

test("closing the room takes its live processes down", async () => {
  const room = createTestRoom({ live: true, rules: [] });
  try {
    await say(room, "one");
    const pids = [...new Set(room.invocations().map((call) => call.pid!))];
    assert.equal(pids.length, 2, "one live process per agent");
    assert.ok(pids.every(alive));
    await room.engine.close();
    await waitUntil(() => pids.every((pid) => !alive(pid)), 5000);
    assert.equal(existsSync(turnFileOf(room, "claude")), false);
  } finally {
    await room.cleanup();
  }
});

for (const [kind, agents] of [["claude", CLAUDE_ONLY], ["codex", CODEX_ONLY]] as const) {
  test(`${kind}: Stop interrupts a live turn at once and leaves neither the turn nor the process hanging`, async () => {
    const room = createTestRoom({ agents: [...agents], live: true, rules: [{ match: "SLOW-Q", sleepMs: 60_000, reply: "never" }] });
    try {
      await say(room, "warm up");
      const warm = room.invocations(kind)[0]!;
      room.engine.postHuman("SLOW-Q");
      await waitUntil(() => room.invocations(kind).length === 2);
      const started = Date.now();
      await withTimeout(room.engine.stop());
      await withTimeout(room.engine.waitIdle());
      assert.ok(Date.now() - started < 5000, "stopped promptly");
      assert.equal(turnsOf(room, kind).at(-1)!.status, "interrupted");
      await waitUntil(() => !alive(warm.pid!), 5000);
      assert.equal(existsSync(turnFileOf(room, kind)), false);
      // The room carries on: the next turn gets a fresh process.
      await say(room, "after the stop");
      const last = room.invocations(kind).at(-1)!;
      assert.notEqual(last.pid, warm.pid);
      assert.notEqual(turnsOf(room, kind).at(-1)!.status, "error");
    } finally {
      await room.cleanup();
    }
  });
}

test("a CLI without a live mode falls back to a process per turn, silently", async () => {
  const room = createTestRoom({ live: true, env: { FAKE_NO_LIVE: "1" }, rules: [] });
  try {
    await say(room, "one");
    await say(room, "two");
    for (const kind of ["claude", "codex"]) {
      const calls = room.invocations(kind);
      assert.ok(calls.length >= 2, `${kind}: the turns ran`);
      assert.ok(calls.every((call) => !call.live));
      assert.equal(new Set(calls.map((call) => call.pid)).size, calls.length, `${kind}: a process per turn`);
      assert.ok(turnsOf(room, kind).every((turn) => turn.status !== "error"));
    }
    const visible = room.store.state.messages.filter((message) => message.kind === "system");
    assert.deepEqual(visible.filter((message) => /live|input-format|app-server/i.test(message.text)), [], "the room says nothing about it");
  } finally {
    await room.cleanup();
  }
});

test("a lost session is rejoined in a live process too", async () => {
  const room = createTestRoom({ agents: CLAUDE_ONLY, live: true, rules: [] });
  try {
    room.store.append({ type: "session.bound", briefingVersion: 2, agent: "claude", sessionId: "00000000-0000-4000-8000-000000000000" });
    await say(room, "hello again");
    const calls = room.invocations("claude");
    assert.ok(turnsOf(room, "claude").every((turn) => turn.status !== "error"));
    assert.match(calls.at(-1)!.prompt!, /could not be resumed/);
    assert.notEqual(room.store.state.sessions.claude?.sessionId, "00000000-0000-4000-8000-000000000000");
    await say(room, "and again");
    assert.equal(room.invocations("claude").at(-1)!.pid, calls.at(-1)!.pid, "the rejoined session lives on in one process");
  } finally {
    await room.cleanup();
  }
});

test("a live process that dies between turns is replaced without a failed turn", async () => {
  const room = createTestRoom({ agents: CODEX_ONLY, live: true, rules: [] });
  try {
    await say(room, "one");
    const first = room.invocations("codex")[0]!;
    process.kill(first.pid!, "SIGKILL");
    await waitUntil(() => !alive(first.pid!));
    await say(room, "two");
    assert.ok(turnsOf(room, "codex").every((turn) => turn.status !== "error" && turn.status !== "interrupted"));
    assert.equal(turnsOf(room, "codex").length, 2);
    assert.notEqual(room.invocations("codex")[1]!.pid, first.pid);
  } finally {
    await room.cleanup();
  }
});

// Building blocks the live codex process relies on.
test("codex thread parameters carry the sandbox, network and effort the exec flags do", () => {
  const request = (patch: Partial<TurnRequest> = {}, settings: Partial<typeof DEFAULT_SETTINGS> = {}): TurnRequest => ({
    prompt: "x",
    cwd: "/w",
    sessionId: null,
    roomName: "r",
    settings: { ...DEFAULT_SETTINGS, network: false, access: "workspace", ...settings },
    env: {},
    signal: new AbortController().signal,
    ...patch,
  });
  const plain = buildCodexThreadParams(request()) as any;
  assert.equal(plain.sandbox, "workspace-write");
  assert.equal(plain.approvalPolicy, "never");
  assert.equal(plain.cwd, "/w");
  assert.equal(plain.config?.sandbox_workspace_write, undefined);
  const net = buildCodexThreadParams(request({ effort: "high", model: "m1" }, { network: true })) as any;
  assert.equal(net.config.sandbox_workspace_write.network_access, true);
  assert.equal(net.config.model_reasoning_effort, "high");
  assert.equal(net.model, "m1");
  // Unrestricted (network on, workspace access): leaving the sandbox goes to Codex's own review, as in exec.
  assert.equal(net.approvalPolicy, "on-request");
  assert.equal(net.approvalsReviewer, "auto_review");
  assert.equal((buildCodexThreadParams(request({}, { access: "readonly" })) as any).sandbox, "read-only");
});
