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
import type { WorktreeManager } from "../../internal/worktree/manager.js";

// Workspace context collection is irrelevant to these tests
const WORKSPACE_DISABLED = {
  enabled: false,
  maxContextTokens: 0,
  statusLines: 0,
  diffLines: 0,
  treeLines: 0,
  pinnedDocCharsPerFile: 0,
};

const makeSoloAdapter = (
  name: string,
  text: string,
  delayMs = 0,
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
      if (delayMs > 0) {
        await wait(delayMs);
      }
      yield messageCompleted(base, payload);
    },
    async cancel() {},
    async health() { return "ready" as const; },
  };
};

const createSoloEngine = (
  adapter: PersistentAdapter,
  options: {
    checksEnabledByDefault?: boolean;
    checkCommands?: string[];
    maxDurationMs?: number;
  } = {},
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
      maxDurationMs: options.maxDurationMs ?? 900_000,
      checksEnabledByDefault: options.checksEnabledByDefault ?? true,
      checkCommands: options.checkCommands ?? [],
      strict: { maxSteps: 8, maxNoProgressSteps: 2, maxDurationMs: 900_000, checksEnabledByDefault: true },
      finalGate: "proposal",
      singleActive: true,
      trigger: { autoOnMessage: true, commandStart: true },
    },
    agentSkills: {},
    workspace: { ...WORKSPACE_DISABLED },
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

test("checks are skipped when the duration limit is exceeded during implement", async () => {
  // Implement takes ~1.5s while maxDurationMs is 1s: the run passes the
  // pre-implement guards but is past its deadline when checks would start.
  const solo = makeSoloAdapter("solo", IMPLEMENT_OUTPUT, 1_500);
  const { engine, store, session } = createSoloEngine(solo, {
    checksEnabledByDefault: true,
    checkCommands: ["node --version"],
    maxDurationMs: 1_000,
  });
  try {
    const run = engine.startTeamRun("Ship the feature");
    await waitForRunStatus(engine, "done");

    assert.equal(session.listTeamChecks(run.id, 10).length, 0, "no check may run past the deadline");
    const status = engine.teamStatus();
    assert.ok(status);
    assert.match(status.run.finalSummary ?? "", /Checks skipped: run exceeded maxDurationMs/);
  } finally {
    await engine.shutdown();
    store.close();
  }
});

test("stopping the run aborts an in-flight check command", async () => {
  const solo = makeSoloAdapter("solo", IMPLEMENT_OUTPUT);
  const { engine, store, session } = createSoloEngine(solo, {
    checksEnabledByDefault: true,
    // Without an abort this check would hold the loop for 8 seconds
    checkCommands: ["node -e setTimeout(function(){},8000)"],
  });
  try {
    const run = engine.startTeamRun("Ship the feature");

    let reachedChecks = false;
    for (let i = 0; i < 300; i++) {
      if (engine.teamStatus()?.run.stage === "checks") {
        reachedChecks = true;
        break;
      }
      await wait(10);
    }
    await wait(50); // let the check child process spawn

    const stopStartedAt = Date.now();
    engine.teamStop(run.id);
    await engine.shutdown();
    const stopDurationMs = Date.now() - stopStartedAt;

    assert.ok(reachedChecks, "run must reach the checks stage");
    assert.ok(
      stopDurationMs < 4_000,
      `stop+shutdown took ${stopDurationMs}ms — the in-flight check was not aborted`,
    );
    assert.equal(engine.teamStatus()?.run.status, "stopped");
    assert.equal(
      session.listTeamChecks(run.id, 10).length,
      0,
      "an aborted check must not be persisted",
    );
  } finally {
    store.close();
  }
});

test("checks cover the main workspace when a worktree is missing for an agent", async () => {
  // Stub worktree manager: agent "solo" has no worktree (creation failed at
  // startRun), so the checks phase must fall back to the main workspace.
  const solo = makeSoloAdapter("solo", IMPLEMENT_OUTPUT);
  const store = new SQLiteStore(":memory:");
  store.init();
  const session = new SessionService(store);
  const stubWorktreeManager = {
    reconcile() {},
    create() {
      throw new Error("worktree creation unavailable in this test");
    },
    getForAgent() {
      return null;
    },
    getRepoRoot() {
      return process.cwd();
    },
    list() {
      return [];
    },
    merge() {
      return { success: true };
    },
  };
  const config = {
    dbPath: ":memory:",
    mode: "team",
    roomName: "checks-partial-room",
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
      checksEnabledByDefault: true,
      checkCommands: ["node --version"],
      strict: { maxSteps: 8, maxNoProgressSteps: 2, maxDurationMs: 900_000, checksEnabledByDefault: true },
      finalGate: "proposal",
      singleActive: true,
      trigger: { autoOnMessage: true, commandStart: true },
    },
    agentSkills: {},
    workspace: { ...WORKSPACE_DISABLED },
  } as unknown as ChatRuntimeConfig;
  const engine = new ChatEngine(
    session,
    { solo },
    config,
    {},
    undefined,
    stubWorktreeManager as unknown as WorktreeManager,
  );
  engine.init();
  try {
    const run = engine.startTeamRun("Ship the feature");
    await waitForRunStatus(engine, "done");

    const checks = session.listTeamChecks(run.id, 10);
    assert.equal(checks.length, 1, "main-workspace fallback must run the check");
    assert.equal(checks[0]!.status, "passed");
    assert.equal(checks[0]!.stepId, null, "fallback checks are not tied to an agent worktree step");
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
