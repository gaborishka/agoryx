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

// Helper to create engine with 2 adapters
const createDualEngine = (
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
    await waitForRunStatus(engine, "waiting_user_input", 10_000);

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

    await waitForRunStatus(engine, "waiting_user_input", 5_000);

    assert.equal(solo.calls.length, 1, "solo: 1 execution call (no negotiation)");
  } finally {
    await engine.shutdown();
    store.close();
  }
});
