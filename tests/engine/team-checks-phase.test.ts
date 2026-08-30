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

const makeSoloAdapter = (
  name: string,
  text: string,
): PersistentAdapter & { calls: SendTurnInput[] } => {
  const calls: SendTurnInput[] = [];
  return {
    name,
    calls,
    async *send() { throw new Error("unused"); },
    async *sendTurn(input: SendTurnInput): AsyncGenerator<AdapterEvent> {
      calls.push(input);
      const base = {
        roomId: input.roomId,
        sessionId: input.sessionId,
        requestId: input.requestId,
        source: `adapter.${name}`,
      };
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

const createSoloEngine = (
  adapter: PersistentAdapter,
  options: { checksEnabledByDefault?: boolean; checkCommands?: string[] } = {},
) => {
  const store = new SQLiteStore(":memory:");
  store.init();
  const session = new SessionService(store);
  const config: ChatRuntimeConfig = {
    dbPath: ":memory:",
    mode: "team",
    roomName: "checks-room",
    agents: [adapter.name],
    roomConfig: {
      mode: "team",
      checkpointThreshold: 50,
      maxHistoryMessages: 100,
      maxContextTokens: 30_000,
    },
    adapterConfig: {
      [adapter.name]: { mode: "agentic", timeoutMs: 30_000, maxTokens: 4_000 },
    },
    team: {
      profile: "enthusiast",
      maxSteps: 10,
      maxNoProgressSteps: 5,
      maxDurationMs: 900_000,
      checksEnabledByDefault: options.checksEnabledByDefault ?? true,
      checkCommands: options.checkCommands ?? [],
      strict: { maxSteps: 8, maxNoProgressSteps: 2, maxDurationMs: 900_000, checksEnabledByDefault: true },
      finalGate: "proposal",
      singleActive: true,
      trigger: { autoOnMessage: true, commandStart: true },
    },
    agentSkills: {},
  };
  const engine = new ChatEngine(session, { [adapter.name]: adapter }, config);
  engine.init();
  return { engine, store, session };
};

const waitForRunStatus = async (
  engine: ChatEngine,
  expected: string,
  timeoutMs = 10_000,
): Promise<void> => {
  for (let i = 0; i < timeoutMs / 25; i++) {
    const status = engine.teamStatus();
    if (status?.run.status === expected) return;
    await wait(25);
  }
  throw new Error(`timed out waiting for run status=${expected}`);
};

const IMPLEMENT_OUTPUT =
  "Implemented the requested changes across the assigned files with tests and documentation.";

test("checks phase records passed and failed commands and reports in summary", async () => {
  const solo = makeSoloAdapter("solo", IMPLEMENT_OUTPUT);
  const { engine, store, session } = createSoloEngine(solo, {
    checksEnabledByDefault: true,
    // node is guaranteed present in the test environment; no shell involved
    checkCommands: ["node --version", "node -e process.exit(3)"],
  });
  try {
    const run = engine.startTeamRun("Ship the feature");
    await waitForRunStatus(engine, "done");

    const checks = session.listTeamChecks(run.id, 10);
    assert.equal(checks.length, 2, "one record per check command");

    const passed = checks.find((c) => c.command === "node --version");
    assert.ok(passed);
    assert.equal(passed.status, "passed");
    assert.equal(passed.exitCode, 0);

    const failed = checks.find((c) => c.command === "node -e process.exit(3)");
    assert.ok(failed);
    assert.equal(failed.status, "failed");
    assert.equal(failed.exitCode, 3);

    const implStep = session
      .listTeamSteps(run.id, 10)
      .find((s) => s.stage === "implement");
    assert.ok(implStep);
    assert.equal(failed.stepId, null, "no worktree isolation: checks are not per-agent");

    const status = engine.teamStatus();
    assert.ok(status);
    assert.match(status.run.finalSummary ?? "", /Checks: 1 passed, 1 failed/);
    assert.match(status.run.finalSummary ?? "", /node -e process\.exit\(3\) \(failed, exit 3\)/);
  } finally {
    await engine.shutdown();
    store.close();
  }
});

test("checks phase is skipped when checksEnabled is false", async () => {
  const solo = makeSoloAdapter("solo", IMPLEMENT_OUTPUT);
  const { engine, store, session } = createSoloEngine(solo, {
    checksEnabledByDefault: false,
    checkCommands: ["node --version"],
  });
  try {
    const run = engine.startTeamRun("Ship the feature");
    await waitForRunStatus(engine, "done");

    assert.equal(session.listTeamChecks(run.id, 10).length, 0);
    const status = engine.teamStatus();
    assert.ok(status);
    assert.doesNotMatch(status.run.finalSummary ?? "", /Checks:/);
  } finally {
    await engine.shutdown();
    store.close();
  }
});

test("checks phase is skipped when no check commands are configured", async () => {
  const solo = makeSoloAdapter("solo", IMPLEMENT_OUTPUT);
  const { engine, store, session } = createSoloEngine(solo, {
    checksEnabledByDefault: true,
    checkCommands: [],
  });
  try {
    const run = engine.startTeamRun("Ship the feature");
    await waitForRunStatus(engine, "done");

    assert.equal(session.listTeamChecks(run.id, 10).length, 0);
    const status = engine.teamStatus();
    assert.ok(status);
    assert.doesNotMatch(status.run.finalSummary ?? "", /Checks:/);
  } finally {
    await engine.shutdown();
    store.close();
  }
});
