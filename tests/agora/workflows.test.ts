import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowService } from "../../internal/agora/workflows.js";
import type { WorkflowExecutionInput, WorkflowMode, WorkflowParticipant, WorkflowStartInput } from "../../internal/agora/workflow-types.js";

const directories: string[] = [];
const services: WorkflowService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.dispose(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const participants: WorkflowParticipant[] = [
  { id: "codex", kind: "codex", label: "Codex" },
  { id: "claude", kind: "claude", label: "Claude" },
  { id: "judge", kind: "codex", label: "Judge", model: "other" },
];
const setup = (mode: WorkflowMode, count = 2): WorkflowStartInput => ({ mode, task: "Produce an accurate self-contained artifact", criteria: ["Correctness"], participants: participants.slice(0, count), budget: { maxRounds: 2, maxOutputChars: 5000, timeoutMs: 10_000 } });
const report = (status = "passed") => JSON.stringify({ summary: "Checked against the task", checks: [{ criterion: "Correctness", status, evidence: "Inspected the complete returned artifact; no execution claim" }], unknowns: ["Not executed in the shared workspace"] });
const peerAliases = (prompt: string) => [...prompt.matchAll(/^(Answer [A-H]):$/gm)].map((match) => match[1]);
const defaultAnswer = (input: WorkflowExecutionInput): string => {
  switch (input.phase) {
    case "review": case "recheck": case "verdict": return report();
    case "peer_review": return input.prompt.includes("With two members") ? JSON.stringify({ critique: "A substantive peer critique" }) : JSON.stringify({ ranking: peerAliases(input.prompt), feedback: "Ranked by the stated criterion" });
    case "dissent_audit": return JSON.stringify({ summary: "All differences preserved", missingDisagreements: [], unknowns: [] });
    case "evaluation": return JSON.stringify({ ranking: peerAliases(input.prompt), feedback: "Independent prototype comparison" });
    case "openings": return JSON.stringify({ position: `${input.participant.role} stance`, arguments: [{ id: `${input.participant.role}-1`, text: `Initial ${input.participant.role} argument` }] });
    case "new_arguments": return JSON.stringify({ position: `${input.participant.role} stance`, arguments: [{ id: `${input.participant.role}-new-1`, text: `New ${input.participant.role} evidence` }] });
    case "acceptance": return JSON.stringify({ accepted: true, corrections: "none" });
    case "rebuttal": return JSON.stringify({ rebuttal: "A reasoned response", concessions: [], remainingDisagreement: "Measurement", decisiveTest: "Run the controlled comparison" });
    default: return `${input.phase} artifact by ${input.participant.id}`;
  }
};
const fixture = (answer: (input: WorkflowExecutionInput) => string | Promise<string> = defaultAnswer, cleanupGraceMs = 10) => {
  const stateDir = mkdtempSync(join(tmpdir(), "agoryx-workflow-"));
  directories.push(stateDir);
  const calls: WorkflowExecutionInput[] = [];
  const service = new WorkflowService({ stateDir, cleanupGraceMs, execute: async (input) => { calls.push(input); return { text: await answer(input) }; } });
  services.push(service);
  return { stateDir, service, calls };
};
const until = async (predicate: () => boolean) => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 2)); } assert.fail("Expected asynchronous phase was not reached"); };

test("blind answers execute in parallel and reveal only as an atomic complete batch", async () => {
  let release!: (text: string) => void;
  const gate = new Promise<string>((resolve) => { release = resolve; });
  const { service, calls, stateDir } = fixture((input) => input.phase === "answers" ? input.participant.id === "codex" ? "SEALED SECRET A" : gate : defaultAnswer(input));
  service.start("room", setup("council"));
  await until(() => calls.length === 2 && service.get("room")!.rounds[0]!.entries[0]!.status === "complete");
  assert.equal(service.get("room")!.rounds[0]!.entries.every((entry) => entry.text === undefined), true);
  assert.deepEqual(service.summary("room")!.working.map((entry) => entry.agent), ["claude"]);
  assert.deepEqual(Object.keys(service.summary("room")!).sort(), ["id", "mode", "phase", "status", "updatedAt", "working"]);
  assert.equal(JSON.stringify(service.summary("room")).includes("SEALED SECRET A"), false);
  assert.equal(JSON.stringify(service.history("room")).includes("SEALED SECRET A"), false);
  assert.match(readFileSync(join(stateDir, "room/workflow/state.json"), "utf8"), /SEALED SECRET A/);
  assert.equal(calls[1]!.prompt.includes("SEALED SECRET A"), false);
  release("SEALED SECRET B");
  await service.wait("room");
  const run = service.get("room")!;
  assert.equal(run.status, "completed");
  assert.equal(run.rounds[0]!.status, "revealed");
  assert.deepEqual(run.rounds[0]!.entries.map((e) => e.text), ["SEALED SECRET A", "SEALED SECRET B"]);
  assert.deepEqual(service.summary("room")!.working, []);
  assert.equal(service.summary("unknown-room"), null);
});

test("verification returns findings to original author and rechecks the repaired full artifact", async () => {
  const { service, calls } = fixture((input) => input.phase === "review" ? report("failed") : defaultAnswer(input));
  service.start("room", setup("verification"));
  await service.wait("room");
  assert.deepEqual(calls.map((c) => c.phase), ["creation", "review", "repair", "recheck"]);
  assert.equal(calls[0]!.participant.id, calls[2]!.participant.id);
  assert.notEqual(calls[1]!.participant.id, calls[2]!.participant.id);
  assert.match(calls[2]!.prompt, /"status":"failed"/);
  assert.match(calls[3]!.prompt, /repair artifact by codex/);
  assert.equal(service.get("room")!.report!.checks[0]!.status, "passed");
  assert.match(service.get("room")!.report!.unknowns[0]!, /Not executed/);
});

test("verification requires every criterion exactly once and does not publish invalid reviews", async () => {
  const { service } = fixture((input) => input.phase === "review" ? JSON.stringify({ summary: "Trust me", checks: [], unknowns: [] }) : defaultAnswer(input));
  service.start("room", setup("verification"));
  await service.wait("room");
  const run = service.get("room")!;
  assert.equal(run.status, "failed");
  assert.match(run.error!, /every original criterion/);
  assert.equal(run.rounds[1]!.entries[0]!.text, undefined);
  assert.equal(run.report, undefined);
});

test("verification repair budget terminates with explicit unresolved criteria", async () => {
  const { service, calls } = fixture((input) => ["review", "recheck"].includes(input.phase) ? report("failed") : defaultAnswer(input));
  service.start("room", { ...setup("verification"), budget: { maxRounds: 1 } });
  await service.wait("room");
  assert.equal(calls.filter((c) => c.phase === "repair").length, 1);
  assert.equal(service.get("room")!.report!.checks[0]!.status, "failed");
  assert.match(service.get("room")!.report!.unknowns.at(-1)!, /exhausted/);
});

test("council anonymizes peers, excludes self, and assigns dissent audit to a different member", async () => {
  const { service, calls } = fixture();
  service.start("room", setup("council", 3));
  await service.wait("room");
  const reviews = calls.filter((c) => c.phase === "peer_review");
  assert.equal(reviews.length, 3);
  for (const request of reviews) {
    assert.equal(peerAliases(request.prompt).length, 2);
    assert.equal(request.prompt.includes(`answers artifact by ${request.participant.id}`), false);
  }
  assert.notEqual(calls.find((c) => c.phase === "synthesis")!.participant.id, calls.find((c) => c.phase === "dissent_audit")!.participant.id);
  assert.equal(service.get("room")!.status, "completed");
});

test("two-member council critiques reciprocally without manufacturing a ranking", async () => {
  const { service, calls } = fixture();
  service.start("room", setup("council"));
  await service.wait("room");
  for (const request of calls.filter((c) => c.phase === "peer_review")) {
    assert.match(request.prompt, /do not manufacture a ranking/);
    assert.equal(peerAliases(request.prompt).length, 1);
  }
});

test("council rejects self/nonpeer rankings and duplicate rankings", async () => {
  const { service, calls } = fixture((input) => input.phase === "peer_review" ? JSON.stringify({ ranking: ["Answer A", "Answer A"], feedback: "bad ranking" }) : defaultAnswer(input));
  service.start("room", setup("council", 3));
  await service.wait("room");
  assert.equal(service.get("room")!.status, "failed");
  assert.equal(calls.some((c) => c.phase === "synthesis"), false);
  assert.equal(service.get("room")!.rounds[1]!.entries.every((e) => e.text === undefined), true);
});

test("anonymous aliases cannot be disabled by a participant labelled Answer A", async () => {
  const { service, calls } = fixture();
  const input = setup("council", 3);
  input.participants = input.participants.map((participant, i) => ({ ...participant, label: i === 0 ? "Answer A" : `Private provider label ${i}` }));
  service.start("room", input);
  await service.wait("room");
  const run = service.get("room")!;
  assert.equal(run.status, "completed");
  assert.deepEqual(Object.values(run.rounds[0]!.aliases!).sort(), ["Answer A", "Answer B", "Answer C"]);
  for (const request of calls.filter((c) => c.phase === "peer_review")) {
    assert.equal(peerAliases(request.prompt).length, 2);
    assert.equal(request.prompt.includes("Private provider label"), false);
  }
});

test("tournament has equal budgets, independent evaluator, and a hard human implementation gate", async () => {
  const { service, calls } = fixture();
  const started = service.start("room", setup("tournament", 3));
  await service.wait("room");
  let run = service.get("room")!;
  assert.equal(run.status, "waiting_user");
  assert.equal(run.phase, "selection");
  assert.equal(calls.some((c) => c.phase === "implementation"), false);
  const makers = calls.filter((c) => c.phase === "prototypes");
  const judges = calls.filter((c) => c.phase === "evaluation");
  assert.deepEqual(makers[0]!.budget, makers[1]!.budget);
  assert.equal(makers.some((m) => judges.some((j) => j.participant.id === m.participant.id)), false);
  assert.throws(() => service.act("room", { type: "select", runId: "stale", entryIds: [run.rounds[0]!.entries[0]!.id] }), /changed/);
  assert.throws(() => service.act("room", { type: "select", runId: started.id, entryIds: ["invalid"] }), /revealed prototypes/);
  service.act("room", { type: "select", runId: started.id, entryIds: run.rounds[0]!.entries.map((e) => e.id), instruction: "Combine both approaches" });
  await service.wait("room");
  run = service.get("room")!;
  assert.equal(run.status, "completed");
  assert.match(calls.at(-1)!.prompt, /Combine both approaches/);
  assert.equal(calls.filter((c) => c.phase === "prototypes").length, 2);
});

test("debate repairs unaccepted steelmen before rebuttal and uses an independent judge", async () => {
  let acceptanceCalls = 0;
  const { service, calls } = fixture((input) => input.phase === "acceptance" ? JSON.stringify({ accepted: ++acceptanceCalls > 2, corrections: "Clarify the causal claim" }) : defaultAnswer(input));
  const started = service.start("room", setup("debate", 3));
  await service.wait("room");
  const phases = calls.map((c) => c.phase);
  assert.equal(phases.filter((phase) => phase === "steelman_repair").length, 2);
  assert.ok(phases.indexOf("rebuttal") > phases.lastIndexOf("acceptance"));
  assert.ok(phases.indexOf("new_arguments") > phases.lastIndexOf("acceptance"));
  assert.equal(calls.find((c) => c.phase === "verdict")!.participant.id, "judge");
  const original = service.get("room")!.report!.summary;
  service.act("room", { type: "override", runId: started.id, text: "Wait for the experiment" });
  assert.equal(service.get("room")!.override, "Wait for the experiment");
  assert.equal(service.get("room")!.report!.summary, original);
});

test("debate cannot bypass rejected steelmen even when repair budget is exhausted", async () => {
  const { service, calls } = fixture((input) => input.phase === "acceptance" ? JSON.stringify({ accepted: false, corrections: "This still misstates my claim" }) : defaultAnswer(input));
  service.start("room", { ...setup("debate", 3), budget: { maxRounds: 1 } });
  await service.wait("room");
  assert.equal(calls.some((c) => c.phase === "rebuttal" || c.phase === "new_arguments"), false);
  assert.equal(calls.filter((c) => c.phase === "steelman").length, 2);
  assert.equal(calls.filter((c) => c.phase === "steelman_repair").length, 2, "one repair attempt follows the initial two steelmen");
  assert.equal(calls.filter((c) => c.phase === "acceptance").length, 4);
  assert.equal(service.get("room")!.phase, "disagreement");
  assert.match(service.get("room")!.report!.unknowns.at(-1)!, /no rebuttal/);
});

test("debate permits honest absence of new arguments and still reaches rebuttal and verdict", async () => {
  const { service, calls } = fixture((input) => input.phase === "new_arguments" ? JSON.stringify({ position: "The opening remains my strongest case; I have no new evidence", arguments: [] }) : defaultAnswer(input));
  service.start("room", setup("debate", 3));
  await service.wait("room");
  const run = service.get("room")!;
  assert.equal(run.status, "completed");
  assert.equal(calls.filter((call) => call.phase === "rebuttal").length, 2);
  assert.equal(calls.filter((call) => call.phase === "verdict").length, 1);
  for (const entry of run.rounds.find((round) => round.phase === "rebuttal")!.entries) {
    assert.deepEqual(JSON.parse(entry.text!).concessions, []);
  }
});

test("absence of new opponent arguments never permits a fabricated concession reference", async () => {
  const { service, calls } = fixture((input) => {
    if (input.phase === "new_arguments") return JSON.stringify({ position: "No new argument", arguments: [] });
    if (input.phase === "rebuttal") return JSON.stringify({ rebuttal: "I concede", concessions: [{ argumentId: `${input.participant.role === "pro" ? "con" : "pro"}-new-1`, reason: "Invented evidence" }], remainingDisagreement: "none", decisiveTest: "none" });
    return defaultAnswer(input);
  });
  service.start("room", setup("debate", 3));
  await service.wait("room");
  assert.equal(service.get("room")!.status, "failed");
  assert.match(service.get("room")!.error!, /distinct new opponent argument/);
  assert.equal(calls.some((call) => call.phase === "verdict"), false);
});

test("a participant with no new argument may concede to genuine new opponent evidence", async () => {
  const { service } = fixture((input) => {
    if (input.phase === "new_arguments" && input.participant.role === "pro") return JSON.stringify({ position: "No new argument of my own", arguments: [] });
    if (input.phase === "rebuttal" && input.participant.role === "pro") return JSON.stringify({ rebuttal: "The new evidence changes this part of my assessment", concessions: [{ argumentId: "con-new-1", reason: "The newly measured result contradicts my assumption" }], remainingDisagreement: "Measurement scope", decisiveTest: "Repeat under the other condition" });
    return defaultAnswer(input);
  });
  service.start("room", setup("debate", 3));
  await service.wait("room");
  const run = service.get("room")!;
  assert.equal(run.status, "completed");
  const rebuttals = run.rounds.find((round) => round.phase === "rebuttal")!;
  assert.equal(JSON.parse(rebuttals.entries[0]!.text!).concessions[0].argumentId, "con-new-1");
  assert.deepEqual(JSON.parse(rebuttals.entries[1]!.text!).concessions, []);
});

test("debate still requires an actual argument in each opening", async () => {
  const { service, calls } = fixture((input) => input.phase === "openings" ? JSON.stringify({ position: "A stance without support", arguments: [] }) : defaultAnswer(input));
  service.start("room", setup("debate", 3));
  await service.wait("room");
  assert.equal(service.get("room")!.status, "failed");
  assert.match(service.get("room")!.error!, /1–20 identified arguments/);
  assert.equal(calls.some((call) => call.phase === "steelman"), false);
});

for (const secondStatus of ["failed", "unknown", "passed"] as const) {
  test(`multiple debate judges retain attributed reasoning and aggregate passed/${secondStatus} criteria`, async () => {
    const { service } = fixture((input) => input.phase === "verdict" ? JSON.stringify({
      summary: `Reasoned conclusion from ${input.participant.id}`,
      checks: [{ criterion: "Correctness", status: input.participant.id === "judge" ? "passed" : secondStatus, evidence: `Distinct observed evidence from ${input.participant.id}` }],
      unknowns: [],
    }) : defaultAnswer(input));
    service.start("room", { ...setup("debate", 3), participants: [...participants, { id: "second-judge", kind: "claude", label: "Second Judge" }] });
    await service.wait("room");
    const run = service.get("room")!;
    assert.equal(run.status, "completed");
    assert.equal(run.report!.checks.length, 1, "the final report assesses each original criterion once");
    assert.equal(run.report!.checks[0]!.status, secondStatus);
    for (const judge of [{ id: "judge", label: "Judge" }, { id: "second-judge", label: "Second Judge" }]) {
      assert.ok(run.report!.summary.includes(`${judge.label} (${judge.id}): Reasoned conclusion from ${judge.id}`));
      assert.ok(run.report!.checks[0]!.evidence.includes(`${judge.label} (${judge.id}): Distinct observed evidence from ${judge.id}`));
    }
    const originals = run.rounds.find((round) => round.phase === "verdict")!.entries;
    assert.equal(originals.length, 2);
    assert.equal(JSON.parse(originals[0]!.text!).checks[0].status, "passed");
    assert.equal(JSON.parse(originals[1]!.text!).checks[0].status, secondStatus);
    if (secondStatus === "passed") assert.deepEqual(run.report!.unknowns, []);
    else {
      assert.equal(run.report!.unknowns.length, 1);
      assert.match(run.report!.unknowns[0]!, /Judges disagree on criterion "Correctness"/);
      assert.ok(run.report!.unknowns[0]!.includes("Judge (judge): passed"));
      assert.ok(run.report!.unknowns[0]!.includes(`Second Judge (second-judge): ${secondStatus}`));
    }
  });
}

test("debate rejects a concession to an old or nonexistent argument", async () => {
  const { service, calls } = fixture((input) => input.phase === "rebuttal" ? JSON.stringify({ rebuttal: "Fine", concessions: [{ argumentId: "con-1", reason: "You repeated yourself" }], remainingDisagreement: "none", decisiveTest: "none" }) : defaultAnswer(input));
  service.start("room", setup("debate", 3));
  await service.wait("room");
  assert.equal(service.get("room")!.status, "failed");
  assert.match(service.get("room")!.error!, /distinct new opponent argument/);
  assert.equal(calls.some((c) => c.phase === "verdict"), false);
});

test("debate opening IDs cannot occupy the reserved fresh-argument namespace", async () => {
  const { service, calls } = fixture((input) => input.phase === "openings" ? JSON.stringify({ position: "A position", arguments: [{ id: `${input.participant.role}-new-1`, text: "Already said in the opening" }] }) : defaultAnswer(input));
  service.start("room", setup("debate", 3));
  await service.wait("room");
  assert.equal(service.get("room")!.status, "failed");
  assert.match(service.get("room")!.error!, /reserved new-argument namespace/);
  assert.equal(calls.some((c) => c.phase === "new_arguments" || c.phase === "rebuttal"), false);
});

test("resumed debate cannot reuse a historical opening ID for a newly phrased argument", async () => {
  const { service, stateDir } = fixture();
  const started = service.start("room", setup("debate", 3));
  await service.wait("room");
  const persisted = JSON.parse(readFileSync(join(stateDir, "room/workflow/state.json"), "utf8"));
  persisted.status = "failed";
  persisted.rounds = persisted.rounds.filter((round: { phase: string }) => ["openings", "steelman", "acceptance"].includes(round.phase));
  const oldEntry = persisted.rounds[0].entries[0];
  const oldOpening = JSON.parse(oldEntry.text);
  oldOpening.arguments[0].id = "pro-new-1";
  oldEntry.text = JSON.stringify(oldOpening);
  writeFileSync(join(stateDir, "room/workflow/state.json"), JSON.stringify(persisted));
  const calls: string[] = [];
  const recovered = new WorkflowService({ stateDir, execute: async (input) => { calls.push(input.phase); return { text: defaultAnswer(input) }; } });
  services.push(recovered);
  recovered.act("room", { type: "retry", runId: started.id });
  await recovered.wait("room");
  assert.equal(recovered.get("room")!.status, "failed");
  assert.match(recovered.get("room")!.error!, /reuse opening argument IDs/);
  assert.equal(calls.includes("rebuttal"), false);
});

test("malformed setup and role overlap are rejected before invoking the executor", () => {
  const { service, calls } = fixture();
  for (const budget of [null, 5, "100", [], { timeoutMs: NaN }, { maxRounds: 0 }, { timeoutMs: 999 }, { maxOutputChars: 100_001 }, { surprise: true }]) {
    assert.throws(() => service.start("room", { ...setup("verification"), budget } as WorkflowStartInput));
  }
  assert.throws(() => service.start("room", null as unknown as WorkflowStartInput));
  assert.throws(() => service.start("../private", setup("council")), /identifier/);
  assert.throws(() => service.start("room", setup("tournament")), /separate evaluator/);
  assert.throws(() => service.start("room", setup("debate")), /independent judge/);
  assert.throws(() => service.start("room", { ...setup("verification"), participants: [participants[0]!, participants[0]!] }), /distinct/);
  assert.throws(() => service.start("room", { ...setup("verification"), criteria: ["Same", "Same"] }), /distinct criteria/);
  assert.equal(calls.length, 0);
  assert.equal(service.get("room"), null);
});

test("cancellation prevents stale completions, rejects immediate restart, and retries safely", async () => {
  let release!: (text: string) => void;
  const gate = new Promise<string>((resolve) => { release = resolve; });
  let paused = true;
  const { service } = fixture((input) => paused ? gate : defaultAnswer(input));
  const started = service.start("room", setup("council"));
  await until(() => service.get("room")!.rounds.length > 0);
  service.cancel("room", started.id);
  assert.throws(() => service.start("room", setup("verification")), /still stopping/);
  assert.throws(() => service.act("room", { type: "retry", runId: started.id }), /still stopping/);
  await service.wait("room");
  paused = false;
  service.act("room", { type: "retry", runId: started.id });
  release("STALE SECRET MUST NEVER APPEAR");
  await service.wait("room");
  assert.equal(service.get("room")!.status, "completed");
  assert.equal(JSON.stringify(service.get("room")).includes("STALE SECRET"), false);
});

test("cancellation retains the room lock until every aborted worker finishes cleanup", async () => {
  const release: Array<() => void> = [];
  let aborted = 0;
  const { service, calls } = fixture(async (input) => {
    await new Promise<void>((resolve) => { release.push(resolve); input.signal.addEventListener("abort", () => { aborted++; }, { once: true }); });
    throw new Error("cleanup finished");
  }, 1000);
  const run = service.start("room", setup("council"));
  await until(() => calls.length === 2);
  service.cancel("room", run.id);
  assert.equal(aborted, 2);
  assert.equal(service.isBusy("room"), true);
  release[0]!();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(service.isBusy("room"), true, "the other worker still owns cleanup");
  assert.throws(() => service.start("room", setup("verification")), /still stopping/);
  release[1]!();
  await service.waitAll();
  assert.equal(service.isBusy("room"), false);
});

test("shutdown waits for cooperative cleanup but bounds a non-cooperative executor", async () => {
  let aborted = 0;
  const { service, calls } = fixture(async (input) => {
    input.signal.addEventListener("abort", () => { aborted++; }, { once: true });
    return await new Promise<string>(() => {});
  }, 20);
  service.start("room", setup("council"));
  await until(() => calls.length === 2);
  const before = Date.now();
  service.dispose();
  assert.equal(service.isBusy("room"), true);
  await service.waitAll();
  assert.equal(aborted, 2);
  assert.equal(service.isBusy("room"), false);
  assert.ok(Date.now() - before < 1000, "a rogue executor cannot hang shutdown");
});

test("restart requires explicit retry and resumes after already revealed phases", async () => {
  const { service, stateDir } = fixture((input) => input.phase === "review" ? Promise.reject(new Error("PROVIDER PRIVATE OUTPUT")) : defaultAnswer(input));
  const started = service.start("room", setup("verification"));
  await service.wait("room");
  const persisted = JSON.parse(readFileSync(join(stateDir, "room/workflow/state.json"), "utf8"));
  persisted.status = "running";
  writeFileSync(join(stateDir, "room/workflow/state.json"), JSON.stringify(persisted));
  const calls: string[] = [];
  const recovered = new WorkflowService({ stateDir, execute: async (input) => { calls.push(input.phase); return { text: defaultAnswer(input) }; } });
  services.push(recovered);
  assert.equal(recovered.get("room")!.status, "failed");
  assert.match(recovered.get("room")!.error!, /restart/);
  assert.equal(calls.length, 0);
  recovered.act("room", { type: "retry", runId: started.id });
  await recovered.wait("room");
  assert.deepEqual(calls, ["review"]);
  assert.equal(recovered.get("room")!.status, "completed");
});

test("provider errors and oversized text cannot leak through public errors or failed entries", async () => {
  const { service } = fixture(() => Promise.reject(Object.assign(new Error("SECRET PATH AND SUBMISSION"), { code: "auth_missing" })));
  service.start("room", setup("council"));
  await service.wait("room");
  assert.match(service.get("room")!.error!, /not authenticated/);
  assert.equal(JSON.stringify(service.get("room")).includes("SECRET PATH"), false);
  const { service: oversize } = fixture(() => "X".repeat(5001));
  oversize.start("room", setup("council"));
  await oversize.wait("room");
  assert.match(oversize.get("room")!.error!, /output budget/);
  assert.equal(oversize.get("room")!.rounds[0]!.entries.every((e) => e.text === undefined), true);
});

test("immutable selected file context is equal for all blind workers and retained with history", async () => {
  const { service, calls } = fixture();
  const context = [{ path: "sample.ts", text: "export const value = 1;" }];
  const first = service.start("room", { ...setup("council"), context });
  context[0]!.text = "Mutated caller text";
  await service.wait("room");
  const blind = calls.filter((call) => call.phase === "answers");
  assert.equal(blind.every((call) => call.prompt.includes("export const value = 1;")), true);
  assert.equal(blind.some((call) => call.prompt.includes("Mutated caller text")), false);
  service.start("room", setup("verification"));
  await service.wait("room");
  assert.equal(service.history("room").length, 2);
  assert.equal(service.history("room").find((run) => run.id === first.id)!.context![0]!.text, "export const value = 1;");
});

test("corrupt private state diagnostics never quote private submission content", async () => {
  const { service, stateDir } = fixture();
  service.start("room", setup("verification"));
  await service.wait("room");
  for (const damaged of ["null", '"PRIVATE SEALED VALUE" invalid-json', '{"roomId":"room","rounds":[null]}']) {
    writeFileSync(join(stateDir, "room/workflow/state.json"), damaged);
    const recovered = new WorkflowService({ stateDir, execute: async () => ({ text: "unused" }) });
    assert.throws(() => recovered.get("room"), (error: Error) => /Invalid persisted workflow/.test(error.message) && !error.message.includes("PRIVATE SEALED VALUE"));
  }
});
