import test from "node:test";
import assert from "node:assert/strict";
import type { WorkflowRound, WorkflowRun } from "../../internal/agora/workflow-types.js";
import { councilStandings, criteriaGrid, debateDigest, headline, leadClaims, tournamentStandings } from "../../ui/src/lib/workflow-digest.js";

const round = (id: string, phase: string, entries: Array<[string, unknown]>, status: WorkflowRound["status"] = "revealed", aliases?: Record<string, string>): WorkflowRound => ({
  id,
  phase,
  status,
  blind: true,
  entries: entries.map(([participantId, body], i) => ({ id: `${id}-${i + 1}`, participantId, label: participantId, status: "complete", ...(status === "revealed" ? { text: typeof body === "string" ? body : JSON.stringify(body) } : {}) })),
  ...(aliases ? { aliases } : {}),
});

const base = (mode: WorkflowRun["mode"], rounds: WorkflowRound[], extra: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: "run",
  roomId: "room",
  mode,
  status: "completed",
  phase: rounds.at(-1)?.phase ?? "",
  task: "Should we rewrite the sync engine?",
  criteria: ["Correctness", "Cost"],
  participants: [
    { id: "codex", kind: "codex", label: "Codex", role: mode === "debate" ? "con" : undefined },
    { id: "claude", kind: "claude", label: "Claude", role: mode === "debate" ? "pro" : undefined },
    { id: "judge", kind: "codex", label: "Judge", role: mode === "debate" ? "judge" : undefined },
  ],
  budget: { timeoutMs: 1000, maxOutputChars: 5000, maxRounds: 2 },
  rounds,
  createdAt: "2026-10-06T00:00:00.000Z",
  updatedAt: "2026-10-06T00:00:00.000Z",
  ...extra,
});

test("a headline is the author's first sentence without markdown, cut at a word", () => {
  assert.equal(headline("**Rewrite it.** The old engine has no tests."), "Rewrite it.");
  assert.equal(headline("## Plan\n- keep the `api` stable and [ship](http://x) it"), "Plan keep the api stable and ship it");
  assert.equal(headline("word ".repeat(60), 40).length <= 40, true);
  assert.match(headline("word ".repeat(60), 40), /…$/);
});

test("lead claims are the first ```viz claims block of a free-text answer", () => {
  const text = 'Intro\n\n```viz\n{"kind":"stats","items":[{"label":"a","value":"1"}]}\n```\n\n```viz\n{"kind":"claims","claims":[{"text":"Patch first","confidence":0.7}]}\n```\nMore prose.';
  assert.deepEqual(leadClaims(text), [{ text: "Patch first", confidence: 0.7 }]);
  assert.equal(leadClaims("No visuals here."), null);
  assert.equal(leadClaims('```viz\n{"kind":"claims","claims":[]}\n```'), null, "a block that does not parse is not a summary");
});

const debate = (extra: Partial<WorkflowRun> = {}) =>
  base(
    "debate",
    [
      round("openings", "openings", [
        ["claude", { position: "Rewrite the sync engine", confidence: 0.7, arguments: [{ id: "pro-1", headline: "The engine has no tests", text: "No tests cover conflict resolution; every fix risks regressions." }, { id: "pro-2", text: "The protocol changed twice. A rewrite fits the new one." }] }],
        ["codex", { position: "Patch the engine instead", confidence: 0.65, arguments: [{ id: "con-1", text: "A rewrite costs a quarter. Patching costs two weeks." }] }],
      ]),
      round("steelman-0", "steelman", [["claude", "You say patching is cheaper."], ["codex", "You say tests are missing."]]),
      round("acceptance-0", "acceptance", [["claude", { accepted: false, corrections: "Missing the protocol point" }], ["codex", { accepted: true, corrections: "none" }]]),
      round("steelman-1", "steelman_repair", [["claude", "Better."], ["codex", "Better."]]),
      round("acceptance-1", "acceptance", [["claude", { accepted: true, corrections: "none" }], ["codex", { accepted: true, corrections: "none" }]]),
      round("new-arguments", "new_arguments", [
        ["claude", { position: "Rewrite, behind a flag", confidence: 0.6, arguments: [{ id: "pro-new-1", text: "A flag lets both engines run side by side." }] }],
        ["codex", { position: "Patch the engine instead", arguments: [{ id: "con-new-1", headline: "Most bugs sit in one module", text: "80% of sync bugs come from merge.ts." }] }],
      ]),
      round("rebuttal", "rebuttal", [
        ["claude", { rebuttal: "…", concessions: [{ argumentId: "con-new-1", reason: "The bug data is new to me." }], remainingDisagreement: "Whether merge.ts can be fixed in isolation", decisiveTest: "Fix merge.ts for two weeks and count new bugs", confidence: 0.45 }],
        ["codex", { rebuttal: "…", concessions: [], remainingDisagreement: "The cost of a rewrite", decisiveTest: "Estimate the rewrite in a spike", confidence: "high" }],
      ]),
      round("verdict", "verdict", [["judge", { summary: "Patch first. The bug data is decisive for now. More detail follows.", checks: [{ criterion: "Correctness", status: "passed", evidence: "e" }, { criterion: "Cost", status: "unknown", evidence: "e" }], unknowns: [], leaning: { side: "con", confidence: 0.7 } }]]),
    ],
    extra,
  );

test("the debate map: sides in order, headlines, concessions on the conceded argument, confidence over time, the crux", () => {
  const digest = debateDigest(debate())!;
  assert.deepEqual(digest.sides.map((s) => [s.role, s.label]), [["pro", "Claude"], ["con", "Codex"]], "for comes first whatever the roster order");
  const [pro, con] = digest.sides;
  assert.equal(pro!.position, "Rewrite the sync engine");
  assert.equal(pro!.positionNow, "Rewrite, behind a flag");
  assert.equal(con!.positionNow, undefined, "an unchanged position is not shown twice");
  assert.deepEqual(pro!.arguments.map((a) => [a.id, a.stage, a.headline]), [
    ["pro-1", "opening", "The engine has no tests"],
    ["pro-2", "opening", "The protocol changed twice."],
    ["pro-new-1", "new", "A flag lets both engines run side by side."],
  ]);
  const conceded = con!.arguments.find((a) => a.id === "con-new-1")!;
  assert.deepEqual(conceded.conceded, { by: "Claude", reason: "The bug data is new to me." });
  assert.equal(pro!.concessionsMade, 1);
  assert.deepEqual(pro!.confidence, [{ phase: "openings", value: 0.7 }, { phase: "new_arguments", value: 0.6 }, { phase: "rebuttal", value: 0.45 }]);
  assert.deepEqual(con!.confidence, [{ phase: "openings", value: 0.65 }], "a malformed confidence is left out, not shown");
  assert.deepEqual(pro!.acceptance, [false, true]);
  assert.equal(digest.gate, "passed");
  assert.equal(pro!.decisiveTest, "Fix merge.ts for two weeks and count new bugs");
  assert.deepEqual(digest.judges, [{ label: "Judge", leaning: { side: "con", confidence: 0.7 }, counts: { passed: 1, failed: 0, unknown: 1 }, summary: "Patch first." }]);
});

test("the debate map never reads a sealed round and reports a failed gate", () => {
  const sealed = debate();
  sealed.rounds = sealed.rounds.map((r) => (r.phase === "rebuttal" ? { ...r, status: "running", entries: r.entries.map(({ text: _text, ...e }) => e) } : r));
  const digest = debateDigest(sealed)!;
  assert.equal(digest.sides[0]!.remainingDisagreement, undefined);
  assert.equal(digest.sides[1]!.arguments.find((a) => a.id === "con-new-1")!.conceded, undefined);
  const unopened = debate();
  unopened.rounds = [{ ...unopened.rounds[0]!, status: "running" }];
  assert.equal(debateDigest(unopened), null, "nothing to map before the openings are revealed");
  const failed = debate({ phase: "disagreement" });
  failed.rounds = failed.rounds.filter((r) => !["new_arguments", "rebuttal"].includes(r.phase));
  assert.equal(debateDigest(failed)!.gate, "failed");
});

test("council standings: Borda points from anonymous rankings, by alias only, the lead claims kept", () => {
  const answers = round(
    "answers",
    "answers",
    [
      ["codex", '```viz\n{"kind":"claims","claims":[{"text":"Patch merge.ts first"}]}\n```\nBecause…'],
      ["claude", "Rewrite. The engine is untestable."],
      ["judge", "Wait for data."],
    ],
    "revealed",
    { "answers-1": "Answer B", "answers-2": "Answer A", "answers-3": "Answer C" },
  );
  const reviews = round("peer-review", "peer_review", [
    ["codex", { ranking: ["Answer C", "Answer A"], feedback: "f" }],
    ["claude", { ranking: ["Answer B", "Answer C"], feedback: "f" }],
    ["judge", { ranking: ["Answer B", "Answer A"], feedback: "f" }],
  ]);
  const rows = councilStandings(base("council", [answers, reviews]));
  assert.deepEqual(rows.map((r) => [r.alias, r.points, r.possible, r.firsts]), [
    ["Answer B", 2, 2, 2],
    ["Answer C", 1, 2, 1],
    ["Answer A", 0, 2, 0],
  ]);
  assert.equal(JSON.stringify(rows).includes("Codex"), false, "the digest names no author");
  assert.equal(rows[0]!.claims?.[0]?.text, "Patch merge.ts first");
  assert.equal(rows[1]!.headline, "Wait for data.");
  assert.deepEqual(councilStandings(base("council", [answers])).map((r) => r.points), [0, 0, 0], "before review, one line each and no points");
  assert.deepEqual(tournamentStandings(base("council", [answers, reviews])), [], "each digest reads its own mode");
});

test("the criteria grid: one column per review, one row per criterion, status or a gap", () => {
  const review = (status: string) => ({ summary: "s", checks: [{ criterion: "Correctness", status, evidence: "e" }], unknowns: [] });
  const run = base("verification", [round("creation", "creation", [["codex", "artifact"]]), round("review-0", "review", [["claude", review("failed")], ["judge", review("unknown")]]), round("repair-1", "repair", [["codex", "fixed"]]), round("review-1", "recheck", [["claude", review("passed")], ["judge", review("passed")]])]);
  const grid = criteriaGrid(run)!;
  assert.deepEqual(grid.criteria, ["Correctness", "Cost"]);
  assert.deepEqual(grid.columns.map((c) => [c.label, c.attempt, c.statuses]), [
    ["Claude", 1, ["failed", null]],
    ["Judge", 1, ["unknown", null]],
    ["Claude", 2, ["passed", null]],
    ["Judge", 2, ["passed", null]],
  ]);
  assert.equal(criteriaGrid(base("council", [])), null);
});

test("review fixes: an uppercase JSON fence still maps; a failed gate reads failed before the run says so, and drops a leaning", () => {
  const upper = debate();
  upper.rounds[0] = { ...upper.rounds[0]!, entries: upper.rounds[0]!.entries.map((e) => ({ ...e, text: "```JSON\n" + e.text + "\n```" })) };
  assert.equal(debateDigest(upper)!.sides[0]!.arguments.length, 3);

  const failing = debate({ phase: "verdict", status: "running" });
  failing.rounds = failing.rounds.filter((r) => !["new_arguments", "rebuttal"].includes(r.phase));
  const rejected = { accepted: false, corrections: "You left out the protocol point" };
  failing.rounds = failing.rounds.map((r) => (r.id === "acceptance-1" ? round("acceptance-1", "acceptance", [["claude", rejected], ["codex", { accepted: true, corrections: "none" }]]) : r));
  const digest = debateDigest(failing)!;
  assert.equal(digest.gate, "failed", "the verdict runs with no new arguments before it");
  assert.equal(digest.judges[0]!.leaning, undefined, "no winner to lean towards");
  assert.equal(digest.sides[0]!.corrections, "You left out the protocol point");

  const exhausted = debate({ phase: "acceptance", status: "failed" });
  exhausted.budget = { ...exhausted.budget, maxRounds: 1 };
  exhausted.rounds = exhausted.rounds.filter((r) => r.phase !== "verdict" && r.phase !== "new_arguments" && r.phase !== "rebuttal").map((r) => (r.id === "acceptance-1" ? round("acceptance-1", "acceptance", [["claude", rejected], ["codex", { accepted: true, corrections: "none" }]]) : r));
  assert.equal(debateDigest(exhausted)!.gate, "failed", "rejected after the last permitted repair");

  assert.equal(debateDigest(debate())!.sides[0]!.rebuttal, "…", "the rebuttal travels as one line");
});
