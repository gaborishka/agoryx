# Team Parallel Execution Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the sequential debate loop in team mode with a 3-phase flow: Plan (negotiation) -> Execute (parallel) -> Merge (git auto-merge).

**Architecture:** The `TeamOrchestrator.runLoop()` sequential debate loop is replaced by three explicit phases. Phase 1 runs 2 sequential negotiation rounds to produce a structured `TeamPlan`. Phase 2 dispatches all agents concurrently via `Promise.all`. Phase 3 merges worktree branches into the session branch using git merge.

**Tech Stack:** TypeScript, Node.js `node:test`, `better-sqlite3`, `execFileSync` (git), existing adapter/dispatch infrastructure.

---

### Task 1: Add `TeamPlan` type and `PLAN:` parser

**Files:**
- Modify: `internal/events/types.ts:12` (add `TeamRunStage` value)
- Create: `internal/engine/plan-parser.ts`
- Create: `tests/engine/plan-parser.test.ts`

**Context:** Agents will output a structured `PLAN:` block during the planning phase. We need a type to represent it and a parser to extract it from agent output. The parser follows the same pattern as `parseTeamDebateControl` in `team-orchestrator.ts:801-832`.

**Step 1: Write the failing tests for plan parsing**

```typescript
// tests/engine/plan-parser.test.ts
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
```

**Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/engine/plan-parser.test.ts`
Expected: FAIL — module not found

**Step 3: Add the `TeamPlanAssignment` and `TeamPlan` types**

Add to `internal/events/types.ts` after line 199 (end of file):

```typescript
export interface TeamPlanAssignment {
  agent: string;
  task: string;
  files: string[];
}

export interface TeamPlan {
  assignments: TeamPlanAssignment[];
  accepted: boolean;
  raw: string;
}
```

**Step 4: Implement the plan parser**

```typescript
// internal/engine/plan-parser.ts
import type { TeamPlan, TeamPlanAssignment } from "../events/types.js";

const PLAN_BLOCK_PATTERN = /PLAN:\s*\n([\s\S]*?)(?:PLAN_END|$)/i;
const PLAN_ACCEPT_PATTERN = /^\s*PLAN_ACCEPT\s*$/im;
const ASSIGNMENT_PATTERN = /^-\s*agent:\s*(\S+)\s*\n\s*task:\s*(.+)\s*\n\s*files:\s*(.+)/gim;

export const parseTeamPlan = (
  text: string,
  availableAgents: string[],
): TeamPlan | null => {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Check for PLAN_ACCEPT
  if (PLAN_ACCEPT_PATTERN.test(trimmed)) {
    return { assignments: [], accepted: true, raw: trimmed };
  }

  // Extract PLAN: block
  const blockMatch = PLAN_BLOCK_PATTERN.exec(trimmed);
  if (!blockMatch?.[1]) return null;

  const block = blockMatch[1];
  const agentSet = new Set(availableAgents.map((a) => a.toLowerCase()));
  const assignments: TeamPlanAssignment[] = [];

  // Reset lastIndex for global regex
  ASSIGNMENT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ASSIGNMENT_PATTERN.exec(block)) !== null) {
    const agent = match[1]!.toLowerCase();
    if (!agentSet.has(agent)) continue;

    const task = match[2]!.trim();
    const filesRaw = match[3]!.trim();
    const files = parseFilesList(filesRaw);

    assignments.push({ agent, task, files });
  }

  if (assignments.length === 0 && !PLAN_ACCEPT_PATTERN.test(trimmed)) {
    return null;
  }

  return { assignments, accepted: false, raw: trimmed };
};

const parseFilesList = (raw: string): string[] => {
  // Handle JSON array: ["a.ts", "b.ts"]
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((f: string) => f.trim());
    } catch {
      // Fall through to comma-separated
    }
  }
  // Comma-separated: a.ts, b.ts
  return raw.split(",").map((f) => f.trim()).filter(Boolean);
};
```

**Step 5: Run tests to verify they pass**

Run: `npx tsx --test tests/engine/plan-parser.test.ts`
Expected: All 7 tests PASS

**Step 6: Commit**

```bash
git add internal/events/types.ts internal/engine/plan-parser.ts tests/engine/plan-parser.test.ts
git commit -m "feat(team): add TeamPlan type and PLAN: block parser"
```

---

### Task 2: Add `mergeWorktreeBranch` to WorktreeManager

**Files:**
- Modify: `internal/worktree/manager.ts:28-100`
- Create: `tests/worktree/merge.test.ts`

**Context:** After parallel execution, each agent's worktree branch needs to be merged into the current branch. `WorktreeManager` already creates branches (`agoryx/{agent}-{shortId}`) at line 68 and has `execFileSync` git utilities. We add a `merge` method that merges a given agent's worktree branch into the repo's current branch.

**Step 1: Write the failing tests**

```typescript
// tests/worktree/merge.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorktreeManager } from "../../internal/worktree/manager.js";

const createTestRepo = (t: Parameters<Parameters<typeof test>[1]>[0]): string => {
  const dir = mkdtempSync(join(tmpdir(), "wt-merge-test-"));
  t.after(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# Test\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
};

test("merge: merges agent branch into current branch", async (t) => {
  const repo = createTestRepo(t);
  const manager = new WorktreeManager(repo);
  const wt = manager.create("codex");

  // Create a file in the worktree
  writeFileSync(join(wt.path, "codex-output.txt"), "hello from codex\n");
  execFileSync("git", ["add", "."], { cwd: wt.path });
  execFileSync("git", ["commit", "-m", "codex work"], { cwd: wt.path });

  const result = manager.merge("codex");
  assert.equal(result.success, true);
  assert.equal(result.conflicts, null);

  // Verify the file is now on main
  const content = execFileSync("git", ["show", "HEAD:codex-output.txt"], {
    cwd: repo,
    encoding: "utf-8",
  });
  assert.equal(content.trim(), "hello from codex");
});

test("merge: reports conflicts when branches conflict", async (t) => {
  const repo = createTestRepo(t);
  const manager = new WorktreeManager(repo);
  const wt = manager.create("codex");

  // Modify same file in both branches
  writeFileSync(join(repo, "README.md"), "# Modified on main\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "main change"], { cwd: repo });

  writeFileSync(join(wt.path, "README.md"), "# Modified by codex\n");
  execFileSync("git", ["add", "."], { cwd: wt.path });
  execFileSync("git", ["commit", "-m", "codex change"], { cwd: wt.path });

  const result = manager.merge("codex");
  assert.equal(result.success, false);
  assert.ok(result.conflicts);
  assert.ok(result.conflicts.length > 0);
});

test("merge: returns success with no changes when branch is not ahead", async (t) => {
  const repo = createTestRepo(t);
  const manager = new WorktreeManager(repo);
  manager.create("codex");

  // No changes made in worktree
  const result = manager.merge("codex");
  assert.equal(result.success, true);
});
```

**Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/worktree/merge.test.ts`
Expected: FAIL — `manager.merge is not a function`

**Step 3: Implement `merge` on WorktreeManager**

Add to `internal/worktree/manager.ts` after the `remove()` method (after line 142):

```typescript
export interface MergeResult {
  success: boolean;
  conflicts: string[] | null;
}

public merge(agent: string): MergeResult {
  const normalizedAgent = normalizeWorktreeAgentName(agent);
  const info = this.agentMap.get(normalizedAgent);
  if (!info) {
    throw new Error(`No worktree found for agent '${agent}'.`);
  }

  // Check if agent branch has any commits ahead of current HEAD
  try {
    const diffOutput = execFileSync(
      "git",
      ["log", "--oneline", `HEAD..${info.branch}`],
      { cwd: this.repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    if (!diffOutput) {
      return { success: true, conflicts: null };
    }
  } catch {
    // Branch comparison failed — attempt merge anyway
  }

  try {
    execFileSync(
      "git",
      ["merge", info.branch, "--no-edit", "-m", `Merge ${info.branch} into current branch`],
      { cwd: this.repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { success: true, conflicts: null };
  } catch (error: unknown) {
    // Merge failed — likely conflicts
    try {
      const statusOutput = execFileSync(
        "git",
        ["diff", "--name-only", "--diff-filter=U"],
        { cwd: this.repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
      const conflicts = statusOutput ? statusOutput.split("\n") : [];
      // Abort the failed merge
      try {
        execFileSync("git", ["merge", "--abort"], {
          cwd: this.repoRoot,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        // Abort may fail if no merge in progress
      }
      return { success: false, conflicts };
    } catch {
      return { success: false, conflicts: ["unknown conflict — manual resolution required"] };
    }
  }
}
```

Also export `MergeResult` from the module.

**Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/worktree/merge.test.ts`
Expected: All 3 tests PASS

**Step 5: Commit**

```bash
git add internal/worktree/manager.ts tests/worktree/merge.test.ts
git commit -m "feat(worktree): add merge method for combining agent branches"
```

---

### Task 3: Implement `runPlanningPhase` in TeamOrchestrator

**Files:**
- Modify: `internal/engine/team-orchestrator.ts:492-516` (replace `runLoop`)
- Modify: `internal/engine/team-orchestrator.ts:1-27` (add imports)
- Create: `tests/engine/team-planning.test.ts`

**Context:** The current `runLoop()` at line 492 is a `while(true)` sequential debate loop. We replace it with a 3-phase flow. This task implements phase 1: planning. The planning phase runs 2 sequential rounds — Round 1: first agent proposes a plan, Round 2: second agent accepts or amends.

The method reuses the existing dispatch infrastructure: `dispatchApi.createInternalDispatch()` and `dispatchApi.runPromptDispatch()` (same as `executeDebateStep` at line 556-562). The key difference is the prompt instructs agents to output a `PLAN:` block, and we parse it with `parseTeamPlan` from Task 1.

**Step 1: Write the failing tests**

```typescript
// tests/engine/team-planning.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { SQLiteStore } from "../../internal/storage/sqlite.js";
import { SessionService } from "../../internal/session/service.js";
import { ChatEngine } from "../../internal/engine/chat.js";
import type {
  AdapterEvent,
  PersistentAdapter,
  SendTurnInput,
} from "../../internal/adapters/adapter.js";
import {
  messageCompleted,
  messageStarted,
  sessionBound,
} from "../../internal/adapters/event-factory.js";
import { createId } from "../../internal/session/ids.js";
import type { ChatRuntimeConfig } from "../../internal/config/default.js";

const PLAN_RESPONSE = `Here is the plan:

PLAN:
- agent: alpha
  task: Implement feature A
  files: feature-a.ts
- agent: beta
  task: Write tests for A
  files: test-a.ts
PLAN_END`;

const ACCEPT_RESPONSE = `The plan looks good.
PLAN_ACCEPT
TEAM_DONE`;

const makeAdapter = (
  name: string,
  textFactory: (callIndex: number) => string,
): PersistentAdapter & { calls: SendTurnInput[] } => {
  const calls: SendTurnInput[] = [];
  return {
    name,
    calls,
    async *send() {
      throw new Error("send() should not be used");
    },
    async *sendTurn(input: SendTurnInput): AsyncGenerator<AdapterEvent> {
      calls.push(input);
      const base = {
        roomId: input.roomId,
        sessionId: input.sessionId,
        requestId: input.requestId,
        source: `adapter.${name}`,
      };
      const text = textFactory(calls.length);
      const payload = {
        messageId: createId("msg"),
        author: `agent.${name}`,
        role: "assistant" as const,
        text,
        format: "markdown" as const,
        metadata: { provider: "test", model: "test", requestId: input.requestId },
      };
      yield messageStarted(base, { ...payload, text: "" });
      yield sessionBound(base, "native-session");
      yield messageCompleted(base, payload);
    },
    async cancel() {},
    async health() {
      return "ready" as const;
    },
  };
};

const createEngine = (
  adapters: PersistentAdapter[],
  options: { maxSteps?: number } = {},
) => {
  const store = new SQLiteStore(":memory:");
  store.init();
  const session = new SessionService(store);
  const adapterConfig: Record<string, { mode: string; timeoutMs: number; maxTokens: number }> = {};
  const adapterMap: Record<string, PersistentAdapter> = {};
  for (const adapter of adapters) {
    adapterConfig[adapter.name] = { mode: "agentic", timeoutMs: 30_000, maxTokens: 4_000 };
    adapterMap[adapter.name] = adapter;
  }
  const config: ChatRuntimeConfig = {
    dbPath: ":memory:",
    mode: "team",
    roomName: "team-room",
    agents: adapters.map((a) => a.name),
    roomConfig: {
      mode: "team",
      checkpointThreshold: 50,
      maxHistoryMessages: 100,
      maxContextTokens: 30_000,
    },
    adapterConfig,
    team: {
      profile: "enthusiast",
      maxSteps: options.maxSteps ?? 4,
      maxNoProgressSteps: 2,
      maxDurationMs: 900_000,
      checksEnabledByDefault: false,
      checkCommands: [],
      strict: {
        maxSteps: 8,
        maxNoProgressSteps: 2,
        maxDurationMs: 900_000,
        checksEnabledByDefault: false,
      },
      finalGate: "proposal",
      singleActive: true,
      trigger: { autoOnMessage: true, commandStart: true },
    },
    agentSkills: {},
  };
  const engine = new ChatEngine(session, adapterMap, config);
  engine.init();
  return { engine, store, session, config };
};

const waitForRunStatus = async (
  engine: ChatEngine,
  expected: string,
  timeoutMs = 2000,
): Promise<void> => {
  for (let i = 0; i < timeoutMs / 25; i++) {
    const status = engine.teamStatus();
    if (status?.run.status === expected) return;
    await wait(25);
  }
  throw new Error(`timed out waiting for run status=${expected}`);
};

test("team planning: agents negotiate a plan in 2 rounds", async (t) => {
  const alpha = makeAdapter("alpha", (i) => (i === 1 ? PLAN_RESPONSE : "TEAM_DONE"));
  const beta = makeAdapter("beta", () => ACCEPT_RESPONSE);

  const { engine } = createEngine([alpha, beta]);
  engine.teamStart("Build feature A with tests");
  await waitForRunStatus(engine, "waiting_user_input", 5000);

  // Alpha should have been called first (propose), beta second (accept/amend)
  assert.ok(alpha.calls.length >= 1, "alpha should be called at least once");
  assert.ok(beta.calls.length >= 1, "beta should be called at least once");

  // The first call to alpha should contain planning instructions
  const alphaPrompt = alpha.calls[0]!.prompt ?? "";
  assert.ok(
    alphaPrompt.includes("PLAN:") || alphaPrompt.toLowerCase().includes("plan"),
    "alpha prompt should contain planning instructions",
  );
});
```

**Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/engine/team-planning.test.ts`
Expected: FAIL — current implementation runs debate loop instead of planning phase

**Step 3: Implement `runPlanningPhase`**

In `internal/engine/team-orchestrator.ts`:

1. Add import at top (after line 18):
```typescript
import { parseTeamPlan } from "./plan-parser.js";
import type { TeamPlan } from "../events/types.js";
```

2. Replace `runLoop` (lines 492-516) with the new 3-phase flow:

```typescript
private async runLoop(runId: string): Promise<void> {
  const run = this.session.getTeamRun(runId);
  if (!run || run.status !== "active") return;

  // Phase 1: Planning
  const plan = await this.runPlanningPhase(run);
  if (!plan || this.teamStopFlags.has(runId)) {
    if (!this.teamStopFlags.has(runId)) {
      this.completeRun(run, "Planning phase failed to produce a plan.");
    }
    return;
  }

  // Phase 2: Parallel execution
  await this.runParallelExecution(run, plan);
  if (this.teamStopFlags.has(runId)) return;

  // Phase 3: Merge
  await this.runMergePhase(run);
}
```

3. Add the `runPlanningPhase` method (add after `runLoop`):

```typescript
private async runPlanningPhase(run: TeamRun): Promise<TeamPlan | null> {
  const state = this.getState();
  const agents = state.availableAgents;
  if (agents.length < 2) {
    // Single agent — no negotiation needed, auto-generate plan
    return {
      assignments: [{ agent: agents[0]!, task: run.goal, files: [] }],
      accepted: true,
      raw: "",
    };
  }

  let latestPlan: TeamPlan | null = null;

  // Round 1: First agent proposes
  const proposer = agents[0]!;
  const proposePrompt = this.session.buildTeamPrompt(
    state.room,
    run,
    "plan",
    proposer,
    {
      instructions:
        `You are the PLAN PROPOSER. The team has ${agents.length} agents: ${agents.join(", ")}.\n` +
        `Analyze the goal and create a work plan. Divide the work so each agent handles distinct files.\n` +
        `Output your plan in this exact format:\n\n` +
        `PLAN:\n` +
        `- agent: <name>\n` +
        `  task: <description>\n` +
        `  files: <comma-separated file paths>\n` +
        `- agent: <name>\n` +
        `  task: <description>\n` +
        `  files: <comma-separated file paths>\n` +
        `PLAN_END\n\n` +
        `Every agent must appear in the plan. Assign non-overlapping files.`,
    },
  );

  const proposeDispatch = this.dispatchApi.createInternalDispatch(proposer, `team:plan:propose`);
  this.trackActiveTeamDispatch(run.id, proposer, proposeDispatch.requestId);
  let proposeResult: DispatchResult;
  try {
    proposeResult = await this.dispatchApi.runPromptDispatch(proposeDispatch, proposePrompt, false, {
      outputTransform: sanitizeTeamOutput,
    });
  } finally {
    this.clearActiveTeamDispatch(run.id, proposeDispatch.requestId);
  }

  if (this.consumeInterruptedRequest(proposeDispatch.requestId)) return null;
  if (!proposeResult.success) return null;

  this.session.addTeamStep({
    runId: run.id,
    seq: 1,
    stage: "plan",
    actor: proposer,
    dispatchId: proposeDispatch.dispatchId,
    requestId: proposeDispatch.requestId,
    inputText: proposePrompt,
    outputText: proposeResult.text,
    result: "ok",
    errorClass: null,
  });
  this.session.updateTeamRunProgress(run.id, { stage: "plan", stepCount: 1, noProgressCount: 0 });

  latestPlan = parseTeamPlan(proposeResult.text, agents);

  // Round 2: Second agent reviews and accepts/amends
  const reviewer = agents[1]!;
  const reviewPrompt = this.session.buildTeamPrompt(
    state.room,
    run,
    "plan",
    reviewer,
    {
      instructions:
        `You are the PLAN REVIEWER. Review the proposed plan below.\n` +
        `If you agree, respond with: PLAN_ACCEPT\n` +
        `If you want changes, output a revised plan in the same format:\n\n` +
        `PLAN:\n- agent: ...\n  task: ...\n  files: ...\nPLAN_END\n\n` +
        `Proposed plan from ${proposer}:\n${proposeResult.text}`,
    },
  );

  const reviewDispatch = this.dispatchApi.createInternalDispatch(reviewer, `team:plan:review`);
  this.trackActiveTeamDispatch(run.id, reviewer, reviewDispatch.requestId);
  let reviewResult: DispatchResult;
  try {
    reviewResult = await this.dispatchApi.runPromptDispatch(reviewDispatch, reviewPrompt, false, {
      outputTransform: sanitizeTeamOutput,
    });
  } finally {
    this.clearActiveTeamDispatch(run.id, reviewDispatch.requestId);
  }

  if (this.consumeInterruptedRequest(reviewDispatch.requestId)) return null;

  this.session.addTeamStep({
    runId: run.id,
    seq: 2,
    stage: "plan",
    actor: reviewer,
    dispatchId: reviewDispatch.dispatchId,
    requestId: reviewDispatch.requestId,
    inputText: reviewPrompt,
    outputText: reviewResult.text,
    result: reviewResult.success ? "ok" : "error",
    errorClass: normalizeErrorClass(reviewResult.error),
  });
  this.session.updateTeamRunProgress(run.id, { stage: "plan", stepCount: 2, noProgressCount: 0 });

  if (!reviewResult.success) return latestPlan;

  const reviewPlan = parseTeamPlan(reviewResult.text, agents);
  if (reviewPlan?.accepted) {
    // Reviewer accepted — use the proposer's plan
    return latestPlan;
  }
  if (reviewPlan && reviewPlan.assignments.length > 0) {
    // Reviewer provided an amended plan
    return reviewPlan;
  }

  // Fallback — use proposer's plan even if reviewer didn't give a clean response
  return latestPlan;
}
```

**Step 4: Add stub methods for phases 2 and 3 (to be implemented in Tasks 4 and 5)**

```typescript
private async runParallelExecution(run: TeamRun, plan: TeamPlan): Promise<void> {
  // Stub — will be implemented in Task 4
  await this.executeDebateStep(run);
}

private async runMergePhase(run: TeamRun): Promise<void> {
  // Stub — will be implemented in Task 5
  this.completeRun(run, "Run completed.");
}
```

**Step 5: Run tests to verify they pass**

Run: `npx tsx --test tests/engine/team-planning.test.ts`
Expected: PASS

Also run existing tests to verify no regressions:
Run: `npx tsx --test tests/engine/team-mode.test.ts`
Expected: Existing tests may need adjustments since the flow changed — update mocks accordingly.

**Step 6: Run full test suite**

Run: `npm test`
Expected: All tests pass (fix any regressions from the flow change)

**Step 7: Commit**

```bash
git add internal/engine/team-orchestrator.ts tests/engine/team-planning.test.ts
git commit -m "feat(team): implement planning phase with 2-round negotiation"
```

---

### Task 4: Implement `runParallelExecution`

**Files:**
- Modify: `internal/engine/team-orchestrator.ts` (replace stub from Task 3)
- Modify: `internal/engine/dispatch-engine.ts:161-176` (allow concurrent dispatches)
- Create: `tests/engine/team-parallel.test.ts`

**Context:** After the planning phase produces a `TeamPlan`, each agent is dispatched simultaneously. Currently `executeDebateStep` (line 527) dispatches one agent at a time. The new `runParallelExecution` dispatches all agents in parallel using `Promise.all`.

The turn lock in `dispatch-engine.ts:161` (key: `${roomId}:${adapterName}`) already allows concurrent dispatches to *different* adapters — it only serializes turns to the *same* adapter. Since each agent is a different adapter, parallel dispatch is already safe. No changes needed to the lock.

**Step 1: Write the failing tests**

```typescript
// tests/engine/team-parallel.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { SQLiteStore } from "../../internal/storage/sqlite.js";
import { SessionService } from "../../internal/session/service.js";
import { ChatEngine } from "../../internal/engine/chat.js";
import type {
  AdapterEvent,
  PersistentAdapter,
  SendTurnInput,
} from "../../internal/adapters/adapter.js";
import {
  messageCompleted,
  messageStarted,
  sessionBound,
} from "../../internal/adapters/event-factory.js";
import { createId } from "../../internal/session/ids.js";
import type { ChatRuntimeConfig } from "../../internal/config/default.js";

const PLAN_RESPONSE = `PLAN:
- agent: alpha
  task: Create file A
  files: output-a.txt
- agent: beta
  task: Create file B
  files: output-b.txt
PLAN_END`;

const makeTimedAdapter = (
  name: string,
  responses: string[],
  delayMs = 50,
): PersistentAdapter & { calls: SendTurnInput[]; callTimestamps: number[] } => {
  const calls: SendTurnInput[] = [];
  const callTimestamps: number[] = [];
  let callIndex = 0;
  return {
    name,
    calls,
    callTimestamps,
    async *send() {
      throw new Error("send() should not be used");
    },
    async *sendTurn(input: SendTurnInput): AsyncGenerator<AdapterEvent> {
      const idx = callIndex++;
      calls.push(input);
      callTimestamps.push(Date.now());
      const base = {
        roomId: input.roomId,
        sessionId: input.sessionId,
        requestId: input.requestId,
        source: `adapter.${name}`,
      };
      const text = responses[idx] ?? `response-${idx}\nTEAM_DONE`;
      const payload = {
        messageId: createId("msg"),
        author: `agent.${name}`,
        role: "assistant" as const,
        text,
        format: "markdown" as const,
        metadata: { provider: "test", model: "test", requestId: input.requestId },
      };
      yield messageStarted(base, { ...payload, text: "" });
      yield sessionBound(base, "native-session");
      if (delayMs > 0) await wait(delayMs);
      yield messageCompleted(base, payload);
    },
    async cancel() {},
    async health() {
      return "ready" as const;
    },
  };
};

const createEngine = (
  adapters: PersistentAdapter[],
  options: { maxSteps?: number } = {},
) => {
  const store = new SQLiteStore(":memory:");
  store.init();
  const session = new SessionService(store);
  const adapterConfig: Record<string, { mode: string; timeoutMs: number; maxTokens: number }> = {};
  const adapterMap: Record<string, PersistentAdapter> = {};
  for (const adapter of adapters) {
    adapterConfig[adapter.name] = { mode: "agentic", timeoutMs: 30_000, maxTokens: 4_000 };
    adapterMap[adapter.name] = adapter;
  }
  const config: ChatRuntimeConfig = {
    dbPath: ":memory:",
    mode: "team",
    roomName: "team-room",
    agents: adapters.map((a) => a.name),
    roomConfig: {
      mode: "team",
      checkpointThreshold: 50,
      maxHistoryMessages: 100,
      maxContextTokens: 30_000,
    },
    adapterConfig,
    team: {
      profile: "enthusiast",
      maxSteps: options.maxSteps ?? 10,
      maxNoProgressSteps: 5,
      maxDurationMs: 900_000,
      checksEnabledByDefault: false,
      checkCommands: [],
      strict: {
        maxSteps: 8,
        maxNoProgressSteps: 2,
        maxDurationMs: 900_000,
        checksEnabledByDefault: false,
      },
      finalGate: "proposal",
      singleActive: true,
      trigger: { autoOnMessage: true, commandStart: true },
    },
    agentSkills: {},
  };
  const engine = new ChatEngine(session, adapterMap, config);
  engine.init();
  return { engine, store, session, config };
};

const waitForRunStatus = async (
  engine: ChatEngine,
  expected: string,
  timeoutMs = 5000,
): Promise<void> => {
  for (let i = 0; i < timeoutMs / 25; i++) {
    const status = engine.teamStatus();
    if (status?.run.status === expected) return;
    await wait(25);
  }
  throw new Error(`timed out waiting for run status=${expected}`);
};

test("parallel execution: both agents dispatched concurrently", async (t) => {
  const alpha = makeTimedAdapter("alpha", [PLAN_RESPONSE, "Alpha work done.\nTEAM_DONE"], 100);
  const beta = makeTimedAdapter("beta", ["PLAN_ACCEPT\nTEAM_DONE", "Beta work done.\nTEAM_DONE"], 100);

  const { engine } = createEngine([alpha, beta]);
  engine.teamStart("Create files A and B");
  await waitForRunStatus(engine, "waiting_user_input", 10_000);

  // After planning (2 calls: propose + review), execution should have happened
  // Alpha: call 1 = plan propose, call 2 = execution
  // Beta: call 1 = plan review, call 2 = execution
  assert.ok(alpha.calls.length >= 2, `alpha should have at least 2 calls, got ${alpha.calls.length}`);
  assert.ok(beta.calls.length >= 2, `beta should have at least 2 calls, got ${beta.calls.length}`);

  // Execution calls (index 1) should have started roughly concurrently
  const alphaExecTime = alpha.callTimestamps[1]!;
  const betaExecTime = beta.callTimestamps[1]!;
  const timeDiff = Math.abs(alphaExecTime - betaExecTime);
  // If parallel, time diff should be < 50ms; if sequential, it would be > 100ms
  assert.ok(timeDiff < 80, `execution calls should be concurrent, diff=${timeDiff}ms`);
});
```

**Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/engine/team-parallel.test.ts`
Expected: FAIL — stub `runParallelExecution` doesn't dispatch concurrently

**Step 3: Implement `runParallelExecution`**

Replace the stub in `internal/engine/team-orchestrator.ts`:

```typescript
private async runParallelExecution(run: TeamRun, plan: TeamPlan): Promise<void> {
  const state = this.getState();
  this.session.updateTeamRunProgress(run.id, { stage: "implement" });

  const dispatchPromises: Promise<void>[] = [];

  for (const assignment of plan.assignments) {
    if (!state.availableAgents.includes(assignment.agent)) continue;
    if (this.teamStopFlags.has(run.id)) break;

    const agent = assignment.agent;
    const prompt = this.session.buildTeamPrompt(
      state.room,
      run,
      "implement",
      agent,
      {
        instructions:
          `You are executing your part of the agreed plan.\n` +
          `YOUR TASK: ${assignment.task}\n` +
          `FILES YOU OWN: ${assignment.files.length > 0 ? assignment.files.join(", ") : "as needed"}\n\n` +
          `Create or modify the files listed above to complete your task. ` +
          `You have full filesystem access in your workspace. ` +
          `When done, output TEAM_DONE.`,
      },
    );

    const dispatch = this.dispatchApi.createInternalDispatch(
      agent,
      `team:implement:${assignment.agent}`,
    );
    this.trackActiveTeamDispatch(run.id, agent, dispatch.requestId);

    const promise = this.dispatchApi
      .runPromptDispatch(dispatch, prompt, false, {
        outputTransform: sanitizeTeamOutput,
      })
      .then((result) => {
        this.clearActiveTeamDispatch(run.id, dispatch.requestId);

        const stepSeq = run.stepCount + plan.assignments.indexOf(assignment) + 1;
        const errorClass = normalizeErrorClass(result.error);
        this.session.addTeamStep({
          runId: run.id,
          seq: stepSeq,
          stage: "implement",
          actor: agent,
          dispatchId: dispatch.dispatchId,
          requestId: dispatch.requestId,
          inputText: prompt,
          outputText: result.text,
          result: result.success ? "ok" : "error",
          errorClass,
        });

        this.memoryService?.recordTeamStep(
          run.roomId,
          run.id,
          agent,
          result.text.slice(0, 200),
        );
      })
      .catch((error) => {
        this.clearActiveTeamDispatch(run.id, dispatch.requestId);
        this.logger.log("error", "team.parallel_dispatch_failed", {
          runId: run.id,
          agent,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    dispatchPromises.push(promise);
  }

  // Wait for all agents to complete
  await Promise.all(dispatchPromises);

  const updatedRun = this.session.getTeamRun(run.id);
  if (updatedRun) {
    this.session.updateTeamRunProgress(updatedRun.id, {
      stage: "implement",
      stepCount: 2 + plan.assignments.length, // 2 planning steps + N execution steps
    });
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/engine/team-parallel.test.ts`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass

**Step 6: Commit**

```bash
git add internal/engine/team-orchestrator.ts tests/engine/team-parallel.test.ts
git commit -m "feat(team): implement parallel execution phase with Promise.all dispatch"
```

---

### Task 5: Implement `runMergePhase`

**Files:**
- Modify: `internal/engine/team-orchestrator.ts` (replace merge stub from Task 3)
- Create: `tests/engine/team-merge.test.ts`

**Context:** After parallel execution completes, each agent's worktree branch needs to be merged into the session branch. We use `WorktreeManager.merge()` from Task 2. On success, report deliverables. On conflict, show conflicts to the user by setting run status to `waiting_user_input`.

**Step 1: Write the failing tests**

```typescript
// tests/engine/team-merge.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { SQLiteStore } from "../../internal/storage/sqlite.js";
import { SessionService } from "../../internal/session/service.js";
import { ChatEngine } from "../../internal/engine/chat.js";
import type {
  AdapterEvent,
  PersistentAdapter,
  SendTurnInput,
} from "../../internal/adapters/adapter.js";
import {
  messageCompleted,
  messageStarted,
  sessionBound,
} from "../../internal/adapters/event-factory.js";
import { createId } from "../../internal/session/ids.js";
import type { ChatRuntimeConfig } from "../../internal/config/default.js";

const makeAdapter = (
  name: string,
  responses: string[],
): PersistentAdapter & { calls: SendTurnInput[] } => {
  const calls: SendTurnInput[] = [];
  let callIndex = 0;
  return {
    name,
    calls,
    async *send() {
      throw new Error("send() not used");
    },
    async *sendTurn(input: SendTurnInput): AsyncGenerator<AdapterEvent> {
      const idx = callIndex++;
      calls.push(input);
      const base = {
        roomId: input.roomId,
        sessionId: input.sessionId,
        requestId: input.requestId,
        source: `adapter.${name}`,
      };
      const text = responses[idx] ?? `default-${idx}\nTEAM_DONE`;
      const payload = {
        messageId: createId("msg"),
        author: `agent.${name}`,
        role: "assistant" as const,
        text,
        format: "markdown" as const,
        metadata: { provider: "test", model: "test", requestId: input.requestId },
      };
      yield messageStarted(base, { ...payload, text: "" });
      yield sessionBound(base, "native-session");
      yield messageCompleted(base, payload);
    },
    async cancel() {},
    async health() {
      return "ready" as const;
    },
  };
};

test("merge phase: run completes after successful merge", async (t) => {
  // This test verifies the merge phase runs without errors when there
  // are no actual worktrees (in-memory test without git). The merge
  // phase should handle missing worktreeManager gracefully.
  const alpha = makeAdapter("alpha", [
    `PLAN:\n- agent: alpha\n  task: Do alpha work\n  files: a.txt\n- agent: beta\n  task: Do beta work\n  files: b.txt\nPLAN_END`,
    "Alpha done.\nTEAM_DONE",
  ]);
  const beta = makeAdapter("beta", [
    "PLAN_ACCEPT\nTEAM_DONE",
    "Beta done.\nTEAM_DONE",
  ]);

  const store = new SQLiteStore(":memory:");
  store.init();
  const session = new SessionService(store);
  const config: ChatRuntimeConfig = {
    dbPath: ":memory:",
    mode: "team",
    roomName: "merge-test",
    agents: ["alpha", "beta"],
    roomConfig: {
      mode: "team",
      checkpointThreshold: 50,
      maxHistoryMessages: 100,
      maxContextTokens: 30_000,
    },
    adapterConfig: {
      alpha: { mode: "agentic", timeoutMs: 30_000, maxTokens: 4_000 },
      beta: { mode: "agentic", timeoutMs: 30_000, maxTokens: 4_000 },
    },
    team: {
      profile: "enthusiast",
      maxSteps: 10,
      maxNoProgressSteps: 5,
      maxDurationMs: 900_000,
      checksEnabledByDefault: false,
      checkCommands: [],
      strict: { maxSteps: 8, maxNoProgressSteps: 2, maxDurationMs: 900_000, checksEnabledByDefault: false },
      finalGate: "proposal",
      singleActive: true,
      trigger: { autoOnMessage: true, commandStart: true },
    },
    agentSkills: {},
  };

  const engine = new ChatEngine(
    session,
    { alpha, beta },
    config,
  );
  engine.init();

  engine.teamStart("Create files A and B");

  // Wait for run to complete (should reach waiting_user_input via completeRun)
  for (let i = 0; i < 200; i++) {
    const status = engine.teamStatus();
    if (status && status.run.status !== "active") break;
    await wait(25);
  }

  const finalStatus = engine.teamStatus();
  assert.ok(finalStatus, "should have a team status");
  assert.ok(
    finalStatus.run.status === "waiting_user_input" || finalStatus.run.status === "done",
    `run should complete, got ${finalStatus.run.status}`,
  );
});
```

**Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/engine/team-merge.test.ts`
Expected: FAIL

**Step 3: Implement `runMergePhase`**

Replace the stub in `internal/engine/team-orchestrator.ts`:

```typescript
private async runMergePhase(run: TeamRun): Promise<void> {
  if (!this.worktreeManager) {
    // No worktree manager — skip merge, just complete
    this.completeRun(run, "Run completed (no worktree merge).");
    return;
  }

  this.session.updateTeamRunProgress(run.id, { stage: "finalize" });
  const state = this.getState();
  const mergeErrors: string[] = [];

  for (const agent of state.availableAgents) {
    const wt = this.worktreeManager.getForAgent(agent);
    if (!wt) continue;

    try {
      const result = this.worktreeManager.merge(agent);
      if (!result.success && result.conflicts) {
        mergeErrors.push(
          `Merge conflicts from ${agent} (branch ${wt.branch}): ${result.conflicts.join(", ")}`,
        );
      }
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      mergeErrors.push(`Failed to merge ${agent}: ${reason}`);
      this.logger.log("error", "team.merge_failed", { runId: run.id, agent, error: reason });
    }
  }

  if (mergeErrors.length > 0) {
    const summary =
      "Merge phase completed with conflicts:\n" + mergeErrors.join("\n") +
      "\n\nPlease resolve conflicts manually and approve the run.";
    this.session.updateTeamRunProgress(run.id, { finalSummary: summary });
    this.session.updateTeamRunStatus(run.id, "waiting_user_input", { finalSummary: summary });
    this.restoreTeamAdapterModes();
  } else {
    this.completeRun(run, "All agents completed and branches merged successfully.");
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/engine/team-merge.test.ts`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass

**Step 6: Commit**

```bash
git add internal/engine/team-orchestrator.ts tests/engine/team-merge.test.ts
git commit -m "feat(team): implement merge phase with git auto-merge and conflict reporting"
```

---

### Task 6: Update `TeamRunStage` and prompt builder for new stages

**Files:**
- Modify: `internal/events/types.ts:12` (verify `TeamRunStage` includes "plan" and "implement")
- Modify: `internal/session/service.ts:527-567` (update `buildTeamPrompt` for new stages)

**Context:** `TeamRunStage` at `types.ts:12` already includes `"plan"` and `"implement"` — verify this is correct. The `buildTeamPrompt` method at `service.ts:527` should work for all stages since it takes `stage` as a parameter and the instructions are passed in. This task is a verification + minor adjustments.

**Step 1: Verify `TeamRunStage` includes all needed values**

Check `internal/events/types.ts:12`:
```typescript
export type TeamRunStage = "debate" | "plan" | "implement" | "checks" | "finalize";
```
This already includes `"plan"` and `"implement"` — no changes needed.

**Step 2: Run the full test suite to verify everything works end-to-end**

Run: `npm run verify`
Expected: Typecheck + build + all tests pass

**Step 3: Commit (only if changes were needed)**

```bash
git add internal/events/types.ts internal/session/service.ts
git commit -m "fix(team): ensure stages and prompts support plan-execute-merge flow"
```

---

### Task 7: Remove `TEAM_NEXT`/`TEAM_DONE` from execution phase

**Files:**
- Modify: `internal/engine/team-orchestrator.ts` (execution phase ignores control lines)
- Modify: `tests/engine/team-parallel.test.ts` (verify no TEAM_NEXT handling in execution)

**Context:** In the old debate loop, `TEAM_NEXT` and `TEAM_DONE` were essential for agent handoffs. In the new parallel execution phase, agents run independently — they don't hand off to each other. The control lines are still used in the planning phase (the old `executeDebateStep` is removed), but we should make sure execution phase agent output with `TEAM_DONE` doesn't cause premature termination.

Since we already implemented `runParallelExecution` in Task 4 without any `parseTeamDebateControl` calls, this is already handled. This task is verification + cleanup.

**Step 1: Verify `runParallelExecution` doesn't parse control lines**

Read the implementation from Task 4 and confirm no calls to `parseTeamDebateControl` exist in the execution path.

**Step 2: Clean up the old `executeDebateStep` if it's no longer called**

The old `executeDebateStep` (lines 527-657) is no longer called by `runLoop`. If no other code path calls it, remove it. Check for references:

Run: `grep -n "executeDebateStep" internal/engine/team-orchestrator.ts`

If only the method definition exists, remove the method and the old `shouldFinalizeRun` helper.

**Step 3: Run full test suite**

Run: `npm run verify`
Expected: All tests pass

**Step 4: Commit**

```bash
git add internal/engine/team-orchestrator.ts
git commit -m "refactor(team): remove unused sequential debate step from execution path"
```

---

### Task 8: Integration test — full plan-execute-merge cycle

**Files:**
- Create: `tests/engine/team-full-cycle.test.ts`

**Context:** Write an end-to-end test that exercises all 3 phases with 2 mock adapters. Verify: (1) planning produces a plan, (2) both agents execute in parallel, (3) merge phase runs, (4) final status is correct.

**Step 1: Write the integration test**

```typescript
// tests/engine/team-full-cycle.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { SQLiteStore } from "../../internal/storage/sqlite.js";
import { SessionService } from "../../internal/session/service.js";
import { ChatEngine } from "../../internal/engine/chat.js";
import type {
  AdapterEvent,
  PersistentAdapter,
  SendTurnInput,
} from "../../internal/adapters/adapter.js";
import {
  messageCompleted,
  messageStarted,
  sessionBound,
} from "../../internal/adapters/event-factory.js";
import { createId } from "../../internal/session/ids.js";
import type { ChatRuntimeConfig } from "../../internal/config/default.js";

const makeSequentialAdapter = (
  name: string,
  responses: string[],
): PersistentAdapter & { calls: SendTurnInput[] } => {
  const calls: SendTurnInput[] = [];
  let idx = 0;
  return {
    name,
    calls,
    async *send() { throw new Error("unused"); },
    async *sendTurn(input: SendTurnInput): AsyncGenerator<AdapterEvent> {
      const i = idx++;
      calls.push(input);
      const base = {
        roomId: input.roomId,
        sessionId: input.sessionId,
        requestId: input.requestId,
        source: `adapter.${name}`,
      };
      const text = responses[i] ?? `fallback-${i}\nTEAM_DONE`;
      const payload = {
        messageId: createId("msg"),
        author: `agent.${name}`,
        role: "assistant" as const,
        text,
        format: "markdown" as const,
        metadata: { provider: "test", model: "test", requestId: input.requestId },
      };
      yield messageStarted(base, { ...payload, text: "" });
      yield sessionBound(base, "native-session");
      yield messageCompleted(base, payload);
    },
    async cancel() {},
    async health() { return "ready" as const; },
  };
};

test("full cycle: plan -> parallel execute -> merge -> complete", async (t) => {
  const codex = makeSequentialAdapter("codex", [
    // Round 1: propose plan
    `I'll create the implementation.

PLAN:
- agent: codex
  task: Implement the sorting algorithm
  files: internal/sort.ts
- agent: claude
  task: Write comprehensive tests
  files: tests/sort.test.ts
PLAN_END`,
    // Execution: codex does its work
    "I've implemented the sorting algorithm in internal/sort.ts.\nTEAM_DONE",
  ]);

  const claude = makeSequentialAdapter("claude", [
    // Round 2: accept plan
    "The plan looks well structured. I'll handle testing.\nPLAN_ACCEPT",
    // Execution: claude does its work
    "I've written the test suite in tests/sort.test.ts.\nTEAM_DONE",
  ]);

  const store = new SQLiteStore(":memory:");
  store.init();
  const session = new SessionService(store);
  const config: ChatRuntimeConfig = {
    dbPath: ":memory:",
    mode: "team",
    roomName: "full-cycle-test",
    agents: ["codex", "claude"],
    roomConfig: {
      mode: "team",
      checkpointThreshold: 50,
      maxHistoryMessages: 100,
      maxContextTokens: 30_000,
    },
    adapterConfig: {
      codex: { mode: "agentic", timeoutMs: 30_000, maxTokens: 4_000 },
      claude: { mode: "agentic", timeoutMs: 30_000, maxTokens: 4_000 },
    },
    team: {
      profile: "enthusiast",
      maxSteps: 10,
      maxNoProgressSteps: 5,
      maxDurationMs: 900_000,
      checksEnabledByDefault: false,
      checkCommands: [],
      strict: { maxSteps: 8, maxNoProgressSteps: 2, maxDurationMs: 900_000, checksEnabledByDefault: false },
      finalGate: "proposal",
      singleActive: true,
      trigger: { autoOnMessage: true, commandStart: true },
    },
    agentSkills: {},
  };

  const engine = new ChatEngine(session, { codex, claude }, config);
  engine.init();

  engine.teamStart("Implement a merge sort algorithm with tests");

  // Wait for completion
  for (let i = 0; i < 200; i++) {
    const status = engine.teamStatus();
    if (status && status.run.status !== "active") break;
    await wait(25);
  }

  const status = engine.teamStatus();
  assert.ok(status, "should have team status");

  // Run should complete (waiting_user_input from completeRun's finalGate)
  assert.ok(
    status.run.status === "waiting_user_input" || status.run.status === "done",
    `expected complete status, got ${status.run.status}`,
  );

  // Verify both agents were called exactly twice each (1 plan + 1 execution)
  assert.equal(codex.calls.length, 2, "codex should have 2 calls: plan + execute");
  assert.equal(claude.calls.length, 2, "claude should have 2 calls: plan + execute");

  // Verify steps were recorded
  const steps = session.listTeamSteps(status.run.id, 10);
  assert.ok(steps.length >= 4, `should have at least 4 steps (2 plan + 2 exec), got ${steps.length}`);

  // Verify plan steps are first
  const planSteps = steps.filter((s) => s.stage === "plan");
  assert.ok(planSteps.length >= 2, "should have 2 planning steps");

  // Verify implement steps exist
  const implSteps = steps.filter((s) => s.stage === "implement");
  assert.ok(implSteps.length >= 2, "should have 2 implementation steps");
});

test("full cycle: single agent skips negotiation", async (t) => {
  const solo = makeSequentialAdapter("solo", [
    // No planning negotiation — goes straight to execution
    "I completed the entire task.\nTEAM_DONE",
  ]);

  const store = new SQLiteStore(":memory:");
  store.init();
  const session = new SessionService(store);
  const config: ChatRuntimeConfig = {
    dbPath: ":memory:",
    mode: "team",
    roomName: "solo-test",
    agents: ["solo"],
    roomConfig: {
      mode: "team",
      checkpointThreshold: 50,
      maxHistoryMessages: 100,
      maxContextTokens: 30_000,
    },
    adapterConfig: {
      solo: { mode: "agentic", timeoutMs: 30_000, maxTokens: 4_000 },
    },
    team: {
      profile: "enthusiast",
      maxSteps: 10,
      maxNoProgressSteps: 5,
      maxDurationMs: 900_000,
      checksEnabledByDefault: false,
      checkCommands: [],
      strict: { maxSteps: 8, maxNoProgressSteps: 2, maxDurationMs: 900_000, checksEnabledByDefault: false },
      finalGate: "proposal",
      singleActive: true,
      trigger: { autoOnMessage: true, commandStart: true },
    },
    agentSkills: {},
  };

  const engine = new ChatEngine(session, { solo }, config);
  engine.init();

  engine.teamStart("Do everything");

  for (let i = 0; i < 200; i++) {
    const status = engine.teamStatus();
    if (status && status.run.status !== "active") break;
    await wait(25);
  }

  const status = engine.teamStatus();
  assert.ok(status, "should have team status");
  assert.equal(solo.calls.length, 1, "solo agent: 1 execution call (no negotiation)");
});
```

**Step 2: Run the integration test**

Run: `npx tsx --test tests/engine/team-full-cycle.test.ts`
Expected: All tests PASS

**Step 3: Run full verification**

Run: `npm run verify`
Expected: Typecheck + build + all tests pass

**Step 4: Commit**

```bash
git add tests/engine/team-full-cycle.test.ts
git commit -m "test(team): add full-cycle integration test for plan-execute-merge flow"
```

---

### Task 9: Update existing team tests for new flow

**Files:**
- Modify: `tests/engine/team-mode.test.ts`
- Modify: `tests/cmd/team-command.test.ts`

**Context:** The old sequential debate loop is replaced. Existing tests that depend on the debate loop behavior (TEAM_NEXT handoffs, sequential execution) need to be updated to work with the new plan-execute-merge flow. Mock adapters need to return `PLAN:` blocks and `PLAN_ACCEPT` in their first responses.

**Step 1: Identify failing tests**

Run: `npm test`
Look at which tests in `team-mode.test.ts` and `team-command.test.ts` fail.

**Step 2: Update mock adapters in `team-mode.test.ts`**

The `makeAdapter` factory at line 22-63 needs to produce planning responses on first call and execution responses on second call:

```typescript
// Update textFactory logic in makeAdapter to handle planning phase
const textFactory = (callIndex: number) => {
  if (callIndex === 1) return planResponse;     // First call = plan propose/review
  return executionResponse;                       // Subsequent calls = execution
};
```

For single-adapter tests, no planning negotiation occurs (single agent skips it), so the adapter just needs execution responses.

**Step 3: Update command tests in `team-command.test.ts`**

Update any stdin input patterns that rely on sequential debate control lines.

**Step 4: Run all tests**

Run: `npm run verify`
Expected: All tests pass

**Step 5: Commit**

```bash
git add tests/engine/team-mode.test.ts tests/cmd/team-command.test.ts
git commit -m "test(team): update existing tests for plan-execute-merge flow"
```

---

### Task 10: Final verification and cleanup

**Files:**
- All modified files from Tasks 1-9

**Step 1: Run full verification**

Run: `npm run verify`
Expected: Typecheck + build + all tests pass

**Step 2: Manual smoke test**

Run: `npx tsx cmd/agoryx/main.ts chat --mode team --agents codex,claude`

Give it a task and verify:
1. Planning phase shows negotiation between agents
2. Both agents execute in parallel (visible in chat output)
3. Merge phase completes
4. Files are physically created in the worktrees

**Step 3: Check for dead code**

Search for any remaining references to removed methods:

```bash
grep -rn "executeDebateStep\|TEAM_NEXT" internal/ --include="*.ts"
```

Remove any dead code.

**Step 4: Final commit**

```bash
git add -A
git commit -m "chore(team): cleanup dead code from sequential debate loop"
```

---

## Summary

| Task | What | Files | Est. Complexity |
|------|------|-------|-----------------|
| 1 | `TeamPlan` type + `PLAN:` parser | `plan-parser.ts`, `types.ts` | Low |
| 2 | `WorktreeManager.merge()` | `manager.ts` | Medium |
| 3 | `runPlanningPhase` (2-round negotiation) | `team-orchestrator.ts` | High |
| 4 | `runParallelExecution` (Promise.all dispatch) | `team-orchestrator.ts` | Medium |
| 5 | `runMergePhase` (git auto-merge) | `team-orchestrator.ts` | Medium |
| 6 | Verify stages and prompts | `types.ts`, `service.ts` | Low |
| 7 | Remove old debate step | `team-orchestrator.ts` | Low |
| 8 | Integration test | `team-full-cycle.test.ts` | Medium |
| 9 | Update existing tests | `team-mode.test.ts`, `team-command.test.ts` | Medium |
| 10 | Final verification + cleanup | All | Low |
