import test from "node:test";
import assert from "node:assert/strict";
import type { WorkflowRun } from "../../internal/agora/workflow-types.js";
import { workflowDiscussion, workflowRecord } from "../../ui/src/lib/workflow-record.js";

const run = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: "audit-run",
  roomId: "audit-room",
  mode: "debate",
  status: "completed",
  phase: "verdict",
  task: "Choose an approach",
  criteria: ["Preserve evidence"],
  participants: [{ id: "judge", kind: "codex", label: "Independent judge", role: "judge", model: "test-model", effort: "high" }],
  budget: { timeoutMs: 60000, maxOutputChars: 4000, maxRounds: 2 },
  rounds: [{ id: "verdict", phase: "verdict", status: "revealed", blind: true, entries: [{ id: "verdict-1", participantId: "judge", label: "Independent judge", status: "complete", text: "Original judge verdict" }] }],
  createdAt: "2026-10-04T00:00:00Z",
  updatedAt: "2026-10-04T00:01:00Z",
  ...overrides,
});

test("chat handoff retains human override before a long judge result and original criteria", () => {
  const draft = workflowDiscussion(run({
    override: "Choose the other option after new evidence.",
    report: { summary: "Long verdict ".repeat(3000), checks: [], unknowns: [] },
  }));
  assert.ok(draft.includes("Choose the other option after new evidence."));
  assert.ok(draft.indexOf("Human decision") < draft.indexOf("Final report"));
  assert.ok(draft.includes("Preserve evidence"));
  assert.ok(draft.includes("[Excerpt; full result remains in the session record.]"));
  assert.ok(draft.length < 21000);
});

test("tournament export and handoff retain chosen directions and combination instructions", () => {
  const value = run({
    mode: "tournament",
    selection: { entryIds: ["a", "b"], instruction: "A navigation + B layout" },
    rounds: [{ id: "prototypes", phase: "prototypes", status: "revealed", blind: true, entries: [
      { id: "a", label: "Answer B", participantId: "maker1", status: "complete", text: "Prototype 1" },
      { id: "b", label: "Answer A", participantId: "maker2", status: "complete", text: "Prototype 2" },
    ] }],
  });
  for (const text of [workflowRecord(value), workflowDiscussion(value)]) {
    assert.ok(text.includes("Human selection\nAnswer B + Answer A"));
    assert.ok(text.includes("A navigation + B layout"));
  }
});

test("export records input provenance, limits and author roles without unfinished content", () => {
  const value = run({ context: [{ path: "input.md", text: "An example: ```\nkeep it" }] });
  value.rounds.push({ id: "private", phase: "repair", status: "failed", blind: true, entries: [
    { id: "private-1", label: "Author", participantId: "author", status: "complete", text: "SEALED_PARTIAL_ARTIFACT" },
  ] });
  const record = workflowRecord(value);
  assert.ok(record.includes("Independent judge: judge; codex / test-model; effort high"));
  assert.ok(record.includes("60000 ms and 4000 returned characters"));
  assert.ok(record.includes("2 repair attempts"));
  assert.ok(record.includes("### input.md\n````\nAn example: ```\nkeep it\n````"));
  assert.ok(record.includes("Original judge verdict"));
  assert.ok(!record.includes("SEALED_PARTIAL_ARTIFACT"));
  assert.ok(!workflowDiscussion(value).includes("SEALED_PARTIAL_ARTIFACT"));
});

test("report preserves evidence and unknowns alongside the unchanged human decision", () => {
  const value = run({
    override: "Wait for the external check.",
    report: { summary: "Two judges disagree.", checks: [{ criterion: "Preserve evidence", status: "unknown", evidence: "Judge A inspected; Judge B could not execute." }], unknowns: ["Measure on the target device."] },
  });
  for (const text of [workflowRecord(value), workflowDiscussion(value)]) {
    assert.ok(text.includes("Two judges disagree."));
    assert.ok(text.includes("unknown — Preserve evidence"));
    assert.ok(text.includes("Judge A inspected; Judge B could not execute."));
    assert.ok(text.includes("Measure on the target device."));
    assert.ok(text.includes("Wait for the external check."));
  }
});

test("a long synthesis never truncates criterion failures or substantial dissent", () => {
  const draft = workflowDiscussion(run({
    mode: "council",
    report: {
      summary: "Long synthesis ".repeat(2500),
      checks: [{ criterion: "Preserve evidence", status: "failed", evidence: "The minority's test contradicts the claimed result." }],
      unknowns: ["CRITICAL_DISAGREEMENT: the minority rejects the unsupported causal claim."],
    },
  }));
  assert.ok(draft.includes("failed — Preserve evidence"));
  assert.ok(draft.includes("The minority's test contradicts the claimed result."));
  assert.ok(draft.includes("CRITICAL_DISAGREEMENT: the minority rejects the unsupported causal claim."));
  assert.ok(draft.indexOf("CRITICAL_DISAGREEMENT") < draft.indexOf("Long synthesis"));
  assert.ok(draft.includes("[Excerpt; full result remains in the session record.]"));
});

test("Verification discussion includes the latest revealed artifact, report and unknowns, excluding sealed repairs", () => {
  const value = run({
    mode: "verification",
    rounds: [
      { id: "creation", phase: "creation", status: "revealed", blind: true, entries: [{ id: "a", label: "Author", participantId: "author", status: "complete", text: "OUTDATED_ARTIFACT" }] },
      { id: "repair", phase: "repair", status: "revealed", blind: true, entries: [{ id: "b", label: "Author", participantId: "author", status: "complete", text: "```js\nfunction answer() { return 42; }\n```" }] },
      { id: "review", phase: "review", status: "revealed", blind: true, entries: [{ id: "c", label: "Reviewer", participantId: "reviewer", status: "complete", text: "Reviewed the repaired function" }] },
      { id: "private", phase: "repair", status: "failed", blind: true, entries: [{ id: "d", label: "Author", participantId: "author", status: "complete", text: "SEALED_REPAIR" }] },
    ],
    report: { summary: "The repaired function passes inspection.", checks: [{ criterion: "Returns 42", status: "passed", evidence: "Inspected the return value." }], unknowns: ["Not executed."] },
  });
  const draft = workflowDiscussion(value);
  assert.ok(draft.includes("function answer() { return 42; }"));
  assert.ok(draft.includes("The repaired function passes inspection."));
  assert.ok(draft.includes("Inspected the return value."));
  assert.ok(draft.includes("Not executed."));
  assert.ok(!draft.includes("OUTDATED_ARTIFACT"));
  assert.ok(!draft.includes("SEALED_REPAIR"));
  const creationOnly = workflowDiscussion({ ...value, rounds: value.rounds.slice(0, 1) });
  assert.ok(creationOnly.includes("OUTDATED_ARTIFACT"));
});

test("large Verification artifacts and reports retain separate excerpts alongside evidence", () => {
  const artifact = "AUTHORED_CODE\n" + "x".repeat(19990);
  for (const summary of ["Final conclusion: needs a browser check.", "Final conclusion: " + "long report ".repeat(2500)]) {
    const draft = workflowDiscussion(run({
      mode: "verification",
      rounds: [{ id: "creation", phase: "creation", status: "revealed", blind: true, entries: [{ id: "a", label: "Author", participantId: "author", status: "complete", text: artifact }] }],
      report: { summary, checks: [{ criterion: "Preserve evidence", status: "unknown", evidence: "Inspected only." }], unknowns: ["Browser execution remains unknown."] },
    }));
    assert.ok(draft.includes("## Final report\nFinal conclusion:"));
    if (summary.length < 10000) assert.ok(draft.includes(summary), "the short report must survive in full");
    assert.ok(draft.includes("## Latest artifact\nAuthor:\nAUTHORED_CODE"));
    assert.ok(draft.includes("Inspected only."));
    assert.ok(draft.includes("Browser execution remains unknown."));
    assert.ok(draft.includes("[Excerpt; full result remains in the session record.]"));
    assert.ok(draft.length < 21000);
  }
});
