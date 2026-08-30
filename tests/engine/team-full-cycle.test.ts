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

const makeCancellableAdapter = (
  name: string,
  responses: string[],
  slowFromCall: number,
  slowMs: number,
): PersistentAdapter & { calls: SendTurnInput[]; cancelled: string[] } => {
  const calls: SendTurnInput[] = [];
  const cancelled: string[] = [];
  let idx = 0;
  return {
    name,
    calls,
    cancelled,
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
      const text = responses[i] ?? `fallback-${i}`;
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
      if (i >= slowFromCall) {
        await wait(slowMs);
      }
      yield messageCompleted(base, payload);
    },
    async cancel(requestId: string) {
      cancelled.push(requestId);
    },
    async health() { return "ready" as const; },
  };
};

// Helper to create engine with 2 adapters
const createDualEngine = (
  adapters: PersistentAdapter[],
  options: { maxSteps?: number; maxNoProgressSteps?: number; maxDurationMs?: number } = {},
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
    roomName: "test-room",
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
      maxNoProgressSteps: options.maxNoProgressSteps ?? 5,
      maxDurationMs: options.maxDurationMs ?? 900_000,
      checksEnabledByDefault: false,
      checkCommands: [],
      strict: { maxSteps: 8, maxNoProgressSteps: 2, maxDurationMs: 900_000, checksEnabledByDefault: false },
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

test("full cycle: plan -> parallel execute -> merge -> complete", async () => {
  const codex = makeSequentialAdapter("codex", [
    // Round 1: propose plan
    `PLAN:\n- agent: codex\n  task: Implement sorting\n  files: sort.ts\n- agent: claude\n  task: Write tests\n  files: sort.test.ts\nPLAN_END`,
    // Execution
    "Implemented sorting algorithm.\nTEAM_DONE",
  ]);
  const claude = makeSequentialAdapter("claude", [
    // Round 2: accept
    "PLAN_ACCEPT",
    // Execution
    "Written test suite.\nTEAM_DONE",
  ]);

  const { engine, store, session } = createDualEngine([codex, claude]);
  try {
    engine.startTeamRun("Implement merge sort with tests");
    await waitForRunStatus(engine, "done", 10_000);

    // Both agents called twice: 1 plan + 1 execute
    assert.equal(codex.calls.length, 2, "codex: 1 plan + 1 exec");
    assert.equal(claude.calls.length, 2, "claude: 1 plan + 1 exec");

    const status = engine.teamStatus();
    assert.ok(status);
    const steps = session.listTeamSteps(status.run.id, 10);
    const planSteps = steps.filter((s) => s.stage === "plan");
    const implSteps = steps.filter((s) => s.stage === "implement");
    assert.ok(planSteps.length >= 2, "should have 2 planning steps");
    assert.ok(implSteps.length >= 2, "should have 2 implementation steps");

    const seqs = steps.map((s) => s.seq).sort((a, b) => a - b);
    assert.deepEqual(seqs, [1, 2, 3, 4], "seqs must be unique and continuous across phases");
    for (const step of implSteps) {
      assert.ok(step.seq > 2, "implement seqs must continue after planning seqs");
    }
    assert.equal(status.run.stepCount, 4, "stepCount must include planning and implement steps");
  } finally {
    await engine.shutdown();
    store.close();
  }
});

test("interrupt cancels every in-flight parallel dispatch", async () => {
  const codex = makeCancellableAdapter(
    "codex",
    [
      `PLAN:\n- agent: codex\n  task: Implement sorting\n  files: sort.ts\n- agent: claude\n  task: Write tests\n  files: sort.test.ts\nPLAN_END`,
      "Implemented sorting algorithm.",
    ],
    1,
    600,
  );
  const claude = makeCancellableAdapter(
    "claude",
    ["PLAN_ACCEPT", "Written test suite."],
    1,
    600,
  );

  const { engine, store, session } = createDualEngine([codex, claude]);
  try {
    engine.startTeamRun("Implement merge sort with tests");

    // Wait until both implement dispatches are in flight
    for (let i = 0; i < 200; i++) {
      if (codex.calls.length >= 2 && claude.calls.length >= 2) break;
      await wait(25);
    }
    assert.equal(codex.calls.length, 2, "codex implement dispatch in flight");
    assert.equal(claude.calls.length, 2, "claude implement dispatch in flight");

    const result = await engine.interruptTeamRun();
    assert.ok(result, "interrupt should find the active run");
    assert.equal(result.interrupted, true);
    assert.equal(codex.cancelled.length, 1, "codex dispatch must be cancelled");
    assert.equal(claude.cancelled.length, 1, "claude dispatch must be cancelled");

    await waitForRunStatus(engine, "done", 10_000);
    const status = engine.teamStatus();
    assert.ok(status);
    const implSteps = session
      .listTeamSteps(status.run.id, 10)
      .filter((s) => s.stage === "implement");
    assert.equal(implSteps.length, 2);
    for (const step of implSteps) {
      assert.equal(step.result, "stopped", "interrupted implement steps record as stopped");
    }
  } finally {
    await engine.shutdown();
    store.close();
  }
});

test("limits: exhausted maxSteps finalizes run without any dispatch", async () => {
  const codex = makeSequentialAdapter("codex", []);
  const claude = makeSequentialAdapter("claude", []);
  const { engine, store } = createDualEngine([codex, claude], { maxSteps: 0 });
  try {
    engine.startTeamRun("Goal that must not dispatch");
    await waitForRunStatus(engine, "waiting_user_input", 5_000);

    const status = engine.teamStatus();
    assert.ok(status);
    assert.match(status.run.finalSummary ?? "", /Team limits reached: max steps/);
    assert.equal(codex.calls.length, 0, "no dispatch when step limit is exhausted");
    assert.equal(claude.calls.length, 0, "no dispatch when step limit is exhausted");
  } finally {
    await engine.shutdown();
    store.close();
  }
});

test("limits: exceeded maxDurationMs finalizes run without any dispatch", async () => {
  const codex = makeSequentialAdapter("codex", []);
  const claude = makeSequentialAdapter("claude", []);
  const { engine, store } = createDualEngine([codex, claude], { maxDurationMs: 0 });
  try {
    engine.startTeamRun("Goal that must not dispatch");
    await waitForRunStatus(engine, "waiting_user_input", 5_000);

    const status = engine.teamStatus();
    assert.ok(status);
    assert.match(status.run.finalSummary ?? "", /Team limits reached: max duration/);
    assert.equal(codex.calls.length, 0, "no dispatch when duration limit is exceeded");
    assert.equal(claude.calls.length, 0, "no dispatch when duration limit is exceeded");
  } finally {
    await engine.shutdown();
    store.close();
  }
});

test("limits: implement dispatches are clamped to the remaining step budget", async () => {
  const codex = makeSequentialAdapter("codex", [
    `PLAN:\n- agent: codex\n  task: Implement sorting\n  files: sort.ts\n- agent: claude\n  task: Write tests\n  files: sort.test.ts\nPLAN_END`,
    "Implemented sorting algorithm within the step budget of this limited run.",
  ]);
  const claude = makeSequentialAdapter("claude", ["PLAN_ACCEPT"]);

  // maxSteps 3 = 2 planning steps + budget for a single implement step
  const { engine, store, session } = createDualEngine([codex, claude], { maxSteps: 3 });
  try {
    engine.startTeamRun("Implement merge sort with tests");
    await waitForRunStatus(engine, "done", 10_000);

    assert.equal(codex.calls.length, 2, "codex: plan + 1 implement dispatch");
    assert.equal(claude.calls.length, 1, "claude: plan review only — implement skipped");

    const status = engine.teamStatus();
    assert.ok(status);
    assert.equal(status.run.stepCount, 3);
    assert.match(status.run.finalSummary ?? "", /skipped agents: claude/);
    const implSteps = session
      .listTeamSteps(status.run.id, 10)
      .filter((s) => s.stage === "implement");
    assert.equal(implSteps.length, 1);
  } finally {
    await engine.shutdown();
    store.close();
  }
});

test("limits: resumed run with exhausted noProgress budget finalizes immediately", async () => {
  const codex = makeSequentialAdapter("codex", []);
  const claude = makeSequentialAdapter("claude", []);
  const { engine, store, session } = createDualEngine([codex, claude], {
    maxNoProgressSteps: 2,
  });
  try {
    // Adapters return non-plan fallback text, so planning yields no plan and the run fails
    const run = engine.startTeamRun("Stalling goal");
    await waitForRunStatus(engine, "failed", 5_000);

    // Simulate a stale active run that already burned its no-progress budget
    session.updateTeamRunStatus(run.id, "active", {});
    session.updateTeamRunProgress(run.id, { noProgressCount: 2 });
    const callsBefore = codex.calls.length + claude.calls.length;

    const resumed = engine.teamResume();
    assert.ok(resumed);
    await waitForRunStatus(engine, "waiting_user_input", 5_000);

    const status = engine.teamStatus();
    assert.ok(status);
    assert.match(status.run.finalSummary ?? "", /Team limits reached: no progress/);
    assert.equal(
      codex.calls.length + claude.calls.length,
      callsBefore,
      "resume must not dispatch when the no-progress budget is exhausted",
    );
  } finally {
    await engine.shutdown();
    store.close();
  }
});

test("full cycle: single agent skips negotiation", async () => {
  const solo = makeSequentialAdapter("solo", [
    "Completed the task.\nTEAM_DONE",
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

  try {
    engine.startTeamRun("Do everything");

    await waitForRunStatus(engine, "done", 5_000);

    assert.equal(solo.calls.length, 1, "solo: 1 execution call (no negotiation)");
  } finally {
    await engine.shutdown();
    store.close();
  }
});
