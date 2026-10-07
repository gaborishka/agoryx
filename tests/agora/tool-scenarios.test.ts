import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTableOp, emptyTable, prepareTableOp, renderTableComponentMarkdown, TABLE_PRESENTATION_LIMITS } from "../../internal/agora/table.js";
import { RoomStore } from "../../internal/agora/store.js";
import type { TableState } from "../../internal/agora/types.js";
import { createTestRoom } from "./helpers.js";

const ui = (id = "people") => ({ version: 1, description: "Illustrative scenario model", inputs: [{ id, label: "People", type: "number", value: 3, min: 1, max: 100 }], root: { type: "input", id } });
const publish = (spec = ui(), extra = {}) => ({ op: "component", title: "Scenario tool", kind: "interactive", refs: [], ui: spec, ...extra });
const create = () => {
  const table = emptyTable();
  applyTableOp(table, prepareTableOp(table, publish(), "codex", false), 1);
  return table;
};
const request = (table: TableState, values = { people: 4 }, name?: unknown) => {
  const component = table.components![0]!;
  return { op: "component-input", target: component.id, revision: component.contentSeq, inputSeq: component.inputSnapshot?.seq ?? 0, values, ...(name === undefined ? {} : { name }) };
};
const save = (table: TableState, seq: number, values = { people: 4 }, name?: unknown) => {
  const op = prepareTableOp(table, request(table, values, name), "Ivan", true);
  applyTableOp(table, op, seq);
  return op;
};

test("scenario names normalize to bounded single-line text and optional names get durable defaults", () => {
  const table = create();
  save(table, 2, { people: 4 }, "  Conservative\n\t estimate  ");
  save(table, 3, { people: 5 }, "  \n  ");
  save(table, 4, { people: 6 }, "x".repeat(80));
  assert.deepEqual(table.components![0]!.scenarios!.map(s => s.name), ["Conservative estimate", "Scenario 3", "x".repeat(80)]);
  const before = structuredClone(table);
  for (const name of ["x".repeat(81), 42, false, {}, []]) {
    assert.throws(() => prepareTableOp(table, request(table, { people: 7 }, name), "Ivan", true), /scenario name/);
    assert.deepEqual(table, before, "invalid names cannot partially update the snapshot or history");
  }
  assert.match(renderTableComponentMarkdown(table, "W1"), /Conservative estimate — Ivan, event 2, model revision 1/);
});

test("scenario values, latest snapshot and original event own independent copies", () => {
  const table = create();
  const values = { people: 7 };
  const raw = request(table, values, "Chosen scenario");
  const op = prepareTableOp(table, raw, "Ivan", true);
  values.people = 99;
  applyTableOp(table, op, 2);
  const component = table.components![0]!;
  assert.equal(component.inputSnapshot!.values.people, 7);
  assert.equal(component.scenarios![0]!.values.people, 7);
  component.inputSnapshot!.values.people = 8;
  assert.equal(component.scenarios![0]!.values.people, 7);
  component.scenarios![0]!.values.people = 9;
  assert.equal(op.op === "component-input" && op.values.people, 7);
  assert.equal(component.contentBy, "codex");
  assert.equal(component.contentSeq, 1);
  assert.equal(component.by, "codex");
  assert.equal(component.scenarios![0]!.by, "Ivan");
});

test("model replacement clears current inputs but retains independently cloned prior revisions", () => {
  const table = create();
  save(table, 2, { people: 5 }, "Before revision");
  const previous = table.components![0]!;
  const replacement = prepareTableOp(table, publish(ui("capacity"), { target: "W1" }), "codex", false);
  applyTableOp(table, replacement, 3);
  const component = table.components![0]!;
  assert.equal(component.inputSnapshot, undefined);
  assert.deepEqual(component.scenarios, [{ values: { people: 5 }, by: "Ivan", seq: 2, name: "Before revision", revision: 1 }]);
  previous.scenarios![0]!.values.people = 98;
  previous.scenarios!.push({ values: { people: 99 }, by: "Old projection", seq: 99, name: "Mutated", revision: 1 });
  assert.equal(component.scenarios!.length, 1);
  assert.equal(component.scenarios![0]!.values.people, 5);
  const next = prepareTableOp(table, { op: "component-input", target: "W1", revision: 3, inputSeq: 0, name: "After revision", values: { capacity: 6 } }, "Ivan", true);
  applyTableOp(table, next, 4);
  assert.deepEqual(component.scenarios!.map(s => [s.revision, s.values]), [[1, { people: 5 }], [3, { capacity: 6 }]]);
  assert.deepEqual(component.inputSnapshot!.values, { capacity: 6 });
  assert.match(renderTableComponentMarkdown(table, "W1"), /model revision 1/);
  assert.match(renderTableComponentMarkdown(table, "W1"), /model revision 3/);
});

test("concurrent saves and stale replay never append a second history entry", () => {
  const table = create();
  const first = request(table, { people: 4 }, "First client");
  const second = request(table, { people: 8 }, "Other client");
  const accepted = prepareTableOp(table, first, "Ivan", true);
  applyTableOp(table, accepted, 2);
  assert.throws(() => prepareTableOp(table, second, "Ivan", true), /changed/);
  applyTableOp(table, accepted, 3);
  assert.equal(table.components![0]!.scenarios!.length, 1);
  assert.equal(table.components![0]!.inputSnapshot!.seq, 2);
  save(table, 4, { people: 8 }, "Other client");
  assert.deepEqual(table.components![0]!.scenarios!.map(s => s.seq), [2, 4]);
  assert.throws(() => prepareTableOp(table, request(table, { people: 9 }, "Forged"), "codex", false), /Only the human/);
  applyTableOp(table, prepareTableOp(table, { op: "archive", target: "W1" }, "Ivan", true), 5);
  assert.throws(() => prepareTableOp(table, request(table), "Ivan", true), /not active/);
  applyTableOp(table, prepareTableOp(table, { op: "restore", target: "W1" }, "Ivan", true), 6);
  assert.deepEqual(table.components![0]!.scenarios!.map(s => s.seq), [2, 4]);
});

test("history holds the most recent 24 scenarios across revisions without conflating duplicate names", () => {
  const table = create();
  for (let seq = 2; seq <= 13; seq++) save(table, seq, { people: seq }, "Same label");
  applyTableOp(table, prepareTableOp(table, publish(ui(), { target: "W1" }), "codex", false), 14);
  for (let seq = 15; seq <= 30; seq++) save(table, seq, { people: seq }, "Same label");
  const component = table.components![0]!;
  const expected = [...Array.from({ length: 8 }, (_, i) => i + 6), ...Array.from({ length: 16 }, (_, i) => i + 15)];
  assert.equal(component.scenarios!.length, 24);
  assert.deepEqual(component.scenarios!.map(s => s.seq), expected);
  assert.equal(component.scenarios!.filter(s => s.revision === 1).length, 8);
  assert.equal(component.scenarios!.filter(s => s.revision === 14).length, 16);
  assert.equal(component.scenarios!.every(s => s.name === "Same label"), true);
  assert.equal(component.inputSnapshot!.seq, 30);
});

test("unnamed historical save events replay into scenario history and retain provenance", () => {
  const table = create();
  applyTableOp(table, { op: "component-input", target: "W1", revision: 1, inputSeq: 0, values: { people: 8 }, by: "Ivan" }, 2);
  assert.deepEqual(table.components![0]!.scenarios, [{ values: { people: 8 }, by: "Ivan", seq: 2, revision: 1, name: "Scenario 2" }]);
});

test("large text history respects its aggregate byte budget while always retaining the latest scenario", () => {
  const inputs = Array.from({ length: 16 }, (_, i) => ({ id: `notes${i}`, label: `Notes ${i}`, type: "textarea", value: "", maxLength: 2000 }));
  const model = { version: 1, description: "Bounded text history", inputs, root: { type: "stack", children: inputs.map(input => ({ type: "input", id: input.id })) } };
  const table = emptyTable();
  applyTableOp(table, prepareTableOp(table, { op: "component", title: "Text tool", kind: "interactive", refs: [], ui: model }, "codex", false), 1);
  const allEvents = [];
  for (let seq = 2; seq <= 11; seq++) {
    const component = table.components![0]!;
    const values = Object.fromEntries(inputs.map(input => [input.id, String(seq % 10).repeat(2000)]));
    const op = prepareTableOp(table, { op: "component-input", target: "W1", revision: 1, inputSeq: component.inputSnapshot?.seq ?? 0, values, name: `Scenario ${seq}` }, "Ivan", true);
    allEvents.push(op);
    applyTableOp(table, op, seq);
  }
  const component = table.components![0]!;
  assert.ok(component.scenarios!.length < 10, "large records are trimmed before reaching the count limit");
  assert.ok(JSON.stringify(component.scenarios).length <= TABLE_PRESENTATION_LIMITS.scenarioHistoryChars);
  assert.equal(component.scenarios!.at(-1)!.seq, 11);
  assert.deepEqual(component.scenarios!.at(-1)!.values, component.inputSnapshot!.values);
  assert.equal(allEvents.length, 10, "trimming projections cannot remove the immutable event objects");
  const escaped = Object.fromEntries(inputs.map(input => [input.id, "\u0000".repeat(2000)]));
  applyTableOp(table, prepareTableOp(table, { op: "component-input", target: "W1", revision: 1, inputSeq: 11, values: escaped, name: "Large escaped text" }, "Ivan", true), 12);
  assert.ok(JSON.stringify(component.scenarios).length <= TABLE_PRESENTATION_LIMITS.scenarioHistoryChars);
  assert.equal(component.scenarios!.at(-1)!.seq, 12);
  assert.deepEqual(component.inputSnapshot!.values, escaped);
});

test("durable retries retain one named scenario even after model replacement and full JSONL replay", async () => {
  const room = createTestRoom();
  try {
    room.engine.tableOp(publish(), "codex");
    const first = { ...request(room.store.state.table, { people: 6 }, "Named scenario"), nonce: "scenario-stable-request" };
    room.engine.tableOp(first, "Ivan");
    const savedSeq = room.store.state.seq;
    room.engine.tableOp(first, "Ivan");
    assert.equal(room.store.state.seq, savedSeq);
    assert.throws(() => room.engine.tableOp({ ...first, name: "Other name" }, "Ivan"), /different action/);
    room.engine.tableOp(publish(ui(), { target: "W1" }), "codex");
    const replacedSeq = room.store.state.seq;
    room.engine.tableOp(first, "Ivan");
    assert.equal(room.store.state.seq, replacedSeq, "lost-ack retry cannot resurrect inputs of an earlier model");
    assert.equal(room.store.state.table.components![0]!.inputSnapshot, undefined);
    assert.equal(room.store.state.table.components![0]!.scenarios!.length, 1);
    for (let i = 0; i < 26; i++) room.engine.tableOp(request(room.store.state.table, { people: i + 1 }, `Run ${i}`), "Ivan");
    const events = room.store.events.filter(event => event.type === "table.op" && event.op.op === "component-input");
    assert.equal(events.length, 27, "JSONL retains history that aged out of the bounded projection");
    assert.equal(room.store.state.table.components![0]!.scenarios!.length, 24);
    assert.equal(room.store.state.turns.length, 0);
    assert.equal(room.store.state.table.decisions.length, 0);
    await room.engine.close();
    const replay = RoomStore.open(room.roomsRoot, room.store.id);
    assert.deepEqual(replay.state.table.components, room.store.state.table.components);
  } finally { await room.cleanup(); }
});
