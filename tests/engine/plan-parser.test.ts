import test from "node:test";
import assert from "node:assert/strict";
import { parseTeamPlan } from "../../internal/engine/plan-parser.js";

test("parseTeamPlan: empty text returns null", () => {
  assert.equal(parseTeamPlan("", ["codex", "claude"]), null);
});

test("parseTeamPlan: text without PLAN: block returns null", () => {
  assert.equal(parseTeamPlan("Some discussion text.", ["codex", "claude"]), null);
});

test("parseTeamPlan: parses a valid PLAN block", () => {
  const text = `Here is my proposed plan:

PLAN:
- agent: codex
  task: Implement auth endpoints
  files: internal/api/auth.ts, internal/api/middleware.ts
- agent: claude
  task: Write documentation
  files: docs/auth.md
PLAN_END`;

  const plan = parseTeamPlan(text, ["codex", "claude"]);
  assert.ok(plan);
  assert.equal(plan.assignments.length, 2);
  assert.equal(plan.assignments[0].agent, "codex");
  assert.equal(plan.assignments[0].task, "Implement auth endpoints");
  assert.deepEqual(plan.assignments[0].files, ["internal/api/auth.ts", "internal/api/middleware.ts"]);
  assert.equal(plan.assignments[1].agent, "claude");
  assert.equal(plan.assignments[1].task, "Write documentation");
  assert.deepEqual(plan.assignments[1].files, ["docs/auth.md"]);
});

test("parseTeamPlan: PLAN_ACCEPT signals acceptance", () => {
  const text = `Looks good, I agree with the plan.
PLAN_ACCEPT`;
  const plan = parseTeamPlan(text, ["codex", "claude"]);
  assert.ok(plan);
  assert.equal(plan.accepted, true);
});

test("parseTeamPlan: ignores unknown agents", () => {
  const text = `PLAN:
- agent: unknown_agent
  task: Do something
  files: file.ts
PLAN_END`;
  const plan = parseTeamPlan(text, ["codex", "claude"]);
  assert.ok(plan);
  assert.equal(plan.assignments.length, 0);
});

test("parseTeamPlan: handles files as comma-separated list", () => {
  const text = `PLAN:
- agent: codex
  task: Build it
  files: a.ts, b.ts, c.ts
PLAN_END`;
  const plan = parseTeamPlan(text, ["codex", "claude"]);
  assert.ok(plan);
  assert.deepEqual(plan.assignments[0].files, ["a.ts", "b.ts", "c.ts"]);
});

test("parseTeamPlan: handles files with JSON array syntax", () => {
  const text = `PLAN:
- agent: codex
  task: Build it
  files: ["a.ts", "b.ts"]
PLAN_END`;
  const plan = parseTeamPlan(text, ["codex", "claude"]);
  assert.ok(plan);
  assert.deepEqual(plan.assignments[0].files, ["a.ts", "b.ts"]);
});

test("parseTeamPlan: PLAN block without PLAN_END still parses", () => {
  const text = `PLAN:
- agent: codex
  task: Build it
  files: a.ts`;
  const plan = parseTeamPlan(text, ["codex"]);
  assert.ok(plan);
  assert.equal(plan.assignments.length, 1);
  assert.equal(plan.assignments[0].agent, "codex");
});

test("parseTeamPlan: case insensitive agent matching", () => {
  const text = `PLAN:
- agent: Codex
  task: Build it
  files: a.ts
PLAN_END`;
  const plan = parseTeamPlan(text, ["codex", "claude"]);
  assert.ok(plan);
  assert.equal(plan.assignments[0].agent, "codex");
});

test("parseTeamPlan: preserves raw text", () => {
  const text = `PLAN:
- agent: codex
  task: Build
  files: a.ts
PLAN_END`;
  const plan = parseTeamPlan(text, ["codex"]);
  assert.ok(plan);
  assert.equal(plan.raw, text);
});
