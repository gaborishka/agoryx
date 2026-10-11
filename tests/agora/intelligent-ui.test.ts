import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { AgoraDaemon } from "../../internal/agora/daemon.js";
import { agentKey } from "../../internal/agora/actor.js";
import { defaultUIValues, evaluateUI, parseIntelligentUI, UI_LIMITS, validateUIValues, type UIExpression } from "../../internal/agora/intelligent-ui.js";
import { applyTableOp, emptyTable, prepareTableOp, renderTableComponentMarkdown } from "../../internal/agora/table.js";
import { RoomStore } from "../../internal/agora/store.js";
import { isTablePresentationOp } from "../../internal/agora/wakes.js";
import { tableAssistRequests } from "../../internal/agora/table-assist.js";
import { runIntelligentUICommand } from "../../internal/agora/intelligent-ui-cli.js";
import { createTestRoom } from "./helpers.js";

const example = JSON.parse(readFileSync(resolve("docs/examples/delivery-explorer.json"), "utf8"));
const simple = () => ({ version: 1, description: "Illustrative model", inputs: [{ id: "people", label: "People", type: "number", min: 1, max: 10, value: 3 }], root: { type: "stack", children: [{ type: "input", id: "people" }, { type: "metric", label: "Days", value: { op: "divide", args: [30, { input: "people" }] } }] } });
const publish = (ui: unknown, extra = {}) => ({ op: "component", kind: "interactive", title: "Explorer", ui, refs: [], ...extra });

test("composed delivery explorer is portable JSON and recalculates without evaluation of code", () => {
  const spec = parseIntelligentUI(JSON.stringify(example));
  assert.deepEqual(parseIntelligentUI(JSON.stringify(spec)), spec);
  const values = defaultUIValues(spec);
  const days: UIExpression = { op: "add", args: [{ op: "divide", args: [{ input: "scope" }, { input: "team" }] }, { op: "if", args: [{ input: "review" }, 3, 0] }] };
  assert.equal(evaluateUI(days, values), 15);
  assert.equal(evaluateUI(days, { ...values, team: 6 }), 9);
  assert.equal(evaluateUI(days, { ...values, team: 6, review: false }), 6);
  assert.equal(evaluateUI({ op: "divide", args: [30, 0] }, values), null);
  assert.equal(evaluateUI({ op: "multiply", args: [1e308, 1e308] }, values), null);
  assert.equal(evaluateUI({ op: "add", args: ["no number", 3] }, values), null);
  assert.equal(evaluateUI({ op: "if", args: [{ op: "equal", args: ["A", "A"] }, "Selected", "Other"] }, values), "Selected");
});

test("unknown behavior, executable fields, fake references and duplicate controls are refused with paths", () => {
  for (const [root, pattern] of [
    [{ type: "script", text: "alert(1)" }, /ui.root: unknown node/],
    [{ type: "text", text: "Safe", onClick: "fetch('/api')" }, /unknown field 'onClick'/],
    [{ type: "metric", label: "Forged", value: { op: "eval", args: ["1+1"] } }, /unknown arithmetic/],
    [{ type: "metric", label: "Missing", value: { input: "secret" } }, /unknown input/],
    [{ type: "sources", refs: ["F99"] }, /sources must be included/],
    [{ type: "stack", children: [{ type: "input", id: "people" }, { type: "input", id: "people" }] }, /only once/],
  ] as const) assert.throws(() => parseIntelligentUI({ ...simple(), root }), pattern);
  assert.throws(() => parseIntelligentUI({ ...simple(), version: 2 }), /version/);
  assert.throws(() => parseIntelligentUI('{"root":'), /valid JSON/);
  assert.throws(() => parseIntelligentUI({ ...simple(), root: { type: "text", text: "Hidden input" } }), /needs an input node/);
  assert.throws(() => parseIntelligentUI({ ...simple(), inputs: [{ ...simple().inputs[0], id: "constructor" }] }), /input id/);
});

test("layout, expression, data and payload budgets fail closed", () => {
  let root: any = { type: "text", text: "Leaf" };
  for (let i = 0; i < 10; i++) root = { type: "stack", children: [root] };
  assert.throws(() => parseIntelligentUI({ ...simple(), root }), /complexity/);
  const leaf = { type: "text", text: "Leaf" };
  assert.throws(() => parseIntelligentUI({ ...simple(), inputs: [], root: { type: "grid", children: Array(24).fill({ type: "stack", children: Array(4).fill(leaf) }) } }), /complexity/);
  assert.throws(() => parseIntelligentUI(" ".repeat(48_001)), /48,000/);
  const table = { type: "table", columns: Array(8).fill("Column"), rows: Array(40).fill(Array(8).fill(1)) };
  assert.throws(() => parseIntelligentUI({ ...simple(), inputs: [], root: table }), /240 table cells/);
  assert.throws(() => parseIntelligentUI({ ...simple(), inputs: [{ ...simple().inputs[0], step: 0 }] }), /step/);
  assert.throws(() => parseIntelligentUI({ ...simple(), inputs: [{ ...simple().inputs[0], value: Infinity }] }), /finite/);
});

test("saved input validation rejects missing, extra, mismatched and out-of-range values", () => {
  const spec = parseIntelligentUI(example);
  const values = defaultUIValues(spec);
  assert.deepEqual(validateUIValues(spec, values), values);
  for (const invalid of [{}, { ...values, other: 1 }, { ...values, team: "3" }, { ...values, team: 0 }, { ...values, scope: NaN }, { ...values, review: "yes" }]) assert.throws(() => validateUIValues(spec, invalid));
});

test("publication retains authority; input saves use optimistic concurrency and preserve authorship", () => {
  const table = emptyTable();
  const create = prepareTableOp(table, publish(simple(), { by: "Ivan", inputSnapshot: { by: "Ivan", seq: 90 } }), "codex", false);
  applyTableOp(table, create, 1);
  assert.equal(table.components![0]!.by, "codex");
  assert.equal(table.components![0]!.inputSnapshot, undefined);
  const save = { op: "component-input", target: "W1", revision: 1, inputSeq: 0, values: { people: 4 } };
  assert.throws(() => prepareTableOp(table, save, "codex", false), /Only the human/);
  assert.throws(() => prepareTableOp(table, { ...save, revision: 99 }, "Ivan", true), /changed/);
  const op = prepareTableOp(table, save, "Ivan", true);
  applyTableOp(table, op, 2);
  assert.equal(table.components![0]!.contentBy, "codex");
  assert.equal(table.components![0]!.contentSeq, 1);
  assert.deepEqual(table.components![0]!.inputSnapshot, { by: "Ivan", seq: 2, values: { people: 4 } });
  assert.throws(() => prepareTableOp(table, save, "Ivan", true), /changed/);
  applyTableOp(table, op, 3); // stale/repeated historical op cannot overwrite a newer scenario
  assert.equal(table.components![0]!.inputSnapshot!.seq, 2);
  assert.match(renderTableComponentMarkdown(table, "W1"), /Saved inputs by Ivan/);
  assert.match(renderTableComponentMarkdown(table, "W1"), /"people":4/);
  assert.throws(() => prepareTableOp(table, publish(simple(), { target: "W1" }), "claude", false), /only they or the human/);
  applyTableOp(table, prepareTableOp(table, { op: "archive", target: "W1" }, "codex", false), 4);
  assert.throws(() => prepareTableOp(table, { ...save, inputSeq: 2 }, "Ivan", true), /not active/);
  applyTableOp(table, prepareTableOp(table, { op: "restore", target: "W1" }, "codex", false), 5);
  assert.equal(table.components![0]!.inputSnapshot!.seq, 2);
  applyTableOp(table, prepareTableOp(table, publish(simple(), { target: "W1" }), "codex", false), 6);
  assert.equal(table.components![0]!.inputSnapshot, undefined, "a new model cannot silently reinterpret a saved scenario");
  assert.throws(() => prepareTableOp(table, { ...save, inputSeq: 2 }, "Ivan", true), /changed/);
  assert.equal(isTablePresentationOp("component-input"), true);
});

test("agent CLI publishes JSON, human saves survive replay, and neither operation starts model turns", async () => {
  const room = createTestRoom();
  try {
    writeFileSync(join(room.store.state.workspace, "tool.json"), JSON.stringify(example));
    const env = { ...room.env, AGORYX_TURN_FILE: "", AGORYX_AGENT: "codex", AGORYX_ROOM: room.store.id };
    const cli = (args: string[]) => promisify(execFile)(process.execPath, [resolve("bin/agoryx-agent.mjs"), "table", ...args], { cwd: room.store.state.workspace, env, timeout: 10_000 });
    assert.match((await cli(["component", "Delivery explorer", "--kind", "interactive", "--body-file", "tool.json"])).stdout, /W1/);
    const component = room.store.state.table.components![0]!;
    const input = { op: "component-input", target: "W1", revision: component.contentSeq, inputSeq: 0, values: { scope: 45, team: 5, review: true }, nonce: "save-scenario-123" };
    room.engine.tableOp(input, "Ivan");
    const seq = room.store.state.seq;
    room.engine.tableOp(input, "Ivan");
    assert.equal(room.store.state.seq, seq, "retry is idempotent");
    assert.equal(room.store.state.turns.length, 0);
    assert.equal(room.store.state.table.decisions.length, 0);
    assert.match((await cli(["show", "W1"])).stdout, /"team":5/);
    await room.engine.close();
    const replay = RoomStore.open(room.roomsRoot, room.store.id);
    assert.deepEqual(replay.state.table.components, room.store.state.table.components);
  } finally { await room.cleanup(); }
});

test("tool requests route to one author and require an actual interactive publication", async () => {
  const room = createTestRoom({ rules: [{ kind: "codex", text: "::pass::" }] });
  try {
    room.engine.tableOp(publish(simple()), "codex");
    const request = room.engine.tableAssist({ kind: "tool", agent: "codex", target: "W1", guidance: "Improve this @all", nonce: "tool-request-123" });
    assert.deepEqual(request.mentions, ["codex"]);
    assert.equal(request.tableAssist!.kind, "tool");
    // Receipt checks use real publications, not the mere completion of a turn.
    assert.notEqual(tableAssistRequests(room.store.state, [])[0]?.status, "ready");
  } finally { await room.cleanup(); }
});

test("projection UI is independent of its immutable source event", () => {
  const table = emptyTable();
  const op = prepareTableOp(table, publish(simple()), "codex", false);
  applyTableOp(table, op, 1);
  table.components![0]!.ui!.description = "Changed projection";
  table.components![0]!.ui!.inputs[0]!.label = "Changed input";
  assert.equal(op.op === "component" && op.ui!.description, "Illustrative model");
  assert.equal(op.op === "component" && op.ui!.inputs[0]!.label, "People");
});

test("HTTP enforces human input authority, rejects invalid publications atomically and returns saved state", async () => {
  const home = mkdtempSync(join(tmpdir(), "agoryx-ui-api-"));
  const daemon = new AgoraDaemon({ port: 0, advertise: false, env: { ...process.env, AGORYX_HOME: home, AGORYX_USER: "Ivan", CODEX_HOME: join(home, "codex"), CLAUDE_CONFIG_DIR: join(home, "claude") }, runners: {}, opsPollMs: 20 });
  try {
    const { port } = await daemon.start();
    const call = async (path: string, body?: unknown, token = daemon.token) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: body === undefined ? "GET" : "POST", headers: { "x-agoryx-token": token, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, data: await response.json() as any };
    };
    const created = await call("/api/rooms", { name: "Intelligent UI HTTP", mode: "chat", agents: [{ id: "codex", kind: "codex", label: "Codex" }] });
    assert.equal(created.status, 201);
    const id = created.data.room.id;
    const path = `/api/rooms/${id}`;
    const token = agentKey(daemon.token, id, "codex");
    const tool = await call(path + "/table", publish(simple()), token);
    assert.equal(tool.status, 201);
    assert.equal(tool.data.table.components[0].by, "codex");
    const revision = tool.data.table.components[0].contentSeq;
    const save = { op: "component-input", target: "W1", revision, inputSeq: 0, values: { people: 7 }, nonce: "http-scenario-123" };
    const refused = await call(path + "/table", { ...save, by: "Ivan", isHuman: true }, token);
    assert.equal(refused.status, 400);
    assert.match(refused.data.error, /Only the human/);
    const invalid = await call(path + "/table", publish({ ...simple(), root: { type: "script", text: "alert(1)" } }), token);
    assert.equal(invalid.status, 400);
    assert.equal((await call(path)).data.state.seq, tool.data.seq, "rejections append no events");
    const saved = await call(path + "/table", save);
    assert.equal(saved.status, 201);
    assert.equal(saved.data.table.components[0].inputSnapshot.by, "Ivan");
    assert.equal(saved.data.table.components[0].inputSnapshot.values.people, 7);
    assert.equal((await call(path + "/table", save)).data.seq, saved.data.seq);
    assert.equal((await call(path + "/table", { ...save, nonce: "another-save-123" })).status, 400);
    const state = (await call(path)).data.state;
    assert.equal(state.turns.length, 0);
    assert.equal(state.table.decisions.length, 0);
  } finally { await daemon.close(); rmSync(home, { recursive: true, force: true }); }
});

test("select controls support conditional metrics and refuse values outside their declared options", () => {
  const input = { id: "mode", label: "Plan", type: "select", value: "Basic", options: ["Basic", "Extended"] };
  const spec = parseIntelligentUI({ version: 1, description: "Compare plans", inputs: [input], root: { type: "input", id: "mode" } });
  const formula: UIExpression = { op: "if", args: [{ op: "equal", args: [{ input: "mode" }, "Basic"] }, 10, 25] };
  assert.equal(evaluateUI(formula, defaultUIValues(spec)), 10);
  assert.equal(evaluateUI(formula, validateUIValues(spec, { mode: "Extended" })), 25);
  assert.throws(() => validateUIValues(spec, { mode: "Missing" }), /type or range/);
  assert.throws(() => parseIntelligentUI({ ...spec, inputs: [{ ...input, options: ["Basic", "Basic"] }] }), /unique/);
});

const composed = (root: unknown, inputs: unknown[] = []) => ({ version: 1, description: "Task-specific workspace", inputs, root });
const extended = () => composed({ type: "stack", children: [
  { type: "heading", text: "Launch workspace", level: 2 },
  { type: "badge", label: "Draft", tone: "warning" },
  { type: "grid", columns: 3, children: [{ type: "input", id: "name" }, { type: "input", id: "notes" }, { type: "input", id: "budget" }] },
  { type: "progress", label: "Budget allocation", value: { input: "budget" }, max: 100, unit: "%", detail: "Illustrative allocation" },
  { type: "divider" },
  { type: "accordion", sections: [
    { title: "Plan", children: [{ type: "list", title: "Next steps", items: [{ title: "Review", detail: "Discuss the proposal", status: "doing" }, { title: "Choose" }] }] },
    { title: "History", children: [{ type: "timeline", title: "Milestones", items: [{ title: "Prototype", date: "October 7", status: "done" }] }] },
  ] },
  { type: "comparison", columns: [
    { title: "Current", subtitle: "Room scenario", badge: "Exploring", items: [{ label: "Name", value: { input: "name" } }] },
    { title: "Alternative", items: [{ label: "Name", value: { op: "concat", args: ["Plan: ", { input: "name" }] } }] },
  ] },
  { type: "table", caption: "Scenario data", searchable: true, sortable: false, columns: ["Name", "Value"], rows: [["Budget", { input: "budget" }]] },
  ...["bar", "line", "area", "donut"].map(variant => ({ type: "chart", variant, title: variant, items: [{ label: "A", value: 3 }, { label: "B", value: 7 }] })),
] }, [
  { id: "name", label: "Project name", type: "text", value: "  My plan  ", placeholder: "A working title", maxLength: 80 },
  { id: "notes", label: "Assumptions", type: "textarea", value: "", placeholder: "Record assumptions" },
  { id: "budget", label: "Budget", type: "number", min: 0, max: 100, step: 0.01, value: 0.04, presentation: "number" },
]);

test("extended version-1 compositions preserve authored data and canonicalize round-trip", () => {
  const source = extended();
  const before = structuredClone(source);
  const spec = parseIntelligentUI(source);
  assert.deepEqual(parseIntelligentUI(JSON.stringify(spec)), spec);
  assert.deepEqual(source, before, "canonicalization does not mutate the caller's spec");
  assert.deepEqual(defaultUIValues(spec), { name: "  My plan  ", notes: "", budget: 0.04 });
  assert.equal(spec.inputs[1]!.type === "textarea" && spec.inputs[1]!.maxLength, 2000);
  assert.equal(spec.root.type, "stack");
  if (spec.root.type === "stack") {
    assert.deepEqual(spec.root.children[7], { type: "table", caption: "Scenario data", searchable: true, sortable: false, columns: ["Name", "Value"], rows: [["Budget", { input: "budget" }]] });
    assert.deepEqual(spec.root.children.slice(8).map(n => n.type === "chart" && n.variant), ["bar", "line", "area", "donut"]);
  }
  // Old version-1 payloads need no migration or extra fields.
  const old = parseIntelligentUI(example);
  assert.deepEqual(parseIntelligentUI(JSON.stringify(old)), old);
});

test("new node fields are strict at every nesting level", () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ type: "heading", text: "Title", level: 1 }, /ui.root.level/],
    [{ type: "heading", text: "Title", href: "javascript:alert(1)" }, /unknown field 'href'/],
    [{ type: "divider", children: [] }, /unknown field 'children'/],
    [{ type: "badge", label: "Status", tone: "approved" }, /ui.root.tone/],
    [{ type: "grid", columns: "3", children: [{ type: "divider" }] }, /ui.root.columns/],
    [{ type: "stack", columns: 3, children: [{ type: "divider" }] }, /unknown field 'columns'/],
    [{ type: "progress", label: "Progress", value: 1, max: 10, action: "approve" }, /unknown field 'action'/],
    [{ type: "progress", label: "Progress", value: 1 }, /ui.root.max/],
    [{ type: "chart", title: "Chart", variant: "pie", items: [{ label: "A", value: 1 }] }, /ui.root.variant/],
    [{ type: "list", items: [{ title: "Task", date: "Tomorrow" }] }, /ui.root.items\[0\].*unknown field 'date'/],
    [{ type: "timeline", items: [{ title: "Task", status: "approved" }] }, /ui.root.items\[0\].status/],
    [{ type: "accordion", sections: [{ title: "Section", children: [{ type: "divider" }], open: true }] }, /ui.root.sections\[0\].*unknown field 'open'/],
    [{ type: "comparison", columns: [{ title: "A", items: [{ label: "Cost", value: 10, url: "https://example.com" }] }, { title: "B", items: [{ label: "Cost", value: 20 }] }] }, /ui.root.columns\[0\].items\[0\].*unknown field 'url'/],
    [{ type: "table", columns: ["A"], rows: [[1]], searchable: "true" }, /ui.root.searchable/],
    [{ type: "table", columns: ["A"], rows: [[1]], sortable: null }, /ui.root.sortable/],
  ];
  for (const [root, expected] of cases) assert.throws(() => parseIntelligentUI(composed(root)), expected);
});

test("collection bounds apply within and across accordion, list, timeline and comparison nodes", () => {
  const item = { title: "Task" };
  const column = { title: "Option", items: [{ label: "Metric", value: 1 }] };
  for (const root of [
    { type: "list", items: Array(25).fill(item) },
    { type: "timeline", items: [] },
    { type: "accordion", sections: [] },
    { type: "accordion", sections: Array(13).fill({ title: "Section", children: [{ type: "divider" }] }) },
    { type: "comparison", columns: [column] },
    { type: "comparison", columns: Array(5).fill(column) },
    { type: "comparison", columns: [column, { ...column, items: Array(25).fill(column.items[0]) }] },
  ]) assert.throws(() => parseIntelligentUI(composed(root)), /items/);
  const sections = Array.from({ length: 10 }, (_, i) => ({ title: `Section ${i}`, children: [{ type: i % 2 ? "timeline" : "list", items: Array(24).fill(item) }] }));
  assert.doesNotThrow(() => parseIntelligentUI(composed({ type: "accordion", sections })));
  assert.throws(() => parseIntelligentUI(composed({ type: "stack", children: [{ type: "accordion", sections }, { type: "comparison", columns: [column, column] }] })), /240 list, timeline and comparison items/);
  let nested: unknown = { type: "divider" };
  for (let i = 0; i < 9; i++) nested = { type: "accordion", sections: [{ title: "Nested", children: [nested] }] };
  assert.throws(() => parseIntelligentUI(composed(nested)), /layout complexity/);
  assert.throws(() => parseIntelligentUI(composed({ type: "grid", children: Array(24).fill({ type: "accordion", sections: [{ title: "Nested", children: Array(3).fill({ type: "divider" }) }] }) })), /layout complexity/);
});

test("hidden input controls in accordion sections retain uniqueness and required coverage", () => {
  const input = { id: "note", label: "Note", type: "textarea", value: "" };
  const section = { title: "Details", children: [{ type: "input", id: "note" }] };
  assert.doesNotThrow(() => parseIntelligentUI(composed({ type: "accordion", sections: [section] }, [input])));
  assert.throws(() => parseIntelligentUI(composed({ type: "accordion", sections: [section, section] }, [input])), /only once/);
  assert.throws(() => parseIntelligentUI(composed({ type: "accordion", sections: [{ title: "Details", children: [{ type: "divider" }] }] }, [input])), /needs an input node/);
});

test("text inputs preserve empty values and whitespace while enforcing declared persisted limits", () => {
  const base = { id: "note", label: "Note", type: "textarea", value: "", maxLength: 4 };
  const parse = (patch = {}) => parseIntelligentUI(composed({ type: "input", id: "note" }, [{ ...base, ...patch }]));
  const spec = parse();
  assert.deepEqual(validateUIValues(spec, { note: " \n  " }), { note: " \n  " });
  assert.deepEqual(validateUIValues(spec, { note: "" }), { note: "" });
  assert.deepEqual(validateUIValues(spec, { note: "🧠🧠" }), { note: "🧠🧠" });
  for (const value of ["12345", "🧠🧠🧠", 42, false, null, {}, []]) assert.throws(() => validateUIValues(spec, { note: value }), /type or range/);
  for (const maxLength of [0, -1, 2001, 1.5, "4", null, Infinity]) assert.throws(() => parse({ maxLength }), /maxLength/);
  for (const patch of [{ value: "12345" }, { value: null }, { placeholder: 3 }, { options: ["A", "B"] }, { pattern: ".*" }]) assert.throws(() => parse(patch));
  assert.throws(() => parse({ maxLength: 2000, value: "x".repeat(2001) }), /at most 2000/);
  assert.doesNotThrow(() => parse({ maxLength: 2000, value: "x".repeat(2000) }));
  const numberInput = simple().inputs[0]!;
  assert.throws(() => parseIntelligentUI({ ...simple(), inputs: [{ ...numberInput, presentation: "script" }] }), /presentation/);
  assert.doesNotThrow(() => parseIntelligentUI({ ...simple(), inputs: [{ ...numberInput, presentation: "slider" }] }));
});

test("text and boolean operations have strict types, arities and bounded output", () => {
  const parse = (value: unknown) => parseIntelligentUI(composed({ type: "metric", label: "Computed", value }));
  const expr = (op: Extract<UIExpression, { op: string }>['op'], args: UIExpression[]): UIExpression => ({ op, args });
  assert.equal(evaluateUI(expr("concat", ["Hello", " ", "world", 42, true]), {}), "Hello world42true");
  assert.equal(evaluateUI(expr("length", ["🧠"]), {}), 2);
  assert.equal(evaluateUI(expr("length", [42]), {}), null);
  assert.equal(evaluateUI(expr("not", [false]), {}), true);
  assert.equal(evaluateUI(expr("not", [0]), {}), null);
  assert.equal(evaluateUI(expr("and", [true, false]), {}), false);
  assert.equal(evaluateUI(expr("or", [false, true]), {}), true);
  for (const op of ["and", "or"] as const) {
    assert.equal(evaluateUI(expr(op, [true, 1]), {}), null);
    assert.equal(evaluateUI(expr(op, [true, { input: "missing" }]), {}), null, "unknown values must not be short-circuited into certainty");
  }
  assert.equal(evaluateUI(expr("concat", ["Available? ", { op: "divide", args: [1, 0] }]), {}), null);
  const atLimit = expr("concat", Array(8).fill("x".repeat(1000)));
  assert.doesNotThrow(() => parse(atLimit));
  assert.equal((evaluateUI(atLimit, {}) as string).length, UI_LIMITS.resultText);
  const aboveLimit = expr("concat", [atLimit, "x"]);
  assert.doesNotThrow(() => parse(aboveLimit));
  assert.equal(evaluateUI(aboveLimit, {}), null);
  assert.equal(evaluateUI(expr("length", [aboveLimit]), {}), null);
  for (const op of ["length", "not", "round"] as const) assert.throws(() => parse(expr(op, [true, false])), /takes one argument/);
  for (const op of ["concat", "and", "or"] as const) {
    assert.throws(() => parse(expr(op, [])), /1–8 items/);
    assert.throws(() => parse(expr(op, Array(9).fill(true))), /1–8 items/);
  }
  const emptyEquality = expr("equal", [{ op: "concat", args: ["", ""] }, ""]);
  assert.doesNotThrow(() => parse(emptyEquality));
  assert.equal(evaluateUI(emptyEquality, {}), true);
});

test("new expression-bearing nodes share the global expression budget and reject executable shapes", () => {
  const large: UIExpression = { op: "add", args: Array(8).fill({ op: "add", args: Array(8).fill(1) }) };
  const column = { title: "Option", items: Array(9).fill({ label: "Metric", value: large }) };
  assert.throws(() => parseIntelligentUI(composed({ type: "comparison", columns: [column, column] })), /expression complexity/);
  const dangerous = JSON.parse('{"type":"progress","label":"Unsafe","value":{"op":"add","args":[1],"__proto__":{"polluted":true}},"max":100}');
  assert.throws(() => parseIntelligentUI(composed(dangerous)), /unknown field '__proto__'/);
  assert.equal(({} as any).polluted, undefined);
  assert.throws(() => parseIntelligentUI(composed({ type: "progress", label: "Unsafe", value: NaN, max: 1 })), /finite/);
  assert.throws(() => parseIntelligentUI(composed({ type: "progress", label: "Unsafe", value: 1, max: Infinity })), /finite/);
});

test("extended inputs survive author-preserving save and replay, and invalid text writes are atomic", async () => {
  const room = createTestRoom();
  try {
    room.engine.tableOp(publish(extended()), "codex");
    const component = room.store.state.table.components![0]!;
    const values = { name: "  Release  ", notes: "Assumption\nStill uncertain", budget: 0.04 };
    const request = { op: "component-input", target: component.id, revision: component.contentSeq, inputSeq: 0, values };
    const before = room.store.state.seq;
    assert.throws(() => room.engine.tableOp({ ...request, values: { ...values, notes: "x".repeat(2001) } }, "Ivan"), /type or range/);
    assert.equal(room.store.state.seq, before);
    room.engine.tableOp(request, "Ivan");
    assert.deepEqual(component.inputSnapshot?.values, values);
    assert.equal(component.contentBy, "codex");
    assert.equal(room.store.state.turns.length, 0);
    await room.engine.close();
    const replay = RoomStore.open(room.roomsRoot, room.store.id);
    assert.deepEqual(replay.state.table.components, room.store.state.table.components);
  } finally { await room.cleanup(); }
});

test("canonical defaults cannot turn an accepted publication into an oversized unrenderable spec", async () => {
  const sizedSpec = (target: number) => {
    const inputs = Array.from({ length: 16 }, (_, i) => ({ id: `notes${i}`, label: "Notes", type: "textarea", value: "" }));
    const texts = Array.from({ length: 16 }, () => ({ type: "text", text: "x".repeat(2800) }));
    const spec = composed({ type: "stack", children: [
      { type: "stack", children: inputs.map(input => ({ type: "input", id: input.id })) },
      { type: "stack", children: texts },
    ] }, inputs);
    let remaining = target - JSON.stringify(spec).length;
    for (const node of texts) {
      const added = Math.min(remaining, 3000 - node.text.length);
      node.text += "x".repeat(added);
      remaining -= added;
    }
    assert.equal(remaining, 0);
    assert.equal(JSON.stringify(spec).length, target);
    return spec;
  };
  // Each omitted textarea maxLength adds 17 characters to the normalized form.
  const boundary = sizedSpec(UI_LIMITS.bytes - 16 * 17);
  const canonical = parseIntelligentUI(boundary);
  assert.equal(JSON.stringify(canonical).length, UI_LIMITS.bytes);
  assert.deepEqual(parseIntelligentUI(JSON.stringify(canonical)), canonical);
  const oversized = sizedSpec(UI_LIMITS.bytes);
  assert.throws(() => parseIntelligentUI(oversized), /normalized spec exceeds 48,000/);
  const output: string[] = [];
  assert.equal(runIntelligentUICommand(["check", "--body", JSON.stringify(oversized)], text => output.push(text)), 1);
  assert.match(output.join("\n"), /normalized spec exceeds 48,000/);
  const room = createTestRoom();
  try {
    const before = room.store.state.seq;
    assert.throws(() => room.engine.tableOp(publish(oversized), "codex"), /normalized spec exceeds 48,000/);
    assert.equal(room.store.state.seq, before, "oversized normalized content must fail before appending an event");
    assert.equal(room.store.state.table.components?.length ?? 0, 0);
    room.engine.tableOp(publish(boundary), "codex");
    assert.deepEqual(parseIntelligentUI(room.store.state.table.components![0]!.ui), canonical);
  } finally { await room.cleanup(); }
});
