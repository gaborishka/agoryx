import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEvent, initialState } from "../../internal/agora/projection.js";
import { prepareTableOp } from "../../internal/agora/table.js";
import { currentDecision, isWorkTableEvent, workRef, workTableView } from "../../internal/agora/work-table.js";
import { DEFAULT_SETTINGS, type RoomEvent, type RoomEventBody } from "../../internal/agora/types.js";

/** Exercise realistic event histories; the selector must keep authorship and lifecycle semantics intact. */
const fixture = () => {
  const created: RoomEvent = {
    type: "room.created", id: "test-room", name: "Product review", workspace: "/workspace", createdWorkspace: false,
    human: "Ivan", agents: [{ id: "codex", label: "Codex", kind: "codex" }, { id: "claude", label: "Claude", kind: "claude" }],
    settings: { ...DEFAULT_SETTINGS }, seq: 1, ts: "2026-10-04T10:00:00.000Z",
  };
  const room = initialState(created);
  const events: RoomEvent[] = [created];
  const append = (body: RoomEventBody): RoomEvent => {
    const seq = room.seq + 1;
    const event = { ...body, seq, ts: new Date(Date.UTC(2026, 9, 4, 10, 0, seq)).toISOString() } as RoomEvent;
    applyEvent(room, event);
    events.push(event);
    return event;
  };
  const table = (raw: unknown, by = "codex") => {
    const op = prepareTableOp(room.table, raw, by, by === room.human);
    if (op.op === "brief") op.asOfSeq = room.seq;
    return append({ type: "table.op", op });
  };
  const post = (author: string, text: string, mentions: string[] = []) => append({
    type: "message.posted", message: { id: `m${room.messages.length + 1}`, kind: author === "Ivan" ? "human" : "agent", author, text, mentions, wakes: true },
  });
  const start = (agent = "codex", runId = "r1") => append({ type: "turn.started", turnId: `t${room.turns.length + 1}`, agent, runId, cursor: room.seq, resume: false, sessionId: null, promptChars: 100 });
  return { room, events, append, table, post, start, view: () => workTableView(room, events) };
};

const choose = (f: ReturnType<typeof fixture>, by = "Ivan") => {
  f.table({ op: "ask", text: "Which navigation should we use?" });
  f.table({ op: "propose", title: "Single focus", q: "Q1" });
  f.table({ op: "propose", title: "Grid", q: "Q1" }, "claude");
  f.table({ op: "decide", target: "P1", note: "Clearer reading order" }, by);
};

test("an empty room stays neutral, and a quiet run with closed questions is never reported as completed work", () => {
  const f = fixture();
  const empty = f.view();
  assert.equal(empty.runtime.status, "idle");
  assert.equal(empty.headsUp.source, "derived");
  assert.equal(empty.headsUp.awaiting, undefined);
  assert.deepEqual(empty.events, []);
  assert.equal(empty.headsUp.stale, false);
  choose(f);
  f.append({ type: "run.started", runId: "r1", trigger: null, budget: null });
  f.append({ type: "run.ended", runId: "r1", reason: "quiet", turns: 0 });
  const quiet = f.view();
  assert.equal(quiet.runtime.status, "quiet");
  assert.equal(quiet.counts.openQuestions, 0);
  assert.doesNotMatch(quiet.headsUp.now, /готово|завершено|completed|done/i);
  assert.equal(quiet.headsUp.awaiting, undefined);
});

test("runtime stays live beside an authored brief, and agents show compact current activity", () => {
  const f = fixture();
  f.post("Ivan", "Build this flow, @codex first", ["codex"]);
  f.append({ type: "run.started", runId: "r1", trigger: "m1", budget: null });
  f.start();
  f.table({ op: "brief", now: "The design is approved; implementation is in progress", changes: ["Navigation is simpler"], next: "Validate on mobile" });
  f.append({ type: "turn.activity", turnId: "t1", agent: "codex", activity: { id: "a1", kind: "edit", label: "Updating   navigation\nlayout" } });
  const view = f.view();
  assert.equal(view.runtime.status, "working");
  assert.equal(view.runtime.working, 1);
  assert.equal(view.headsUp.now, "The design is approved; implementation is in progress");
  assert.equal(view.headsUp.stale, false, "tool traces are not material context changes");
  assert.deepEqual(view.team.find((agent) => agent.id === "codex"), { id: "codex", label: "Codex", state: "working", turnId: "t1", activity: "Updating navigation layout" });
  assert.equal(view.team.find((agent) => agent.id === "claude")?.state, "idle", "a targeted human message does not queue other agents");
});

test("chosen options preserve the chooser's authorship, and reopened/deleted choices move to history", () => {
  const f = fixture();
  choose(f, "claude");
  let view = f.view();
  assert.equal(view.decisions.length, 1);
  assert.equal(view.decisions[0]!.title, "Single focus");
  assert.equal(view.decisions[0]!.by, "claude");
  assert.equal(view.decisions[0]!.authorLabel, "Claude");
  assert.equal(view.decisions[0]!.human, false);
  f.table({ op: "reopen", target: "Q1" }, "Ivan");
  view = f.view();
  assert.equal(view.decisions.length, 0);
  assert.equal(view.historicalDecisions[0]!.id, "D1");
  assert.equal(workRef(f.room, "D1").status, "historical");
  f.table({ op: "decide", target: "P1" }, "Ivan");
  view = f.view();
  assert.equal(view.decisions[0]!.id, "D2");
  assert.equal(view.decisions[0]!.human, true);
  assert.equal(currentDecision(f.room.table, f.room.table.decisions[0]!), false);
  f.table({ op: "reopen", target: "P1" }, "Ivan");
  f.table({ op: "delete", target: "P1" }, "Ivan");
  assert.equal(f.view().decisions.length, 0);
  assert.equal(workRef(f.room, "P1").kind, "missing");
  assert.equal(workRef(f.room, "D2").status, "historical");
});

test("many-answer questions retain each current choice while other options are open", () => {
  const f = fixture();
  f.table({ op: "ask", text: "Which sections should be included?", many: true });
  for (const title of ["Summary", "Decisions", "Sources"]) f.table({ op: "propose", title, q: "Q1" });
  f.table({ op: "decide", target: "P1" }, "Ivan");
  assert.equal(f.room.table.questions[0]!.status, "open");
  assert.equal(f.view().decisions[0]!.option, "P1");
  f.table({ op: "decide", target: "P2" }, "Ivan");
  assert.equal(f.view().decisions.length, 2);
  f.table({ op: "decide", target: "P3" }, "Ivan");
  assert.equal(f.room.table.questions[0]!.status, "decided");
  f.table({ op: "reopen", target: "Q1" }, "Ivan");
  assert.equal(f.view().decisions.length, 0);
});

test("only explicit awaited questions ask for human participation; resolution clears the request", () => {
  const f = fixture();
  f.table({ op: "ask", text: "Internal architecture discussion" });
  f.table({ op: "propose", title: "Preferred design", q: "Q1" });
  f.post("claude", "@ivan note our progress", ["ivan"]);
  assert.equal(f.view().headsUp.awaiting, undefined, "open questions and mentions do not imply a blocked human choice");
  f.table({ op: "brief", now: "Ready for your design choice", awaiting: { q: "Q1", recommendation: "P1" }, refs: ["Q1", "P1"] });
  let view = f.view();
  assert.deepEqual(view.headsUp.awaiting?.options.map((option) => option.id), ["P1"]);
  assert.equal(view.headsUp.awaiting?.recommendation, "P1");
  assert.equal(view.headsUp.awaiting?.stale, false);
  f.table({ op: "decide", target: "P1" }, "Ivan");
  view = f.view();
  assert.equal(view.headsUp.awaiting, undefined);
  assert.equal(view.headsUp.stale, true);
  f.table({ op: "reopen", target: "Q1" }, "Ivan");
  assert.equal(f.view().headsUp.awaiting?.stale, true, "a reopened request needs updated context");
  f.table({ op: "delete", target: "Q1" }, "Ivan");
  view = f.view();
  assert.equal(view.headsUp.awaiting, undefined);
  assert.ok(view.warnings.some((warning) => warning.code === "awaiting_missing"));
  assert.ok(view.headsUp.refs.some((ref) => ref.id === "Q1" && ref.kind === "missing"));
});

test("a withdrawn recommendation is visibly invalidated rather than offered for choosing", () => {
  const f = fixture();
  f.table({ op: "ask", text: "Choose route" });
  f.table({ op: "propose", title: "A", q: "Q1" });
  f.table({ op: "propose", title: "B", q: "Q1" });
  f.table({ op: "brief", now: "Compare routes", awaiting: { q: "Q1", recommendation: "P1" } });
  f.table({ op: "withdraw", target: "P1" });
  const view = f.view();
  assert.equal(view.headsUp.awaiting?.recommendation, undefined);
  assert.deepEqual(view.headsUp.awaiting?.options.map((option) => option.id), ["P2"]);
  assert.equal(view.headsUp.awaiting?.stale, true);
  assert.ok(view.warnings.some((warning) => warning.code === "recommendation_unavailable" && warning.ref === "P1"));
});

test("brief freshness follows material events, excluding agent chatter, activity, sessions and its own publication", () => {
  const f = fixture();
  f.table({ op: "next", text: "Implement layout" });
  f.append({ type: "run.started", runId: "r1", trigger: null, budget: null });
  f.start();
  f.table({ op: "brief", now: "Implementing layout", refs: ["X1"] });
  f.post("codex", "I am reading the files now");
  f.append({ type: "turn.activity", turnId: "t1", agent: "codex", activity: { id: "a1", kind: "read", label: "Reading implementation" } });
  f.append({ type: "session.bound", agent: "codex", sessionId: "native-session" });
  f.append({ type: "message.read", messageId: "m1", by: "jev", addressed: { codex: 0 }, stances: [] });
  assert.equal(f.view().headsUp.stale, false);
  assert.equal(isWorkTableEvent({ type: "turn.stream", turnId: "t1", agent: "codex", text: "token" }), false);
  f.table({ op: "edit", target: "X1", text: "Implement a changed layout" });
  assert.equal(f.view().headsUp.stale, true, "editing existing items still invalidates the context cursor");
  f.table({ op: "brief", now: "New layout underway", refs: ["X1"] });
  assert.equal(f.view().headsUp.stale, false);
  f.append({ type: "doc.revised", path: "layout.html", by: "claude", hash: "new-hash", added: 10, removed: 2 });
  assert.equal(f.view().headsUp.stale, true);
});

test("recent events are bounded meaningful changes with exact original event sources", () => {
  const f = fixture();
  f.table({ op: "ask", text: "Select a design" });
  f.table({ op: "propose", title: "Simple design", body: "<svg></svg>", q: "Q1" });
  f.table({ op: "decide", target: "P1" }, "Ivan");
  f.table({ op: "next", text: "Build it", target: "P1" });
  const review = f.table({ op: "review", target: "X1" });
  const objection = f.table({ op: "object", target: "X1", text: "Mobile spacing still fails" }, "claude");
  const done = f.table({ op: "done", target: "X1" }, "claude");
  for (let i = 0; i < 50; i += 1) f.post("codex", `Routine commentary ${i}`);
  const view = f.view();
  assert.deepEqual(view.events.map((event) => event.seq), [done.seq, objection.seq, review.seq]);
  assert.deepEqual(view.events.map((event) => event.kind), ["done", "objection", "review"]);
  assert.equal(view.events[0]!.ts, done.ts);
  assert.equal(view.events[0]!.ref, "X1");
  assert.equal(view.events[0]!.by, "claude");
  assert.equal(view.events[1]!.text, "Mobile spacing still fails");
  assert.equal(view.runtime.status, "idle", "a completed step cannot complete a room");
});

test("error and budget warnings remain separate from completion and respect a new successful turn", () => {
  const f = fixture();
  f.append({ type: "run.started", runId: "r1", trigger: null, budget: 1 });
  f.start();
  f.append({ type: "turn.ended", turnId: "t1", agent: "codex", status: "error", sessionId: null, durationMs: 10, error: { kind: "auth", message: "Please sign in again" } });
  f.append({ type: "run.ended", runId: "r1", reason: "budget", turns: 1 });
  let view = f.view();
  assert.equal(view.runtime.status, "budget");
  assert.ok(view.warnings.some((warning) => warning.code === "agent_error" && warning.text === "Please sign in again"));
  assert.ok(view.warnings.some((warning) => warning.code === "budget"));
  f.append({ type: "run.started", runId: "r2", trigger: null, budget: null });
  f.start("codex", "r2");
  f.append({ type: "turn.ended", turnId: "t2", agent: "codex", status: "ok", sessionId: null, durationMs: 10 });
  view = f.view();
  assert.equal(view.runtime.status, "active");
  assert.ok(!view.warnings.some((warning) => warning.code === "agent_error"));
});

test("authored components replace native surfaces and keep missing references visible after deletion", () => {
  const f = fixture();
  f.table({ op: "next", text: "Build mobile view" });
  f.table({ op: "propose", title: "Preview", body: "<main>Preview</main>" });
  assert.ok(f.view().components.some((component) => component.kind === "plan" && component.source === "derived"));
  f.table({ op: "component", kind: "plan", title: "Delivery plan", refs: ["X1"] });
  let view = f.view();
  assert.equal(view.components.filter((component) => component.kind === "plan").length, 1);
  assert.equal(view.components.find((component) => component.id === "W1")!.source, "authored");
  f.table({ op: "component", kind: "custom", title: "Prototype", refs: ["P1"], body: "<main>Preview</main>" });
  f.table({ op: "delete", target: "X1" }, "Ivan");
  view = f.view();
  const plan = view.components.find((component) => component.id === "W1")!;
  assert.equal(plan.stale, true);
  assert.deepEqual(plan.refs, [{ id: "X1", kind: "missing" }]);
  f.table({ op: "archive", target: "W1" });
  assert.ok(!f.view().components.some((component) => component.id === "W1"));
  assert.equal(workRef(f.room, "W1").status, "archived");
});

test("legacy snapshots without event logs still provide runtime, sources, current decisions and task context", () => {
  const f = fixture();
  choose(f);
  f.table({ op: "next", text: "Verify the mobile flow", target: "P1" });
  f.table({ op: "review", target: "X1" });
  f.post("Ivan", "Review this flow");
  f.append({ type: "run.started", runId: "r1", trigger: "m1", budget: null });
  f.start();
  const view = workTableView(f.room);
  assert.equal(view.runtime.status, "working");
  assert.equal(view.team.find((agent) => agent.id === "claude")?.state, "queued");
  assert.equal(view.decisions[0]!.id, "D1");
  assert.equal(view.tasks[0]!.id, "X1");
  assert.equal(view.headsUp.next, "Verify the mobile flow");
  assert.equal(workRef(f.room, "#m1").kind, "message");
  assert.equal(workRef(f.room, "T1").status, "running");
  assert.equal(view.headsUp.awaiting, undefined);
});

test("large tables stay bounded and the selector is deterministic without mutating source state", () => {
  const f = fixture();
  for (let i = 0; i < 40; i += 1) f.table({ op: "next", text: `Step ${i}` });
  for (let i = 0; i < 20; i += 1) f.table({ op: "fact", text: `Observed result ${i}` });
  const before = JSON.stringify(f.room);
  const first = f.view();
  const second = f.view();
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(f.room), before);
  assert.equal(first.tasks.length, 6);
  assert.equal(first.events.length, 3);
  assert.equal(first.counts.activeTasks, 40);
  assert.ok(first.components.every((component) => component.refs.length <= 24));
  assert.equal(first.tasks[0]!.text, "Step 39");
});

test("a brief knows its writer's own pre-publication progress, but exposes concurrent unseen decisions", () => {
  const f = fixture();
  f.append({ type: "run.started", runId: "r1", trigger: null, budget: null });
  f.start();
  const cursor = f.room.turns[0]!.cursor;
  f.table({ op: "next", text: "Build the focused layout" });
  const publish = () => {
    const op = prepareTableOp(f.room.table, { op: "brief", now: "Building the layout", refs: ["X1"] }, "codex", false);
    op.asOfSeq = cursor;
    f.append({ type: "table.op", op });
  };
  publish();
  assert.equal(f.view().headsUp.stale, false, "the writer knows the step it just authored");
  assert.equal(workTableView(f.room).headsUp.stale, false, "legacy fallback respects known authorship too");
  f.table({ op: "ask", text: "Which mobile navigation?" }, "claude");
  f.table({ op: "propose", title: "Bottom bar", q: "Q1" }, "claude");
  f.table({ op: "decide", target: "P1" }, "Ivan");
  publish();
  assert.equal(f.view().headsUp.stale, true, "a choice made by another participant after the prompt cursor is unseen");
  const refresh = prepareTableOp(f.room.table, { op: "brief", now: "Building the chosen navigation", refs: ["X1", "D1"] }, "codex", false);
  refresh.asOfSeq = f.room.seq;
  f.append({ type: "table.op", op: refresh });
  assert.equal(f.view().headsUp.stale, false);
  f.table({ op: "review", target: "X1" });
  assert.equal(f.view().headsUp.stale, true, "even the same author can change the situation after publication");
});

test("the recommended route stays in the compact choice set even after many earlier proposals", () => {
  const f = fixture();
  f.table({ op: "ask", text: "Which design?" });
  for (let i = 0; i < 7; i += 1) f.table({ op: "propose", title: `Design ${i}`, q: "Q1" });
  f.table({ op: "brief", now: "Compare the designs", awaiting: { q: "Q1", recommendation: "P7" } });
  assert.equal(f.view().headsUp.awaiting?.options[0]!.id, "P7");
});

test("long decision histories do not repeatedly revisit every candidate for every decision", () => {
  const f = fixture();
  const size = 10_000;
  let candidateReads = 0;
  // Count externally observable source reads rather than relying on a machine-specific time limit.
  f.room.table.questions.push({ id: "Q1", text: "Independent design choices", many: true, status: "open", by: "Ivan", seq: 1 });
  for (let i = 1; i <= size; i += 1) {
    const id = `P${i}`;
    const option = { id, title: `Choice ${i}`, q: "Q1", status: "chosen" as const, by: "codex", seq: i * 2 };
    Object.defineProperty(option, "id", { enumerable: true, get: () => { candidateReads += 1; return id; } });
    f.room.table.options.push(option);
    f.room.table.decisions.push({ id: `D${i}`, n: i, option: id, q: "Q1", by: "Ivan", seq: i * 2 + 1 });
  }
  f.room.seq = size * 2 + 1;
  const ops = f.room.table.decisions.map((decision) => ({
    seq: decision.seq, ts: "2026-10-04T10:00:00.000Z",
    op: { op: "decide" as const, id: decision.id, target: decision.option, by: decision.by },
  }));
  const view = workTableView(f.room, [], ops);
  assert.equal(view.counts.currentDecisions, size);
  assert.equal(view.decisions.length, 8);
  assert.equal(view.decisions[0]!.id, "D10000");
  assert.ok(candidateReads < size * 100, `candidate reads grew beyond a bounded multiple of history: ${candidateReads}`);
});

test("an authored component identifies source changes after its published version", () => {
  const f = fixture();
  f.table({ op: "propose", title: "Prototype", body: "Version one" });
  f.table({ op: "component", kind: "custom", title: "Release comparison", refs: ["P1"], body: "Snapshot of version one" });
  assert.equal(f.view().components.find((component) => component.id === "W1")!.stale, false);
  f.table({ op: "edit", target: "P1", body: "Version two" });
  const changed = f.view().components.find((component) => component.id === "W1")!;
  assert.equal(changed.stale, true);
  assert.equal(changed.body, "Snapshot of version one", "source updates never rewrite the author's artifact");
  f.table({ op: "component", target: "W1", kind: "custom", title: "Release comparison", refs: ["P1"], body: "Snapshot of version two" });
  assert.equal(f.view().components.find((component) => component.id === "W1")!.stale, false);
});

test("ordinary run lifecycle stays in runtime without drowning results or aging an accurate brief", () => {
  const f = fixture();
  choose(f);
  f.table({ op: "propose", title: "Working preview", body: "# Ready to inspect" });
  f.table({ op: "brief", now: "The chosen layout is ready to inspect", refs: ["P3", "D1"] });
  const important = f.view().events.map((event) => event.seq);
  for (let i = 1; i <= 4; i += 1) {
    f.append({ type: "run.started", runId: `r${i}`, trigger: null, budget: null });
    f.start("codex", `r${i}`);
    f.append({ type: "turn.ended", turnId: `t${i}`, agent: "codex", status: "pass", sessionId: null, durationMs: 1 });
    f.append({ type: "run.ended", runId: `r${i}`, reason: "quiet", turns: 1 });
  }
  const view = f.view();
  assert.equal(view.runtime.status, "quiet");
  assert.equal(view.headsUp.stale, false);
  assert.deepEqual(view.events.map((event) => event.seq), important);
  assert.ok(view.events.some((event) => event.kind === "decision"));
  assert.equal(workTableView(f.room).headsUp.stale, false, "legacy projected lifecycle is equally quiet");
  assert.equal(isWorkTableEvent({ type: "run.started", runId: "r5", trigger: null, budget: null, seq: 999, ts: "" }), false);
  assert.equal(isWorkTableEvent({ type: "run.ended", runId: "r5", reason: "quiet", turns: 1, seq: 1000, ts: "" }), false);
});

test("stops, exhausted budgets and errors still produce important events and stale context", () => {
  for (const reason of ["stopped", "budget"] as const) {
    const f = fixture();
    f.append({ type: "run.started", runId: "r1", trigger: null, budget: reason === "budget" ? 1 : null });
    f.table({ op: "brief", now: "Implementation is progressing" });
    f.append({ type: "run.ended", runId: "r1", reason, turns: 1, ...(reason === "stopped" ? { by: "Ivan" } : {}) });
    assert.equal(f.view().runtime.status, reason);
    assert.equal(f.view().headsUp.stale, true);
    assert.equal(f.view().events[0]!.status, reason);
    assert.equal(workTableView(f.room).events[0]!.status, reason);
  }
  const f = fixture();
  f.append({ type: "run.started", runId: "r1", trigger: null, budget: null });
  f.start();
  f.table({ op: "brief", now: "Implementation is progressing" });
  f.append({ type: "turn.ended", turnId: "t1", agent: "codex", status: "error", sessionId: null, durationMs: 1, error: { kind: "auth", message: "Authentication expired" } });
  assert.equal(f.view().headsUp.stale, true);
  assert.equal(f.view().events[0]!.kind, "error");
});

test("a native comparison covers previews associated through its question", () => {
  const f = fixture();
  f.table({ op: "ask", text: "Which layout?" });
  f.table({ op: "propose", title: "Single focus", q: "Q1", body: "Preview A" });
  f.table({ op: "propose", title: "Grid", q: "Q1", body: "Preview B" });
  assert.ok(f.view().components.some((component) => component.source === "derived" && component.kind === "artifact"));
  f.table({ op: "component", kind: "comparison", title: "Compare layouts", refs: ["Q1"] });
  assert.deepEqual(f.view().components.map((component) => component.id), ["W1"]);
  f.table({ op: "ask", text: "Which independent result?" });
  f.table({ op: "propose", title: "Independent prototype", body: "Separate result", q: "Q2" });
  assert.equal(f.view().components.find((component) => component.source === "derived")!.refs[0]!.id, "P3");
});

test("native checks replace duplicate task plans while additional tasks remain visible", () => {
  const f = fixture();
  f.table({ op: "next", text: "Review the focused layout" });
  f.table({ op: "review", target: "X1" });
  f.table({ op: "component", kind: "checks", title: "Layout checks", refs: ["X1"] });
  assert.deepEqual(f.view().components.map((component) => component.id), ["W1"]);
  f.table({ op: "next", text: "Build the mobile result" });
  const plan = f.view().components.find((component) => component.kind === "plan")!;
  assert.deepEqual(plan.refs.map((ref) => ref.id), ["X2"]);
  assert.equal(f.view().counts.activeTasks, 2, "presentation deduplication never removes actual work");
  f.table({ op: "archive", target: "W1" });
  assert.deepEqual(f.view().components.find((component) => component.kind === "plan")!.refs.map((ref) => ref.id), ["X1", "X2"]);
});

test("complete table history preserves source freshness after the transport event window rolls over", () => {
  const f = fixture();
  f.table({ op: "propose", title: "Prototype", body: "Version one" });
  f.table({ op: "component", kind: "custom", title: "Version comparison", refs: ["P1"], body: "Snapshot of version one" });
  f.table({ op: "edit", target: "P1", body: "Version two" });
  for (let i = 0; i < 101; i += 1) f.table({ op: "fact", text: `Unrelated observation ${i}` });
  const ops = f.events.filter((event): event is Extract<RoomEvent, { type: "table.op" }> => event.type === "table.op")
    .map(({ seq, ts, op }) => ({ seq, ts, op }));
  const complete = f.view();
  const reconnected = workTableView(f.room, f.events.slice(-100), ops);
  assert.equal(complete.components.find((component) => component.id === "W1")!.stale, true);
  assert.equal(reconnected.components.find((component) => component.id === "W1")!.stale, true);
  assert.deepEqual(reconnected.events, complete.events);
  assert.equal(reconnected.events.length, 3);
  f.table({ op: "component", target: "W1", kind: "custom", title: "Version comparison", refs: ["P1"], body: "Snapshot of version two" });
  const refreshedOps = [...ops, f.events.at(-1)! as Extract<RoomEvent, { type: "table.op" }>];
  assert.equal(workTableView(f.room, f.events.slice(-100), refreshedOps).components.find((component) => component.id === "W1")!.stale, false);
});

test("human presentation changes update context without queueing idle agents", () => {
  const f = fixture();
  f.table({ op: "next", text: "Implement layout" });
  f.append({ type: "run.started", runId: "r1", trigger: null, budget: null });
  f.start("codex");
  f.table({ op: "component", kind: "plan", title: "Layout plan", refs: ["X1"] }, "Ivan");
  assert.equal(f.view().team.find((agent) => agent.id === "claude")!.state, "idle");
  f.table({ op: "archive", target: "W1" }, "Ivan");
  assert.equal(f.view().team.find((agent) => agent.id === "claude")!.state, "idle");
});

test("archive and restore preserve the content version and cannot make stale component content current", () => {
  const f = fixture();
  f.table({ op: "propose", title: "Prototype", body: "Version one" });
  f.table({ op: "component", kind: "custom", title: "Version comparison", refs: ["P1"], body: "Snapshot of version one" });
  const contentSeq = f.room.table.components![0]!.contentSeq;
  f.table({ op: "edit", target: "P1", body: "Version two" });
  f.table({ op: "archive", target: "W1" });
  f.table({ op: "restore", target: "W1" }, "Ivan");
  const restored = f.view().components.find((component) => component.id === "W1")!;
  assert.equal(restored.contentSeq, contentSeq);
  assert.ok(restored.updatedSeq > contentSeq!);
  assert.equal(restored.stale, true);
  assert.equal(restored.updatedBy, "Ivan");
  f.table({ op: "component", target: "W1", kind: "custom", title: "Version comparison", refs: ["P1"], body: "Snapshot of version two" });
  const refreshed = f.view().components.find((component) => component.id === "W1")!;
  assert.ok(refreshed.contentSeq! > contentSeq!);
  assert.equal(refreshed.stale, false);
});
