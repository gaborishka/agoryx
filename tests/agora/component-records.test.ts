import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTableOp, emptyTable, prepareTableOp } from "../../internal/agora/table.js";
import { componentRecords, componentWindow, optionStanding } from "../../ui/src/lib/component-records.js";

const fixture = () => {
  const table = emptyTable();
  let seq = 0;
  const play = (raw: unknown, by = "claude") => {
    const human = by === "Ivan";
    const op = prepareTableOp(table, raw, by, human);
    applyTableOp(table, op, ++seq, { human });
    return op;
  };
  return { table, play };
};

test("native checks keep explicit evidence beside steps and every related finding without duplicates", () => {
  const { table, play } = fixture();
  play({ op: "propose", title: "Implementation" });
  play({ op: "next", text: "Check browser behavior", target: "P1" });
  play({ op: "review", target: "X1" });
  play({ op: "object", target: "X1", text: "Keyboard navigation fails" }, "codex");
  play({ op: "object", target: "X1", text: "Focus is lost after reconnect" }, "codex");
  play({ op: "support", target: "X1", text: "Mobile layout passes" }, "codex");
  play({ op: "evidence", target: "P1", text: "Independent browser recording", source: "recording.webm" }, "codex");
  const records = componentRecords(table, ["X1", "N1", "N4"]);
  assert.deepEqual(records.steps.map(step => step.id), ["X1"]);
  assert.deepEqual(records.notes.map(note => note.id), ["N1", "N2", "N3", "N4"]);
  assert.deepEqual(records.notes.map(note => note.kind), ["object", "object", "support", "evidence"]);
  assert.equal(records.notes.at(-1)?.source, "recording.webm");
  const visible = componentWindow(records, "checks", false);
  assert.equal(visible.steps.length, 1);
  assert.equal(visible.notes.length, 4, "steps must not suppress explicitly referenced notes");
  assert.equal(visible.omitted, 0);
});

test("native plans include route-linked tasks and their review evidence with the actual checker", () => {
  const { table, play } = fixture();
  play({ op: "propose", title: "Implementation" });
  play({ op: "next", text: "Build the implementation", target: "P1" });
  play({ op: "next", text: "Check the implementation", target: "P1" });
  play({ op: "review", target: "X1" });
  play({ op: "support", target: "X1", text: "Verified independently" }, "codex");
  play({ op: "done", target: "X1" }, "Ivan");
  const records = componentRecords(table, ["P1", "X1"]);
  assert.deepEqual(records.steps.map(step => step.id), ["X1", "X2"]);
  assert.deepEqual(records.notes.map(note => note.id), ["N1"]);
  assert.equal(records.steps[0]?.by, "claude");
  assert.equal(records.steps[0]?.review, "claude");
  assert.equal(records.steps[0]?.checkedBy, "Ivan");
  assert.equal(records.steps[0]?.doneBy, "Ivan");
});

test("initial native check limits disclose omitted records and expansion reveals all referenced data", () => {
  const { table, play } = fixture();
  for (let i = 1; i <= 9; i++) play({ op: "next", text: `Step ${i}` });
  for (let i = 1; i <= 7; i++) play({ op: "evidence", target: "X9", text: `Evidence ${i}` }, "codex");
  for (let i = 1; i <= 6; i++) play({ op: "fact", text: `Fact ${i}` });
  const refs = [...table.next.map(step => step.id), ...table.facts.map(fact => fact.id)];
  assert.doesNotThrow(() => prepareTableOp(table, { op: "component", title: "Full review", kind: "checks", refs }, "claude", false));
  const before = structuredClone(table);
  const records = componentRecords(table, refs);
  const compact = componentWindow(records, "checks", false);
  assert.deepEqual([compact.steps.length, compact.notes.length, compact.claims.length], [8, 5, 5]);
  assert.equal(compact.omitted, 4);
  const expanded = componentWindow(records, "checks", true);
  assert.deepEqual([expanded.steps.length, expanded.notes.length, expanded.claims.length], [9, 7, 6]);
  assert.equal(expanded.steps.at(-1)?.id, "X9");
  assert.equal(expanded.notes.at(-1)?.text, "Evidence 7");
  assert.equal(expanded.claims.at(-1)?.text, "Fact 6");
  assert.equal(expanded.omitted, 0);
  assert.deepEqual(table, before, "view expansion does not mutate shared records");
});

test("question comparisons disclose all proposals and artifact expansion preserves withdrawn records", () => {
  const { table, play } = fixture();
  play({ op: "ask", text: "Which design?" });
  for (let i = 1; i <= 7; i++) play({ op: "propose", title: `Design ${i}`, q: "Q1", body: `Preview ${i}` });
  play({ op: "withdraw", target: "P7" });
  const records = componentRecords(table, ["Q1", "P1"]);
  assert.equal(records.options.length, 7, "overlapping question and proposal refs do not duplicate proposals");
  assert.equal(componentWindow(records, "comparison", false).omitted, 1);
  assert.equal(componentWindow(records, "comparison", true).options.at(-1)?.status, "withdrawn");
  assert.equal(componentWindow(records, "artifact", false).omitted, 4);
  assert.equal(componentWindow(records, "artifact", true).options.at(-1)?.body, "Preview 7");
  assert.deepEqual(optionStanding(table, records.options.at(-1)!), { label: "Withdrawn", canChoose: false });
});

test("native option controls distinguish not chosen and answered questions from available choices", () => {
  const { table, play } = fixture();
  play({ op: "ask", text: "Which route?" });
  play({ op: "propose", title: "Chosen route", q: "Q1" });
  play({ op: "propose", title: "Other route", q: "Q1" });
  play({ op: "decide", target: "P1" }, "Ivan");
  assert.deepEqual(optionStanding(table, table.options[0]!), { label: "Chosen", canChoose: false });
  assert.deepEqual(optionStanding(table, table.options[1]!), { label: "Not chosen", canChoose: false });
  play({ op: "reopen", target: "Q1" }, "Ivan");
  assert.deepEqual(optionStanding(table, table.options[1]!), { label: "Open option", canChoose: true });
  play({ op: "settle", text: "Resolved without a proposal", q: "Q1" });
  assert.deepEqual(optionStanding(table, table.options[1]!), { label: "Question closed", canChoose: false });
});
