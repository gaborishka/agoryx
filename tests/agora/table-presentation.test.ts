import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RoomStore } from "../../internal/agora/store.js";
import { applyEvent, initialState } from "../../internal/agora/projection.js";
import { workspaceAt } from "../../internal/agora/room-mode.js";
import { parseTableCommand, TableCommandError } from "../../internal/agora/table-cli.js";
import { applyTableOp, describeTableOp, emptyTable, prepareTableOp, renderTableMarkdown, summarizeTable, TableOpError, TABLE_PRESENTATION_LIMITS } from "../../internal/agora/table.js";
import { DEFAULT_SETTINGS, type RoomEvent, type TableOp, type TableState } from "../../internal/agora/types.js";

const fixture = () => {
  const table = emptyTable();
  let seq = 0;
  const play = (raw: unknown, by = "claude", human = by === "Ivan") => {
    const op = prepareTableOp(table, raw, by, human);
    applyTableOp(table, op, ++seq, { human });
    return op;
  };
  play({ op: "ask", text: "Which route?" });
  play({ op: "propose", title: "Small implementation", q: "Q1" });
  play({ op: "propose", title: "Full implementation", q: "Q1" }, "codex");
  play({ op: "next", text: "Build the small implementation", target: "P1" });
  play({ op: "evidence", target: "P1", text: "Fits current runtime", source: "internal/agora/table.ts" });
  play({ op: "fact", text: "Tests pass" });
  play({ op: "settle", text: "Keep the same event log" });
  return { table, play };
};

const component = (extra: Record<string, unknown> = {}) => ({ op: "component", title: "Routes", kind: "comparison", refs: ["Q1", "P1", "P2"], ...extra });

test("brief is a replacement with a trusted freshness cursor and no client-controlled authorship", () => {
  const { table, play } = fixture();
  const op = play({ op: "brief", now: "  Reviewing\n the implementation  ", changes: ["Tests pass"], next: "Decide the route", refs: ["#p1", "P1", "X1"], awaiting: { q: "q1", recommendation: "p1" }, asOfSeq: 9000, requestHash: "forged", by: "Ivan", seq: 999 });
  assert.equal(op.asOfSeq, undefined);
  assert.equal(op.requestHash, undefined);
  assert.equal(op.by, "claude");
  assert.deepEqual(table.brief, { now: "Reviewing the implementation", changes: ["Tests pass"], next: "Decide the route", refs: ["P1", "X1"], awaiting: { q: "Q1", recommendation: "P1" }, by: "claude", seq: 8, asOfSeq: 7 });
  const newer = prepareTableOp(table, { op: "brief", now: "Building", refs: ["X1"] }, "codex", false);
  applyTableOp(table, { ...newer, asOfSeq: 4, requestHash: "engine-hash" }, 9);
  assert.deepEqual(table.brief, { now: "Building", refs: ["X1"], by: "codex", seq: 9, asOfSeq: 4 });
  assert.doesNotMatch(renderTableMarkdown(table, "Room"), /Needs your choice/);
});

test("brief refuses invalid, closed and mismatched human requests", () => {
  const { table, play } = fixture();
  const brief = (awaiting: unknown) => prepareTableOp(table, { op: "brief", now: "Waiting", awaiting }, "claude", false);
  assert.throws(() => brief(null), /awaiting must name/);
  assert.throws(() => brief([]), /awaiting must name/);
  assert.throws(() => brief({ q: "Q9" }), /not an open question/);
  assert.throws(() => brief({ q: "P1" }), /not an open question/);
  assert.throws(() => brief({ q: "Q1", recommendation: "P9" }), /not an open option/);
  play({ op: "ask", text: "Another choice?" });
  play({ op: "propose", title: "Elsewhere", q: "Q2" });
  assert.throws(() => brief({ q: "Q1", recommendation: "P3" }), /not an open option for Q1/);
  play({ op: "withdraw", target: "P1" });
  assert.throws(() => brief({ q: "Q1", recommendation: "P1" }), /not an open option for Q1/);
  play({ op: "decide", target: "P2" }, "Ivan");
  assert.throws(() => brief({ q: "Q1" }), /not an open question/);
});

test("brief enforces concise field and reference limits without silently losing meaning", () => {
  const { table } = fixture();
  const bad = (fields: Record<string, unknown>) => () => prepareTableOp(table, { op: "brief", now: "Working", ...fields }, "claude", false);
  assert.throws(bad({ now: "x".repeat(TABLE_PRESENTATION_LIMITS.now + 1) }), /now must be at most/);
  assert.throws(bad({ next: "x".repeat(TABLE_PRESENTATION_LIMITS.next + 1) }), /next must be at most/);
  assert.throws(bad({ now: " " }), /missing now/);
  assert.throws(bad({ changes: ["one", "two", "three", "four"] }), /at most 3/);
  assert.throws(bad({ changes: [null] }), /missing change/);
  assert.throws(bad({ changes: ["x".repeat(TABLE_PRESENTATION_LIMITS.change + 1)] }), /change must be at most/);
  assert.throws(bad({ changes: "change" }), /array/);
  assert.throws(bad({ refs: "P1" }), /refs must be an array/);
  assert.throws(bad({ refs: Array(13).fill("P1") }), /at most 12/);
  assert.throws(bad({ refs: ["P900"] }), /no P900/);
  assert.throws(bad({ refs: ["not an id"] }), /not a table id/);
  assert.equal(prepareTableOp(table, { op: "brief", now: "x".repeat(400), changes: Array(3).fill("x".repeat(240)) }, "claude", false).op, "brief");
});

test("components keep stable identity and creator while replacement clears omitted content", () => {
  const { table, play } = fixture();
  const first = play(component({ body: "Context", file: "routes.svg" }));
  assert.equal(first.id, "W1");
  assert.deepEqual(table.components?.[0], { id: "W1", title: "Routes", kind: "comparison", refs: ["Q1", "P1", "P2"], body: "Context", file: "routes.svg", by: "claude", seq: 8, updatedSeq: 8, contentSeq: 8, asOfSeq: 7, contentBy: "claude", updatedBy: "claude" });
  const update = play(component({ target: "w1", title: "Revised routes", refs: ["P1", "P2"] }), "Ivan");
  assert.equal(update.id, undefined);
  assert.deepEqual(table.components?.[0], { id: "W1", title: "Revised routes", kind: "comparison", refs: ["P1", "P2"], by: "claude", seq: 8, updatedSeq: 9, contentSeq: 9, asOfSeq: 8, contentBy: "Ivan", updatedBy: "Ivan" });
  assert.match(renderTableMarkdown(table, "Room"), /updated at 9 by Ivan/);
  play(component({ target: "W1", title: "Creator can still update" }));
  assert.equal(table.components?.[0]?.updatedBy, "claude");
  play({ op: "brief", now: "See the comparison", refs: ["W1"] });
  assert.deepEqual(table.brief?.refs, ["W1"]);
  assert.equal(table.issued?.W, 1);
  assert.match(describeTableOp(update), /updated component W1/);
});

test("component ownership and archive/restore lifecycle cannot be bypassed by raw metadata", () => {
  const { table, play } = fixture();
  play(component());
  for (const raw of [component({ target: "W1" }), { op: "archive", target: "W1" }, { op: "restore", target: "W1" }]) {
    assert.throws(() => prepareTableOp(table, { ...raw, by: "claude", isHuman: true }, "codex", false), /only they or the human/);
  }
  assert.throws(() => play({ op: "restore", target: "W1" }), /already active/);
  play({ op: "archive", target: "W1" }, "Ivan");
  assert.equal(table.components?.[0]?.archived, true);
  assert.equal(table.components?.[0]?.updatedSeq, 9);
  assert.equal(table.components?.[0]?.updatedBy, "Ivan");
  assert.throws(() => play({ op: "archive", target: "W1" }), /already archived/);
  play({ op: "restore", target: "W1" });
  assert.equal(table.components?.[0]?.archived, undefined);
  assert.equal(table.components?.[0]?.seq, 8);
  assert.equal(table.components?.[0]?.updatedSeq, 10);
  assert.equal(table.components?.[0]?.updatedBy, "claude");
  assert.equal(play(component()).id, "W2");
  assert.throws(() => play(component({ target: "W3" })), /no component W3/);
  assert.throws(() => play({ op: "archive", target: "P1" }), /no component P1/);
});

test("component content keeps its workspace origin through lifecycle changes and moves only on replacement", () => {
  const created: RoomEvent = { type: "room.created", id: "origins", name: "Origins", workspace: "/workspace/old", createdWorkspace: false, human: "Ivan", agents: [], settings: { ...DEFAULT_SETTINGS }, seq: 1, ts: "2026-10-04T00:00:00Z" };
  const room = initialState(created);
  const move = (raw: unknown) => {
    const op = prepareTableOp(room.table, raw, "claude", false);
    applyEvent(room, { type: "table.op", op, seq: room.seq + 1, ts: created.ts });
  };
  move({ op: "component", title: "Result", kind: "custom", refs: [], file: "result.html", contentSeq: 9000, asOfSeq: 9000, contentBy: "Ivan" });
  assert.equal(room.table.components?.[0]?.contentSeq, 2, "a client cannot forge content origin");
  assert.equal(room.table.components?.[0]?.asOfSeq, 1);
  assert.equal(room.table.components?.[0]?.contentBy, "claude");
  move({ op: "archive", target: "W1" });
  applyEvent(room, { type: "room.mode.changed", mode: "work", workspace: "/workspace/new", by: "Ivan", seq: 4, ts: created.ts });
  move({ op: "restore", target: "W1" });
  const restored = room.table.components![0]!;
  assert.equal(restored.updatedSeq, 5);
  assert.equal(restored.contentSeq, 2);
  assert.equal(restored.asOfSeq, 1);
  assert.equal(restored.contentBy, "claude");
  assert.equal(workspaceAt(room, restored.contentSeq!), "/workspace/old", "restoring a card must not point its old file into the newly connected workspace");
  move({ op: "component", title: "New result", kind: "custom", refs: [], file: "result.html", target: "W1" });
  assert.equal(room.table.components?.[0]?.contentSeq, 6);
  assert.equal(workspaceAt(room, room.table.components![0]!.contentSeq!), "/workspace/new");
  move({ op: "archive", target: "W1" });
  move({ op: "restore", target: "W1" });
  assert.equal(room.table.components?.[0]?.contentSeq, 6);
  assert.equal(room.table.components?.[0]?.seq, 2, "creation identity is distinct from the current content publication");
});

test("native components validate their own reference kinds and custom previews require content", () => {
  const { table, play } = fixture();
  const good = [
    component(),
    component({ kind: "plan", refs: ["X1", "P1"] }),
    component({ kind: "checks", refs: ["X1", "N1", "F1", "S1"] }),
    component({ kind: "artifact", refs: [], file: "preview.svg" }),
    component({ kind: "custom", refs: ["P1"], body: "```html\n<button>Local selection</button>\n```" }),
  ];
  for (const raw of good) play(raw);
  const bad = [
    component({ kind: "unknown" }),
    component({ refs: [] }),
    component({ refs: ["F1"] }),
    component({ kind: "plan", refs: ["P1"] }),
    component({ kind: "plan", refs: ["Q1", "X1"] }),
    component({ kind: "checks", refs: ["P1"] }),
    component({ kind: "checks", refs: [] }),
    component({ kind: "custom", body: " " }),
    component({ kind: "artifact" }),
    component({ refs: ["W999"] }),
  ];
  for (const raw of bad) assert.throws(() => prepareTableOp(table, raw, "claude", false), TableOpError);
  play({ op: "decide", target: "P1" }, "Ivan");
  assert.doesNotThrow(() => prepareTableOp(table, component(), "claude", false), "closed and chosen items remain legitimate comparison context");
});

test("archived components with deleted references can be repaired safely before restoring", () => {
  const { table, play } = fixture();
  play(component({ refs: ["P2"] }));
  play({ op: "archive", target: "W1" });
  play({ op: "delete", target: "P2" }, "codex");
  assert.throws(() => prepareTableOp(table, component({ refs: ["P2"] }), "claude", false), /no P2/);
  assert.throws(() => prepareTableOp(table, { op: "restore", target: "W1" }, "claude", false), /no P2/);
  assert.throws(() => prepareTableOp(table, component({ target: "W1", refs: ["P2"] }), "claude", false), /no P2/);
  assert.throws(() => prepareTableOp(table, component({ target: "W1", refs: ["P1"] }), "codex", false), /only they or the human/);
  play(component({ target: "W1", title: "Repaired references", refs: ["P1"] }), "Ivan");
  assert.equal(table.components?.[0]?.archived, true, "repair must not unexpectedly put it back on the work surface");
  assert.equal(table.components?.[0]?.by, "claude");
  assert.equal(table.components?.[0]?.updatedBy, "Ivan");
  assert.deepEqual(table.components?.[0]?.refs, ["P1"]);
  play({ op: "restore", target: "W1" });
  assert.equal(table.components?.[0]?.archived, undefined);
  assert.equal(table.components?.[0]?.updatedBy, "claude");
  const fresh = play(component({ refs: ["P1"] }));
  assert.equal(fresh.id, "W2");
  assert.throws(() => prepareTableOp(table, component({ target: "W2", refs: ["P2"] }), "claude", false), /no P2/);
  assert.equal(table.components?.[1]?.refs[0], "P1");
});

test("component bounds cap content, total registry and visible work, including restores", () => {
  const { table, play } = fixture();
  for (const fields of [
    { title: "x".repeat(161) },
    { body: "x".repeat(24_001) },
    { file: "x".repeat(4_001) },
    { refs: Array(25).fill("P1") },
  ]) assert.throws(() => prepareTableOp(table, component(fields), "claude", false), TableOpError);
  for (let i = 0; i < TABLE_PRESENTATION_LIMITS.activeComponents; i += 1) play(component());
  assert.throws(() => play(component()), /archive an old one/);
  play({ op: "archive", target: "W1" });
  assert.equal(play(component()).id, "W13");
  assert.throws(() => play({ op: "restore", target: "W1" }), /at most 12/);
  play({ op: "archive", target: "W13" });
  play({ op: "restore", target: "W1" });
  assert.equal(table.components?.[0]?.archived, undefined);
  for (const entry of table.components ?? []) if (!entry.archived) play({ op: "archive", target: entry.id });
  for (let i = table.components!.length; i < TABLE_PRESENTATION_LIMITS.components; i += 1) {
    const created = play(component());
    play({ op: "archive", target: created.id });
  }
  assert.throws(() => play(component()), /at most 128/);
  play({ op: "restore", target: "W1" });
  play(component({ target: "W1", title: "Reuse a registered component" }));
});

test("JSONL replay preserves old rooms, briefs, component identity and lifecycle", () => {
  const scratch = mkdtempSync(join(tmpdir(), "agoryx-table-presentation-"));
  try {
    const store = RoomStore.create(scratch, { name: "Room", workspace: scratch, createdWorkspace: false, human: "Ivan", agents: [], settings: { ...DEFAULT_SETTINGS } });
    const append = (raw: unknown, by = "claude") => {
      const op = prepareTableOp(store.state.table, raw, by, by === "Ivan");
      return store.append({ type: "table.op", op });
    };
    append({ op: "ask", text: "Which route?" });
    append({ op: "propose", title: "Small", q: "Q1" });
    const legacy = RoomStore.open(scratch, store.state.id);
    assert.equal(legacy.state.table.brief, undefined);
    assert.equal(legacy.state.table.components, undefined);
    append(component({ refs: ["Q1", "P1"] }));
    append({ op: "brief", now: "Choose a route", awaiting: { q: "Q1", recommendation: "P1" }, refs: ["W1"] });
    append({ op: "archive", target: "W1" });
    append({ op: "restore", target: "W1" }, "Ivan");
    append(component({ target: "W1", title: "Routes maintained by Ivan", refs: ["Q1", "P1"] }), "Ivan");
    const reopened = RoomStore.open(scratch, store.state.id);
    assert.deepEqual(reopened.state.table, store.state.table);
    assert.equal(reopened.state.table.components?.[0]?.by, "claude");
    assert.equal(reopened.state.table.components?.[0]?.seq, 4);
    assert.equal(reopened.state.table.components?.[0]?.updatedSeq, 8);
    assert.equal(reopened.state.table.components?.[0]?.updatedBy, "Ivan");
    assert.equal(reopened.state.table.brief?.asOfSeq, 4);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("Markdown and bounded agent summaries carry the Heads-up and current component provenance", () => {
  const { table, play } = fixture();
  play(component());
  play({ op: "brief", now: "Ready for a choice", changes: ["Checks pass"], next: "Build route", refs: ["F1", "W1"], awaiting: { q: "Q1", recommendation: "P1" } });
  const md = renderTableMarkdown(table, "Room");
  assert.match(md, /## Heads-up/);
  assert.match(md, /context through 8/);
  assert.match(md, /Needs your choice: Q1 · recommends P1/);
  assert.match(md, /Sources: F1, W1/);
  assert.match(md, /\*\*W1\*\* Routes \(comparison; by claude; updated at 8\)/);
  assert.match(summarizeTable(table)!, /W1 "Routes" \(comparison/);
  play({ op: "decide", target: "P1" }, "Ivan");
  assert.match(renderTableMarkdown(table, "Room"), /Previous request \(changed since this Heads-up\)/);
  play({ op: "archive", target: "W1" });
  assert.doesNotMatch(summarizeTable(table)!, /W1 "Routes"/);
  const onlyBrief: TableState = { ...emptyTable(), brief: { now: "Thinking", by: "claude", seq: 2, asOfSeq: 1 } };
  assert.doesNotMatch(renderTableMarkdown(onlyBrief, "Room"), /table is empty/);
  assert.match(summarizeTable(onlyBrief)!, /Thinking/);
});

test("CLI keeps repeated sources/changes and exact local preview content", () => {
  assert.deepEqual(parseTableCommand("brief", ["Checking", "the", "result", "--change", "Tests pass", "--change=Review next", "--ref", "X1", "--ref=F1", "--next", "Independent review", "--awaiting", "Q1", "--recommend=P1"]), {
    op: "brief", now: "Checking the result", changes: ["Tests pass", "Review next"], next: "Independent review", refs: ["X1", "F1"], awaiting: { q: "Q1", recommendation: "P1" },
  });
  assert.deepEqual(parseTableCommand("component", ["Live", "plan", "--kind", "plan", "--ref=X1", "--ref", "P1", "--target", "W1"]), { op: "component", title: "Live plan", kind: "plan", refs: ["X1", "P1"], target: "W1" });
  assert.deepEqual(parseTableCommand("archive", ["W1"]), { op: "archive", target: "W1" });
  assert.deepEqual(parseTableCommand("restore", ["W1"]), { op: "restore", target: "W1" });
  const scratch = mkdtempSync(join(tmpdir(), "agoryx-component-cli-"));
  try {
    const path = join(scratch, "component.md");
    const body = "```html\n<button>Compare</button>\n```\n";
    writeFileSync(path, body);
    assert.deepEqual(parseTableCommand("component", ["Preview", "--kind", "custom", "--body-file", path]), { op: "component", title: "Preview", kind: "custom", refs: [], body });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("CLI rejects missing, confused and unrecognized presentation arguments", () => {
  const bad: Array<[string, string[]]> = [
    ["brief", []], ["brief", ["now", "--recommend", "P1"]], ["brief", ["now", "--change"]],
    ["brief", ["now", "--change", "--ref", "P1"]], ["brief", ["now", "--ref", "--ref", "P1"]],
    ["brief", ["now", "--surprise", "x"]], ["component", ["Title"]],
    ["component", ["Title", "--kind", "custom", "--body", "one", "--body-file", "two"]],
    ["component", ["Title", "--kind", "plan", "--target"]], ["archive", []], ["restore", ["W1", "W2"]],
  ];
  for (const [verb, argv] of bad) assert.throws(() => parseTableCommand(verb, argv), TableCommandError, `${verb} ${argv.join(" ")}`);
});

test("replay does not alias mutable brief or component event arrays", () => {
  const { table } = fixture();
  const op = prepareTableOp(table, { op: "brief", now: "Ready", changes: ["Initial"], refs: ["P1"], awaiting: { q: "Q1", recommendation: "P1" } }, "claude", false);
  applyTableOp(table, op, 8);
  assert.equal(op.op, "brief");
  if (op.op !== "brief") return;
  table.brief!.changes!.push("State-only change");
  table.brief!.refs!.push("P2");
  table.brief!.awaiting!.recommendation = "P2";
  assert.deepEqual(op.changes, ["Initial"]);
  assert.deepEqual(op.refs, ["P1"]);
  assert.equal(op.awaiting?.recommendation, "P1");
  const w: TableOp = prepareTableOp(table, component(), "claude", false);
  applyTableOp(table, w, 9);
  table.components![0]!.refs.push("X1");
  assert.equal(w.op, "component");
  if (w.op === "component") assert.deepEqual(w.refs, ["Q1", "P1", "P2"]);
});
