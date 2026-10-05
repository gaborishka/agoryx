import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentKey } from "../../internal/agora/actor.js";
import { AgoraDaemon } from "../../internal/agora/daemon.js";
import { RoomEngine, type EngineOptions } from "../../internal/agora/engine.js";
import { buildDelta } from "../../internal/agora/prompts.js";
import { setProjectFields } from "../../internal/agora/projects.js";
import { RoomStore } from "../../internal/agora/store.js";
import { normalizeTableAssistInput, prepareTableAssistRequest, tableAssistInstruction, tableAssistRequests } from "../../internal/agora/table-assist.js";
import { prepareTableOp } from "../../internal/agora/table.js";
import { DEFAULT_SETTINGS, type RoomAgent, type TableAssistRequest } from "../../internal/agora/types.js";
import type { AgentRunner, TurnRequest } from "../../internal/agora/runners/types.js";
import { wakesAgent } from "../../internal/agora/wakes.js";
import { messagePath } from "../../internal/agora/workspace.js";
import { withTimeout } from "./helpers.js";

const agents: RoomAgent[] = ["one", "two", "three"].map(id => ({ id, kind: "codex", label: id }));
const fixture = (runner?: AgentRunner, roster = agents, readers: Pick<EngineOptions, "secondLook" | "readMessage"> = {}) => {
  const home = mkdtempSync(join(tmpdir(), "agoryx-assist-"));
  const env = { ...process.env, AGORYX_HOME: home, CODEX_HOME: join(home, "codex"), CLAUDE_CONFIG_DIR: join(home, "claude") };
  const rooms = join(home, "rooms");
  const store = RoomStore.create(rooms, { name: "Agent requests", workspace: join(home, "ws"), createdWorkspace: true, mode: "chat", human: "Ivan", agents: roster, settings: { ...DEFAULT_SETTINGS, network: false } });
  const engine = new RoomEngine({ store, runners: runner ? { codex: runner } : {}, env, nativePollMs: 0, githubPollMs: 0, ...readers });
  const op = (input: unknown, by = "one", turnId?: string) => {
    const prepared = prepareTableOp(store.state.table, input, by, by === "Ivan");
    store.append({ type: "table.op", op: { ...prepared, ...(turnId ? { turnId } : {}) } });
    return prepared;
  };
  const seed = () => op({ op: "fact", text: "The goal is a simpler export flow." });
  const request = (kind: TableAssistRequest["kind"], target?: string, nonce = "request-123") => {
    const tableAssist: TableAssistRequest = { kind, agent: "one", nonce, contextSeq: store.state.seq, ...(target ? { target } : {}) };
    const id = `m${store.state.messages.length + 1}`;
    store.append({ type: "message.posted", message: { id, author: "Ivan", kind: "human", text: "Prepare from context", tableAssist, mentions: ["one"], wakes: true } });
    return store.state.messages.at(-1)!;
  };
  const start = (id = "t1", cursor = store.state.seq) => {
    if (!store.state.runs.length) store.append({ type: "run.started", runId: "r1", trigger: store.state.messages.at(-1)?.id ?? null, budget: null });
    store.append({ type: "turn.started", turnId: id, agent: "one", runId: "r1", cursor, resume: false, sessionId: null, promptChars: 0 });
  };
  const end = (status: "ok" | "pass" | "error" | "interrupted", id = "t1") => store.append({ type: "turn.ended", turnId: id, agent: "one", status, sessionId: null, ...(status === "error" ? { error: { kind: "unknown" as const, message: "Preparation failed" } } : {}) });
  const ops = () => store.events.flatMap(event => event.type === "table.op" ? [{ seq: event.seq, op: event.op }] : []);
  return { home, env, rooms, store, engine, op, seed, request, start, end, ops, async cleanup() { await engine.close(); rmSync(home, { recursive: true, force: true }); } };
};

test("requests route to exactly one of N agents, ignoring guidance mentions and Jev fanout", async () => {
  let room!: ReturnType<typeof fixture>;
  const calls: TurnRequest[] = [];
  let consults = 0;
  const runner: AgentRunner = { kind: "codex", async run(request) {
    calls.push(request);
    const question = room.engine.tableOp({ op: "ask", text: "Which export interaction best meets the goal?" }, "two");
    room.engine.tableOp({ op: "component", title: "Question to review", kind: "artifact", refs: [question.id], body: "two: this question follows the existing export goal." }, "two");
    return { status: "ok", text: "Prepared for review. @all", sessionId: null };
  }, resumeCommand() { return ""; } };
  // Exercise the existing optional readers, not just the default runtime without them.
  room = fixture(runner, agents, {
    secondLook: async () => { consults++; return { worth: { one: 1, three: 1 }, ms: 0, tokens: 0 }; },
    readMessage: async () => { consults++; return { addressed: { one: 1, three: 1 }, stances: [], ms: 0, tokens: 0 }; },
  });
  try {
    room.seed();
    const message = room.engine.tableAssist({ kind: "question", agent: "two", nonce: "route-123", guidance: "Compare simplicity. @all @three", contextSeq: 999, requestHash: "spoof" });
    assert.deepEqual(message.mentions, ["two"]);
    assert.equal(message.tableAssist!.contextSeq, message.seq - 1);
    assert.notEqual(message.tableAssist!.requestHash, "spoof");
    const event = room.store.events.find(event => event.type === "message.posted" && event.message.id === message.id)!;
    assert.deepEqual(agents.map(agent => wakesAgent(room.store.state, event, agent)), [false, true, false]);
    await withTimeout(room.engine.waitIdle());
    assert.equal(calls.length, 1);
    assert.equal(consults, 0, "preparation must not trigger duplicate second-look work");
    assert.match(calls[0]!.prompt, /You \(two\) are its sole executor/);
    assert.equal(room.store.state.messages.find(message => message.kind === "agent")!.wakes, false);
    assert.equal(tableAssistRequests(room.store.state, room.ops())[0]!.status, "ready");
    assert.deepEqual(tableAssistRequests(room.store.state, room.ops())[0]!.refs, ["Q1", "W1"]);
  } finally { await room.cleanup(); }
});

test("busy executor queues, active distinct requests conflict, and original nonce is idempotent", async () => {
  let entered!: () => void, release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const runner: AgentRunner = { kind: "codex", async run() { if (++calls === 1) { entered(); await gate; } return { status: "ok", text: "::pass::", sessionId: null }; }, resumeCommand() { return ""; } };
  const room = fixture(runner);
  try {
    room.seed();
    room.engine.postHuman("@one Review the existing goal.");
    await withTimeout(enteredPromise);
    const raw = { kind: "steps", agent: "one", nonce: "queued-123" };
    const message = room.engine.tableAssist(raw);
    assert.equal(tableAssistRequests(room.store.state, room.ops())[0]!.status, "queued");
    const seq = room.store.state.seq;
    assert.equal(room.engine.tableAssist(raw).id, message.id);
    assert.equal(room.store.state.seq, seq);
    assert.throws(() => room.engine.tableAssist({ ...raw, nonce: "another-123" }), /current agent request/);
    assert.throws(() => room.engine.tableAssist({ ...raw, guidance: "Different focus" }), /different action/);
    assert.throws(() => room.engine.tableAssist(raw, "Different human"), /different action/);
    release();
    await withTimeout(room.engine.waitIdle());
    assert.equal(calls, 2);
    assert.equal(tableAssistRequests(room.store.state, room.ops())[0]!.status, "no-output");
  } finally { release(); await room.cleanup(); }
});

test("validation precedes writes and accepts a real Work project goal as context", async () => {
  const runner: AgentRunner = { kind: "codex", async run() { return { status: "ok", text: "::pass::", sessionId: null }; }, resumeCommand() { return ""; } };
  const room = fixture(runner);
  try {
    const before = room.store.state.seq;
    assert.throws(() => room.engine.tableAssist({ kind: "question", nonce: "empty-123" }), /goal or room context/);
    assert.throws(() => normalizeTableAssistInput({ kind: "question", nonce: "bad", guidance: "x".repeat(2001) }), /identity/);
    assert.throws(() => normalizeTableAssistInput({ kind: ["question"], nonce: "bad-type-123" }), /Choose questions/);
    assert.equal(room.store.state.seq, before);
    room.seed();
    room.op({ op: "ask", text: "Which route?" }); room.op({ op: "ask", text: "Which format?" });
    const scopedBefore = room.store.state.seq;
    assert.throws(() => room.engine.tableAssist({ kind: "options", nonce: "ambiguous-123" }), /which open question/);
    assert.throws(() => room.engine.tableAssist({ kind: "steps", target: "P99", nonce: "missing-123" }), /no longer on the table/);
    assert.throws(() => room.engine.tableAssist({ kind: "steps", target: "Q1", nonce: "bad-scope-123" }), /active option/);
    assert.equal(room.store.state.seq, scopedBefore);
    room.op({ op: "settle", text: "Answered", q: "Q1" });
    assert.throws(() => room.engine.tableAssist({ kind: "options", target: "Q1", nonce: "closed-123" }), /open question/);
    assert.throws(() => prepareTableAssistRequest(room.store.state, normalizeTableAssistInput({ kind: "question", nonce: "noagent-123" }), []), /available agent/);
    const blank = fixture(runner);
    try {
      blank.store.state.mode = "work";
      setProjectFields(blank.store.state.workspace, { goal: "Make the export flow simple." }, { by: "Ivan" }, blank.env);
      const message = blank.engine.tableAssist({ kind: "question", nonce: "project-123" });
      assert.equal(message.tableAssist!.kind, "question");
      await withTimeout(blank.engine.waitIdle());
    } finally { await blank.cleanup(); }
  } finally { await room.cleanup(); }
});

test("nonce identity survives replay and deleted option scope without resolving it again", async () => {
  const runner: AgentRunner = { kind: "codex", async run() { return { status: "ok", text: "::pass::", sessionId: null }; }, resumeCommand() { return ""; } };
  const room = fixture(runner);
  let reopened: RoomEngine | undefined;
  try {
    room.seed(); room.op({ op: "ask", text: "Which route?" }); room.op({ op: "propose", q: "Q1", title: "Simple export" });
    const raw = { kind: "options", agent: "one", target: "P1", nonce: "replay-123" };
    const first = room.engine.tableAssist(raw);
    assert.equal(first.tableAssist!.target, "Q1");
    await withTimeout(room.engine.waitIdle());
    room.op({ op: "delete", target: "P1" });
    await room.engine.close();
    const copy = messagePath(room.engine.ws, room.store.id, first.id)!;
    writeFileSync(copy, "Ivan:\nExplore useful alternatives.\n");
    const store = RoomStore.open(room.rooms, room.store.id);
    reopened = new RoomEngine({ store, runners: {}, env: room.env, nativePollMs: 0, githubPollMs: 0 });
    assert.match(readFileSync(copy, "utf8"), /Deferred table preparation: executor one; target Q1/);
    assert.match(readFileSync(copy, "utf8"), /only when this request is assigned in its next Agoryx room turn/);
    const seq = store.state.seq;
    assert.equal(reopened.tableAssist(raw).id, first.id);
    assert.equal(store.state.seq, seq);
    assert.throws(() => reopened!.tableAssist({ ...raw, target: "Q1" }), /different action/);
  } finally { await reopened?.close(); await room.cleanup(); }
});

test("removed executor never broadcasts a queued request and pending stop is terminal", async () => {
  const room = fixture();
  try {
    room.seed(); const message = room.request("question");
    const event = room.store.events.at(-1)!;
    room.store.append({ type: "agent.removed", agent: "one", by: "Ivan" });
    assert.equal(tableAssistRequests(room.store.state)[0]!.status, "unavailable");
    assert.deepEqual(room.store.state.agents.map(agent => wakesAgent(room.store.state, event, agent)), [false, false]);
    room.store.append({ type: "agent.added", agent: agents[0]!, by: "Ivan" });
    assert.equal(tableAssistRequests(room.store.state)[0]!.status, "unavailable", "a rejoined handle is not the old executor");
    room.store.append({ type: "run.started", runId: "r1", trigger: message.id, budget: null });
    room.store.append({ type: "run.ended", runId: "r1", reason: "stopped", turns: 0 });
    assert.equal(wakesAgent(room.store.state, event, agents[0]!), false);
  } finally { await room.cleanup(); }
});

test("results require compatible real publications from the first consuming turn", async () => {
  const room = fixture();
  try {
    room.seed(); room.op({ op: "ask", text: "Which route?" });
    room.request("options", "Q1"); room.start();
    room.op({ op: "brief", now: "Request pending", refs: ["Q1"] }, "one", "t1");
    room.op({ op: "component", title: "Unrelated custom view", kind: "custom", refs: ["Q1"], body: "Not an options comparison" }, "one", "t1");
    assert.deepEqual(tableAssistRequests(room.store.state, room.ops())[0]!.refs, []);
    room.op({ op: "propose", title: "Simple export", q: "Q1" }, "one", "t1");
    assert.equal(tableAssistRequests(room.store.state, room.ops())[0]!.status, "running");
    room.end("error");
    const failed = tableAssistRequests(room.store.state, room.ops())[0]!;
    assert.equal(failed.status, "partial"); assert.deepEqual(failed.refs, ["P1"]);
    const cursor = room.store.state.seq;
    room.start("t2", cursor);
    room.op({ op: "propose", title: "Unrelated later option", q: "Q1" }, "one", "t2");
    const later = tableAssistRequests(room.store.state, room.ops())[0]!;
    assert.equal(later.turnId, "t1"); assert.equal(later.status, "partial"); assert.deepEqual(later.refs, ["P1"]);
    const delta = buildDelta({ state: room.store.state, events: room.store.events, agent: agents[0]!, turnsLeft: null });
    assert.doesNotMatch(delta, /sole executor/);
    assert.match(delta, /Do not duplicate or restart/);
    assert.equal(wakesAgent(room.store.state, room.store.events.find(event => event.type === "message.posted")!, agents[0]!), false);
    room.end("ok", "t2");
  } finally { await room.cleanup(); }
});

test("artifact-only findings/reused questions are reviewable results and scoped step plans stay scoped", async () => {
  const room = fixture();
  try {
    room.seed(); room.op({ op: "ask", text: "Which route?" });
    room.request("question"); room.start();
    room.op({ op: "component", title: "Existing question is sufficient", kind: "artifact", refs: ["Q1"], body: "Q1 remains the blocker; no duplicate question is needed." }, "one", "t1");
    room.end("ok");
    assert.equal(tableAssistRequests(room.store.state, room.ops())[0]!.status, "ready");
    room.request("conclusion", "Q1", "findings-123"); room.start("t2");
    room.op({ op: "component", title: "Supported findings", kind: "artifact", refs: ["Q1", "F1"], body: "one: F1 establishes the goal. Q1 remains unresolved; evidence is incomplete." }, "one", "t2");
    room.end("ok", "t2");
    assert.equal(tableAssistRequests(room.store.state, room.ops())[1]!.status, "ready");
    assert.equal(room.store.state.table.questions[0]!.status, "open");
    assert.equal(room.store.state.table.decisions.length, 0);
    room.op({ op: "propose", title: "Simple export", q: "Q1" });
    room.request("steps", "P1", "steps-123"); room.start("t3");
    room.op({ op: "next", text: "An unrelated unscoped step" }, "one", "t3");
    assert.deepEqual(tableAssistRequests(room.store.state, room.ops())[2]!.refs, []);
    room.op({ op: "next", text: "Investigate the simple export", target: "P1" }, "one", "t3");
    room.op({ op: "component", title: "Plan for P1", kind: "plan", refs: ["P1", "X2"], body: "X2 investigates P1; await human approval before executing." }, "one", "t3");
    room.end("ok", "t3");
    assert.deepEqual(tableAssistRequests(room.store.state, room.ops())[2]!.refs, ["X2", "W3"]);
    assert.equal(room.store.state.table.next[0]!.done, undefined);
    for (const kind of ["question", "options", "conclusion", "steps"] as const) assert.match(tableAssistInstruction({ kind, agent: "one", nonce: "instruction-123", contextSeq: 2 }), /preparation only/);
  } finally { await room.cleanup(); }
});

test("a grounded no-new-questions artifact needs no invented table record", async () => {
  const room = fixture();
  try {
    room.store.append({ type: "message.posted", message: { id: "m1", author: "Ivan", kind: "human", text: "Ship a simple CSV export using the agreed format.", mentions: [], wakes: false } });
    room.request("question"); room.start();
    room.op({ op: "component", title: "No new blocking questions", kind: "artifact", refs: [], body: "one: the human supplied a concrete goal and format. No additional blocking question is supported by this context." }, "one", "t1");
    room.end("ok");
    assert.equal(tableAssistRequests(room.store.state, room.ops())[0]!.status, "ready");
    assert.deepEqual(tableAssistRequests(room.store.state, room.ops())[0]!.refs, ["W1"]);
  } finally { await room.cleanup(); }
});

test("a successful publication receipt survives later choice, archive, replacement and deletion", async () => {
  const room = fixture();
  try {
    room.seed(); room.request("question"); room.start();
    room.op({ op: "ask", text: "Which route?" }, "one", "t1");
    room.op({ op: "propose", title: "Simple export", q: "Q1" }, "one", "t1");
    room.op({ op: "component", title: "Blocking question", kind: "artifact", refs: ["Q1"], body: "one: Q1 is the question to review." }, "one", "t1");
    room.end("ok");
    const receipt = () => tableAssistRequests(room.store.state, room.ops())[0]!;
    const original = receipt();
    assert.equal(original.status, "ready"); assert.deepEqual(original.refs, ["Q1", "W1"]);
    room.op({ op: "decide", target: "P1" }, "Ivan");
    room.op({ op: "archive", target: "W1" }, "Ivan");
    assert.equal(receipt().status, "ready"); assert.deepEqual(receipt().refs, original.refs);
    room.op({ op: "restore", target: "W1" }, "Ivan");
    room.op({ op: "component", target: "W1", title: "A later revision", kind: "custom", refs: [], body: "Human-maintained replacement" }, "Ivan");
    room.op({ op: "reopen", target: "Q1" }, "Ivan");
    room.op({ op: "delete", target: "Q1" }, "Ivan");
    assert.equal(receipt().status, "ready"); assert.deepEqual(receipt().refs, original.refs);
    assert.equal(receipt().updatedSeq, original.updatedSeq, "fulfillment time remains the actual publishing turn");
  } finally { await room.cleanup(); }
});

test("a blank question-only comparison shell does not fulfill an options request", async () => {
  const room = fixture();
  try {
    room.seed(); room.op({ op: "ask", text: "Which route?" }); room.request("options", "Q1"); room.start();
    room.op({ op: "component", title: "Empty comparison", kind: "comparison", refs: ["Q1"] }, "one", "t1");
    room.end("ok");
    assert.equal(tableAssistRequests(room.store.state, room.ops())[0]!.status, "no-output");
    assert.deepEqual(tableAssistRequests(room.store.state, room.ops())[0]!.refs, []);
    room.op({ op: "propose", q: "Q1", title: "A later option" });
    assert.equal(tableAssistRequests(room.store.state, room.ops())[0]!.status, "no-output", "later linked data must not retroactively fulfill a blank shell");
    assert.deepEqual(tableAssistRequests(room.store.state, room.ops())[0]!.refs, []);
  } finally { await room.cleanup(); }
});

test("native Q-only comparisons fulfill options using their real publication-time linked proposals", async () => {
  const room = fixture();
  try {
    room.seed(); room.op({ op: "ask", text: "Which route?" }); room.op({ op: "ask", text: "Which separate route?" });
    room.op({ op: "propose", q: "Q1", title: "A compact export" }); room.op({ op: "propose", q: "Q1", title: "An advanced export" });
    room.op({ op: "withdraw", target: "P2" });
    room.request("options", "Q1"); room.start();
    room.op({ op: "component", title: "Existing alternatives", kind: "comparison", refs: ["Q1"] }, "one", "t1");
    room.end("ok");
    const receipt = () => tableAssistRequests(room.store.state, room.ops())[0]!;
    const original = receipt();
    assert.equal(original.status, "ready"); assert.deepEqual(original.refs, ["W1"]);
    room.op({ op: "edit", target: "P1", q: "Q2" });
    room.op({ op: "delete", target: "P2" });
    room.op({ op: "archive", target: "W1" }, "Ivan");
    assert.equal(room.store.state.table.options.filter(option => option.q === "Q1").length, 0);
    assert.equal(receipt().status, "ready", "move/deletion/archive must preserve the actual fulfillment receipt");
    assert.deepEqual(receipt().refs, ["W1"]);
    assert.equal(receipt().updatedSeq, original.updatedSeq);
  } finally { await room.cleanup(); }
});

test("Q-only comparison shells exclude proposals moved or deleted before publication", async () => {
  const room = fixture();
  try {
    room.seed(); room.op({ op: "ask", text: "Which route?" }); room.op({ op: "ask", text: "Which separate route?" });
    room.op({ op: "propose", q: "Q1", title: "A moved option" }); room.op({ op: "propose", q: "Q1", title: "A deleted option" });
    room.op({ op: "edit", target: "P1", q: "Q2" }); room.op({ op: "delete", target: "P2" });
    room.request("options", "Q1"); room.start();
    room.op({ op: "component", title: "Now empty comparison", kind: "comparison", refs: ["Q1"] }, "one", "t1");
    room.end("ok");
    assert.equal(tableAssistRequests(room.store.state, room.ops())[0]!.status, "no-output");
    assert.deepEqual(tableAssistRequests(room.store.state, room.ops())[0]!.refs, []);
  } finally { await room.cleanup(); }
});

test("failed preparation is consumed once and an ordinary later turn cannot restart or fulfill it", async () => {
  let room!: ReturnType<typeof fixture>;
  let calls = 0;
  const prompts: string[] = [];
  const runner: AgentRunner = { kind: "codex", async run(request) {
    prompts.push(request.prompt);
    if (++calls === 1) return { status: "error", text: "", sessionId: null, error: { kind: "unknown", message: "Synthetic failure" } };
    room.engine.tableOp({ op: "ask", text: "An unrelated later review question" }, "one");
    return { status: "ok", text: "::pass::", sessionId: null };
  }, resumeCommand() { return ""; } };
  room = fixture(runner);
  try {
    room.seed(); room.engine.tableAssist({ kind: "question", agent: "one", nonce: "failed-once-123" });
    await withTimeout(room.engine.waitIdle());
    assert.equal(calls, 1, "automatic error retries must not repeat a consumed preparation intent");
    assert.equal(tableAssistRequests(room.store.state, room.ops())[0]!.status, "failed");
    room.engine.postHuman("@one Continue the ordinary review.");
    await withTimeout(room.engine.waitIdle());
    assert.equal(calls, 2);
    assert.doesNotMatch(prompts[1]!, /sole executor/);
    const receipt = tableAssistRequests(room.store.state, room.ops())[0]!;
    assert.equal(receipt.status, "failed"); assert.deepEqual(receipt.refs, []);
  } finally { await room.cleanup(); }
});

test("assist-only turns cannot choose, settle or complete work; human and ordinary turns retain their capabilities", async () => {
  let entered!: () => void, release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runner: AgentRunner = { kind: "codex", async run() { entered(); await gate; return { status: "ok", text: "::pass::", sessionId: null }; }, resumeCommand() { return ""; } };
  const room = fixture(runner);
  try {
    room.seed(); room.op({ op: "ask", text: "Which route?" }); room.op({ op: "propose", title: "Simple export", q: "Q1" }); room.op({ op: "next", text: "Investigate", target: "P1" });
    room.engine.tableAssist({ kind: "conclusion", agent: "one", nonce: "guard-123" });
    await withTimeout(enteredPromise);
    const before = room.store.state.seq;
    for (const op of [{ op: "decide", target: "P1" }, { op: "settle", text: "Automatically settled", q: "Q1" }, { op: "done", target: "X1" }, { op: "review", target: "X1" }, { op: "withdraw", target: "P1" }, { op: "delete", target: "F1" }, { op: "edit", target: "F1", text: "Changed" }]) assert.throws(() => room.engine.tableOp(op, "one"), /preparation only/);
    assert.equal(room.store.state.seq, before);
    room.engine.tableOp({ op: "component", title: "Supported findings", kind: "artifact", refs: ["F1"], body: "one: F1 describes the goal; Q1 remains open." }, "one");
    assert.equal(room.store.state.table.questions[0]!.status, "open");
    // Direct human decisions remain explicit authorized actions while the preparation runs.
    room.engine.tableOp({ op: "decide", target: "P1" }, "Ivan");
    assert.equal(room.store.state.table.decisions[0]!.by, "Ivan");
    release(); await withTimeout(room.engine.waitIdle());
    room.engine.tableOp({ op: "done", target: "X1" }, "one");
    assert.equal(room.store.state.table.next[0]!.done, true);
  } finally { release(); await room.cleanup(); }
});

test("delta isolates exact executor and cancels stopped/superseded intent", async () => {
  const room = fixture();
  try {
    room.seed(); const first = room.request("question");
    const delta = (agent: RoomAgent) => buildDelta({ state: room.store.state, events: room.store.events, agent, turnsLeft: null });
    assert.match(delta(agents[0]!), /sole executor/); assert.doesNotMatch(delta(agents[1]!), /sole executor/);
    room.store.append({ type: "run.started", runId: "r1", trigger: first.id, budget: null });
    room.store.append({ type: "run.ended", runId: "r1", reason: "stopped", turns: 0 });
    assert.equal(tableAssistRequests(room.store.state)[0]!.status, "interrupted");
    assert.doesNotMatch(delta(agents[0]!), /sole executor/);
    room.request("steps", undefined, "new-request-123");
    const latest = delta(agents[0]!);
    assert.match(latest, /Human table request new-request-123/);
    assert.doesNotMatch(latest, /Human table request request-123/);
  } finally { await room.cleanup(); }
});

test("HTTP table-assist is human-only, returns durable acknowledgment and rejects replay intent changes", async () => {
  const home = mkdtempSync(join(tmpdir(), "agoryx-assist-http-"));
  const env = { ...process.env, AGORYX_HOME: home, CODEX_HOME: join(home, "codex"), CLAUDE_CONFIG_DIR: join(home, "claude") };
  const runner: AgentRunner = { kind: "codex", async run() { return { status: "ok", text: "::pass::", sessionId: null }; }, resumeCommand() { return ""; } };
  const daemon = new AgoraDaemon({ env, port: 0, advertise: false, runners: { codex: runner } });
  try {
    const { port } = await daemon.start();
    const call = (path: string, body: unknown, token = daemon.token) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "x-agoryx-token": token, "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await call("/api/rooms", { name: "HTTP requests", mode: "chat", agents: [agents[0]] });
    const id = (await created.json()).room.id;
    const raw = { kind: "question", nonce: "http-request-123" };
    const empty = await call(`/api/rooms/${id}/table-assist`, raw); assert.equal(empty.status, 409);
    await call(`/api/rooms/${id}/messages`, { text: "@one Find a simpler export flow." });
    const unauthorized = await call(`/api/rooms/${id}/table-assist`, raw, agentKey(daemon.token, id, "one")); assert.equal(unauthorized.status, 403);
    const first = await call(`/api/rooms/${id}/table-assist`, raw); assert.equal(first.status, 201);
    const message = (await first.json()).message;
    assert.equal(message.tableAssist.agent, "one"); assert.equal(message.kind, "human");
    const retry = await call(`/api/rooms/${id}/table-assist`, raw); assert.equal((await retry.json()).message.id, message.id);
    const changed = await call(`/api/rooms/${id}/table-assist`, { ...raw, kind: "steps" }); assert.equal(changed.status, 409);
  } finally { await daemon.close(); rmSync(home, { recursive: true, force: true }); }
});
