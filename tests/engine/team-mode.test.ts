import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { SQLiteStore } from "../../internal/storage/sqlite.js";
import { SessionService } from "../../internal/session/service.js";
import { ChatEngine } from "../../internal/engine/chat.js";
import type {
  AdapterEvent,
  AgentInput,
  PersistentAdapter,
  SendTurnInput,
} from "../../internal/adapters/adapter.js";
import {
  messageCompleted,
  messageError,
  messageStarted,
  sessionBound,
} from "../../internal/adapters/event-factory.js";
import { createId } from "../../internal/session/ids.js";
import type { ChatRuntimeConfig } from "../../internal/config/default.js";

const makeAdapter = (
  name: string,
  delayMs = 0,
  textFactory?: (callIndex: number) => string,
): PersistentAdapter & { calls: SendTurnInput[] } => {
  const calls: SendTurnInput[] = [];
  return {
    name,
    calls,
    async *send() {
      throw new Error("send() should not be used in team tests");
    },
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
        text: textFactory ? textFactory(calls.length) : `response-${calls.length}`,
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
    async health() {
      return "ready" as const;
    },
  };
};

const createEngine = (
  adapter: PersistentAdapter,
  options: { maxSteps?: number; maxDurationMs?: number; adapterMode?: "cli" | "agentic" } = {},
) => {
  const store = new SQLiteStore(":memory:");
  store.init();
  const session = new SessionService(store);
  const config: ChatRuntimeConfig = {
    dbPath: ":memory:",
    mode: "team",
    roomName: "team-room",
    agents: [adapter.name],
    roomConfig: {
      mode: "team",
      checkpointThreshold: 50,
      maxHistoryMessages: 100,
      maxContextTokens: 30_000,
    },
    adapterConfig: {
      [adapter.name]: {
        mode: options.adapterMode ?? "agentic",
        timeoutMs: 30_000,
        maxTokens: 4_000,
      },
    },
    team: {
      profile: "enthusiast",
      maxSteps: options.maxSteps ?? 1,
      maxNoProgressSteps: 2,
      maxDurationMs: options.maxDurationMs ?? 900_000,
      checksEnabledByDefault: true,
      checkCommands: ["npm run typecheck", "npm test"],
      strict: {
        maxSteps: 8,
        maxNoProgressSteps: 2,
        maxDurationMs: 900_000,
        checksEnabledByDefault: true,
      },
      finalGate: "proposal",
      singleActive: true,
      trigger: {
        autoOnMessage: true,
        commandStart: true,
      },
    },
    agentSkills: {},
  };

  const engine = new ChatEngine(session, { [adapter.name]: adapter }, config);
  engine.init();
  return { engine, store, session, config };
};

const waitForRunStatus = async (
  engine: ChatEngine,
  expected: "active" | "waiting_user_input" | "done" | "failed" | "stopped",
  runId?: string,
): Promise<void> => {
  for (let i = 0; i < 40; i++) {
    const status = engine.teamStatus(runId);
    if (status?.run.status === expected) {
      return;
    }
    await wait(25);
  }
  throw new Error(`timed out waiting for run status=${expected}`);
};

test("team mode auto-starts run and reaches proposal gate", async () => {
  const adapter = makeAdapter("claude");
  const { engine, store } = createEngine(adapter, { maxSteps: 1 });
  try {
    const results = await engine.processUserMessage("Build implementation proposal");
    assert.equal(results.length, 0);

    await waitForRunStatus(engine, "waiting_user_input");
    const status = engine.teamStatus();
    assert.ok(status);
    assert.equal(status.run.strategy, "debate");
    assert.ok(status.run.finalSummary);
    assert.equal(adapter.calls.length, 1); // debate step only
  } finally {
    await engine.shutdown();
    store.close();
  }
});

test("team approve transitions run from waiting_user_input to done", async () => {
  const adapter = makeAdapter("claude");
  const { engine, store } = createEngine(adapter, { maxSteps: 1 });
  try {
    await engine.processUserMessage("Prepare rollout plan");
    await waitForRunStatus(engine, "waiting_user_input");

    const approved = engine.teamApprove();
    assert.ok(approved);
    assert.equal(approved.status, "done");
  } finally {
    await engine.shutdown();
    store.close();
  }
});

test("active run queues feedback messages", async () => {
  const adapter = makeAdapter("claude", 200, () => "still working\nTEAM_NEXT:claude");
  const { engine, store } = createEngine(adapter, { maxSteps: 8 });
  try {
    await engine.processUserMessage("Start deep debate");
    await waitForRunStatus(engine, "active");

    const queued = await engine.processUserMessage("Please focus on migration risk.");
    assert.equal(queued.length, 0);

    const status = engine.teamStatus();
    assert.ok(status);
    assert.equal(status.pendingFeedback > 0, true);
  } finally {
    await engine.shutdown();
    store.close();
  }
});

test("waiting_user_input run does not enqueue team feedback", async () => {
  const adapter = makeAdapter("claude");
  const { engine, store } = createEngine(adapter, { maxSteps: 1 });
  try {
    await engine.processUserMessage("Prepare rollout plan");
    await waitForRunStatus(engine, "waiting_user_input");

    const before = engine.teamStatus();
    assert.ok(before);
    assert.equal(before.pendingFeedback, 0);

    const queued = await engine.processUserMessage("Need one more revision before approval.");
    assert.equal(queued.length, 0);

    const after = engine.teamStatus();
    assert.ok(after);
    assert.equal(after.run.status, "waiting_user_input");
    assert.equal(after.pendingFeedback, 0);
  } finally {
    await engine.shutdown();
    store.close();
  }
});

test("waiting_user_input run allows direct @mention dispatch", async () => {
  const adapter = makeAdapter("claude");
  const { engine, store } = createEngine(adapter, { maxSteps: 1 });
  try {
    await engine.processUserMessage("Prepare rollout plan");
    await waitForRunStatus(engine, "waiting_user_input");

    const before = engine.teamStatus();
    assert.ok(before);
    assert.equal(before.pendingFeedback, 0);
    assert.equal(adapter.calls.length, 1);

    const results = await engine.processUserMessage("@claude what do you think?");
    assert.equal(results.length, 1);
    assert.equal(results[0]?.adapter, "claude");
    assert.equal(results[0]?.success, true);
    assert.equal(adapter.calls.length, 2);

    const after = engine.teamStatus();
    assert.ok(after);
    assert.equal(after.run.status, "waiting_user_input");
    assert.equal(after.pendingFeedback, 0);
  } finally {
    await engine.shutdown();
    store.close();
  }
});

test("shutdown interrupts active team step before awaiting loop completion", async () => {
  const stalledByRequest = new Map<string, () => void>();
  const cancelledRequests = new Set<string>();
  const adapter: PersistentAdapter = {
    name: "claude",
    async *send() {
      throw new Error("send() should not be used in team tests");
    },
    async *sendTurn(input: SendTurnInput): AsyncGenerator<AdapterEvent> {
      const base = {
        roomId: input.roomId,
        sessionId: input.sessionId,
        requestId: input.requestId,
        source: "adapter.claude",
      };
      const startedPayload = {
        messageId: createId("msg"),
        author: "agent.claude",
        role: "assistant" as const,
        text: "",
        format: "markdown" as const,
        metadata: { provider: "test", model: "test", requestId: input.requestId },
      };

      yield messageStarted(base, startedPayload);
      yield sessionBound(base, "native-session");

      await new Promise<void>((resolve) => {
        stalledByRequest.set(input.requestId, resolve);
      });

      if (cancelledRequests.has(input.requestId)) {
        yield messageError(base, "PROCESS_CRASH", "cancelled by user");
        return;
      }

      yield messageCompleted(base, {
        ...startedPayload,
        text: "done\nTEAM_DONE",
      });
    },
    async cancel(requestId: string) {
      cancelledRequests.add(requestId);
      stalledByRequest.get(requestId)?.();
    },
    async health() {
      return "ready" as const;
    },
  };

  const { engine, store } = createEngine(adapter, { maxSteps: 8, adapterMode: "agentic" });
  try {
    await engine.processUserMessage("Start long running team step");
    await waitForRunStatus(engine, "active");

    for (let i = 0; i < 40 && stalledByRequest.size === 0; i++) {
      await wait(25);
    }
    assert.equal(stalledByRequest.size > 0, true);

    await Promise.race([
      engine.shutdown(),
      wait(750).then(() => {
        throw new Error("shutdown timed out waiting for active team cancellation");
      }),
    ]);

    assert.equal(cancelledRequests.size > 0, true);
  } finally {
    await engine.shutdown();
    store.close();
  }
});

test("interruptTeamRun cancels active step and injects feedback into the next step", async () => {
  const calls: SendTurnInput[] = [];
  const stalledByRequest = new Map<string, () => void>();
  const cancelledRequests = new Set<string>();
  const adapter: PersistentAdapter = {
    name: "claude",
    async *send() {
      throw new Error("send() should not be used in team tests");
    },
    async *sendTurn(input: SendTurnInput): AsyncGenerator<AdapterEvent> {
      calls.push(input);
      const base = {
        roomId: input.roomId,
        sessionId: input.sessionId,
        requestId: input.requestId,
        source: "adapter.claude",
      };
      const startedPayload = {
        messageId: createId("msg"),
        author: "agent.claude",
        role: "assistant" as const,
        text: "",
        format: "markdown" as const,
        metadata: { provider: "test", model: "test", requestId: input.requestId },
      };

      yield messageStarted(base, startedPayload);
      yield sessionBound(base, "native-session");

      if (calls.length === 1) {
        if (cancelledRequests.has(input.requestId)) {
          yield messageError(base, "PROCESS_CRASH", "cancelled by user");
          return;
        }
        await new Promise<void>((resolve) => {
          stalledByRequest.set(input.requestId, resolve);
          if (cancelledRequests.has(input.requestId)) {
            resolve();
          }
        });
        if (cancelledRequests.has(input.requestId)) {
          yield messageError(base, "PROCESS_CRASH", "cancelled by user");
          return;
        }
      }

      const text = calls.length === 2 ? "Adjusted plan\nTEAM_DONE" : "Final summary";
      yield messageCompleted(base, {
        ...startedPayload,
        text,
      });
    },
    async cancel(requestId: string) {
      cancelledRequests.add(requestId);
      stalledByRequest.get(requestId)?.();
    },
    async health() {
      return "ready" as const;
    },
  };

  const { engine, store } = createEngine(adapter, { maxSteps: 8, adapterMode: "agentic" });
  try {
    await engine.processUserMessage("Start deep debate");
    await waitForRunStatus(engine, "active");

    for (let i = 0; i < 40 && calls.length === 0; i++) {
      await wait(25);
    }
    assert.ok(calls.length > 0);

    const interrupted = await engine.interruptTeamRun("Please focus on rollback risk.");
    assert.ok(interrupted);
    assert.equal(interrupted.interrupted, true);
    assert.equal(interrupted.feedbackQueued, true);

    await waitForRunStatus(engine, "waiting_user_input");
    assert.equal(calls.length, 2);
    assert.match(calls[1]!.prompt, /Please focus on rollback risk\./);
  } finally {
    await engine.shutdown();
    store.close();
  }
});

test("interrupt does not drop feedback that was pending before aborted step", async () => {
  const calls: SendTurnInput[] = [];
  const stalledByRequest = new Map<string, () => void>();
  const cancelledRequests = new Set<string>();
  const adapter: PersistentAdapter = {
    name: "claude",
    async *send() {
      throw new Error("send() should not be used in team tests");
    },
    async *sendTurn(input: SendTurnInput): AsyncGenerator<AdapterEvent> {
      calls.push(input);
      const base = {
        roomId: input.roomId,
        sessionId: input.sessionId,
        requestId: input.requestId,
        source: "adapter.claude",
      };
      const startedPayload = {
        messageId: createId("msg"),
        author: "agent.claude",
        role: "assistant" as const,
        text: "",
        format: "markdown" as const,
        metadata: { provider: "test", model: "test", requestId: input.requestId },
      };

      yield messageStarted(base, startedPayload);
      yield sessionBound(base, "native-session");

      if (calls.length === 1) {
        await new Promise<void>((resolve) => {
          stalledByRequest.set(input.requestId, resolve);
          if (cancelledRequests.has(input.requestId)) {
            resolve();
          }
        });
        if (cancelledRequests.has(input.requestId)) {
          yield messageError(base, "PROCESS_CRASH", "cancelled by user");
          return;
        }
      }

      yield messageCompleted(base, {
        ...startedPayload,
        text: "continue\nTEAM_DONE",
      });
    },
    async cancel(requestId: string) {
      cancelledRequests.add(requestId);
      stalledByRequest.get(requestId)?.();
    },
    async health() {
      return "ready" as const;
    },
  };

  const { engine, store, session } = createEngine(adapter, {
    maxSteps: 8,
    adapterMode: "agentic",
  });
  try {
    const roomId = engine.getState().room.id;
    const run = session.createTeamRun({
      roomId,
      strategy: "debate",
      goal: "Investigate failure and include rollback plan.",
      participants: ["claude"],
      maxSteps: 8,
      maxNoProgressSteps: 2,
      maxDurationMs: 900_000,
      checksEnabled: true,
      createdBy: "user",
    });
    const message = session.saveUserMessage(roomId, "Please keep rollback plan in scope.");
    session.enqueueTeamFeedback(run.id, message.id, message.text);

    const resumed = engine.teamResume();
    assert.ok(resumed);

    for (let i = 0; i < 40 && calls.length === 0; i++) {
      await wait(25);
    }
    assert.ok(calls.length > 0);

    const interrupted = await engine.interruptTeamRun(undefined, run.id);
    assert.ok(interrupted);
    assert.equal(interrupted.interrupted, true);

    await waitForRunStatus(engine, "waiting_user_input", run.id);
    assert.equal(calls.length, 2);
    assert.match(calls[1]!.prompt, /Please keep rollback plan in scope\./);
  } finally {
    await engine.shutdown();
    store.close();
  }
});

test("team run completes after one debate step when no TEAM_NEXT is emitted", async () => {
  const adapter = makeAdapter("claude");
  const { engine, store } = createEngine(adapter, { maxSteps: 8 });
  try {
    await engine.processUserMessage("Quick sync test");
    await waitForRunStatus(engine, "waiting_user_input");
    const status = engine.teamStatus();
    assert.ok(status);
    assert.equal(status.run.stepCount, 1); // debate only
    assert.equal(adapter.calls.length, 1);
  } finally {
    await engine.shutdown();
    store.close();
  }
});

test("TEAM_DONE control line completes run immediately", async () => {
  const adapter = makeAdapter(
    "claude",
    0,
    (index) => (index === 1 ? "work complete\nTEAM_DONE" : "final summary"),
  );
  const { engine, store } = createEngine(adapter, { maxSteps: 8 });
  try {
    await engine.processUserMessage("Finish and stop");
    await waitForRunStatus(engine, "waiting_user_input");
    const status = engine.teamStatus();
    assert.ok(status);
    assert.equal(status.run.stepCount, 1); // debate only
    assert.equal(adapter.calls.length, 1);
  } finally {
    await engine.shutdown();
    store.close();
  }
});

test("team run marks dispatch errors as failed", async () => {
  const adapter: PersistentAdapter = {
    name: "claude",
    async *send() {
      throw new Error("send() should not be used in team tests");
    },
    async *sendTurn(input: SendTurnInput): AsyncGenerator<AdapterEvent> {
      const base = {
        roomId: input.roomId,
        sessionId: input.sessionId,
        requestId: input.requestId,
        source: "adapter.claude",
      };
      const startedPayload = {
        messageId: createId("msg"),
        author: "agent.claude",
        role: "assistant" as const,
        text: "",
        format: "markdown" as const,
        metadata: { provider: "test", model: "test", requestId: input.requestId },
      };

      yield messageStarted(base, startedPayload);
      yield sessionBound(base, "native-session");
      yield messageError(base, "PROCESS_CRASH", "worker crashed");
    },
    async cancel() {},
    async health() {
      return "ready" as const;
    },
  };

  const { engine, store } = createEngine(adapter, { maxSteps: 8, adapterMode: "agentic" });
  try {
    const run = engine.startTeamRun("Investigate failure path");
    await waitForRunStatus(engine, "failed", run.id);

    const status = engine.teamStatus(run.id);
    assert.ok(status);
    assert.equal(status.run.status, "failed");
    assert.match(status.run.finalSummary ?? "", /PROCESS_CRASH: worker crashed/);
  } finally {
    await engine.shutdown();
    store.close();
  }
});

test("team run retries after recoverable dispatch errors", async () => {
  let callCount = 0;
  const adapter: PersistentAdapter = {
    name: "claude",
    async *send() {
      throw new Error("send() should not be used in team tests");
    },
    async *sendTurn(input: SendTurnInput): AsyncGenerator<AdapterEvent> {
      callCount += 1;
      const base = {
        roomId: input.roomId,
        sessionId: input.sessionId,
        requestId: input.requestId,
        source: "adapter.claude",
      };
      const startedPayload = {
        messageId: createId("msg"),
        author: "agent.claude",
        role: "assistant" as const,
        text: "",
        format: "markdown" as const,
        metadata: { provider: "test", model: "test", requestId: input.requestId },
      };

      yield messageStarted(base, startedPayload);
      yield sessionBound(base, "native-session");
      if (callCount === 1) {
        yield messageError(base, "TIMEOUT", "temporary timeout");
        return;
      }
      yield messageCompleted(base, {
        ...startedPayload,
        text: "Recovered and completed\nTEAM_DONE",
      });
    },
    async cancel() {},
    async health() {
      return "ready" as const;
    },
  };

  const { engine, store } = createEngine(adapter, { maxSteps: 8, adapterMode: "agentic" });
  try {
    const run = engine.startTeamRun("Recover after transient timeout");
    await waitForRunStatus(engine, "waiting_user_input", run.id);
    const status = engine.teamStatus(run.id);
    assert.ok(status);
    assert.equal(status.run.status, "waiting_user_input");
    assert.equal(callCount >= 2, true);

    const steps = store.listTeamSteps(run.id, 10);
    assert.equal(steps.length >= 2, true);
    assert.equal(steps[0]?.result, "error");
    assert.equal(steps[0]?.errorClass, "TIMEOUT");
    assert.equal(steps[steps.length - 1]?.result, "ok");
  } finally {
    await engine.shutdown();
    store.close();
  }
});

test("strict flag applies strict team limits", async () => {
  const adapter = makeAdapter("claude");
  const { engine, store } = createEngine(adapter, { maxSteps: 24 });
  try {
    const run = engine.startTeamRun("strict run", { strict: true });
    assert.equal(run.maxSteps, 8);
    assert.equal(run.maxNoProgressSteps, 2);
    assert.equal(run.maxDurationMs, 900_000);
  } finally {
    await engine.shutdown();
    store.close();
  }
});

test("team run promotes cli adapter mode to agentic dispatch", async () => {
  const adapter = makeAdapter("claude");
  const { engine, store } = createEngine(adapter, { maxSteps: 1, adapterMode: "cli" });
  try {
    await engine.processUserMessage("Draft architecture summary");
    await waitForRunStatus(engine, "waiting_user_input");
    assert.equal(adapter.calls.length, 1); // debate step only
  } finally {
    await engine.shutdown();
    store.close();
  }
});

test("team run restores adapter config when createTeamRun fails", async () => {
  const adapter = makeAdapter("claude");
  const { engine, store, session, config } = createEngine(adapter, {
    maxSteps: 1,
    adapterMode: "cli",
  });
  try {
    config.adapterConfig.claude.workspaceCwd = "/tmp/agoryx-original-workspace";

    const originalCreateTeamRun = session.createTeamRun.bind(session);
    try {
      (session as unknown as { createTeamRun: typeof originalCreateTeamRun }).createTeamRun = (() => {
        throw new Error("forced createTeamRun failure");
      }) as typeof originalCreateTeamRun;

      assert.throws(() => {
        engine.startTeamRun("Trigger failure");
      }, /forced createTeamRun failure/);

      assert.equal(config.adapterConfig.claude.mode, "cli");
      assert.equal(
        config.adapterConfig.claude.workspaceCwd,
        "/tmp/agoryx-original-workspace",
      );
    } finally {
      (session as unknown as { createTeamRun: typeof originalCreateTeamRun }).createTeamRun =
        originalCreateTeamRun;
    }
  } finally {
    await engine.shutdown();
    store.close();
  }
});

test("team run fails with explicit config error when adapter config is missing", async () => {
  const adapter = makeAdapter("claude");
  const { engine, store, config } = createEngine(adapter, { maxSteps: 8, adapterMode: "agentic" });
  try {
    delete (config.adapterConfig as Record<string, unknown>).claude;
    const run = engine.startTeamRun("Missing config path");

    await waitForRunStatus(engine, "failed", run.id);
    const status = engine.teamStatus(run.id);
    assert.ok(status);
    assert.match(status.run.finalSummary ?? "", /CONFIG_ERROR/i);
  } finally {
    await engine.shutdown();
    store.close();
  }
});

test("setMode stops active team run before leaving team mode", async () => {
  const stalledByRequest = new Map<string, () => void>();
  const cancelledRequests = new Set<string>();
  const adapter: PersistentAdapter = {
    name: "claude",
    async *send() {
      throw new Error("send() should not be used in team tests");
    },
    async *sendTurn(input: SendTurnInput): AsyncGenerator<AdapterEvent> {
      const base = {
        roomId: input.roomId,
        sessionId: input.sessionId,
        requestId: input.requestId,
        source: "adapter.claude",
      };
      const startedPayload = {
        messageId: createId("msg"),
        author: "agent.claude",
        role: "assistant" as const,
        text: "",
        format: "markdown" as const,
        metadata: { provider: "test", model: "test", requestId: input.requestId },
      };

      yield messageStarted(base, startedPayload);
      yield sessionBound(base, "native-session");
      await new Promise<void>((resolve) => {
        stalledByRequest.set(input.requestId, resolve);
      });
      if (cancelledRequests.has(input.requestId)) {
        yield messageError(base, "PROCESS_CRASH", "cancelled by mode switch");
        return;
      }
      yield messageCompleted(base, {
        ...startedPayload,
        text: "TEAM_DONE",
      });
    },
    async cancel(requestId: string) {
      cancelledRequests.add(requestId);
      stalledByRequest.get(requestId)?.();
    },
    async health() {
      return "ready" as const;
    },
  };

  const { engine, store } = createEngine(adapter, { maxSteps: 8, adapterMode: "agentic" });
  try {
    const run = engine.startTeamRun("Long running run");
    await waitForRunStatus(engine, "active", run.id);
    for (let i = 0; i < 40 && stalledByRequest.size === 0; i++) {
      await wait(25);
    }
    assert.equal(stalledByRequest.size > 0, true);

    engine.setMode("manual");
    await waitForRunStatus(engine, "stopped", run.id);
    assert.equal(cancelledRequests.size > 0, true);
  } finally {
    await engine.shutdown();
    store.close();
  }
});

test("team run restores adapter mode after completion", async () => {
  let sendCalls = 0;
  let sendTurnCalls = 0;
  const adapter: PersistentAdapter = {
    name: "claude",
    async *send(input: AgentInput): AsyncGenerator<AdapterEvent> {
      sendCalls += 1;
      const base = {
        roomId: input.roomId,
        sessionId: input.sessionId,
        requestId: input.requestId,
        source: "adapter.claude",
      };
      const payload = {
        messageId: createId("msg"),
        author: "agent.claude",
        role: "assistant" as const,
        text: "manual response",
        format: "markdown" as const,
        metadata: { provider: "test", model: "test", requestId: input.requestId },
      };
      yield messageStarted(base, { ...payload, text: "" });
      yield messageCompleted(base, payload);
    },
    async *sendTurn(input: SendTurnInput): AsyncGenerator<AdapterEvent> {
      sendTurnCalls += 1;
      const base = {
        roomId: input.roomId,
        sessionId: input.sessionId,
        requestId: input.requestId,
        source: "adapter.claude",
      };
      const payload = {
        messageId: createId("msg"),
        author: "agent.claude",
        role: "assistant" as const,
        text: "team response\nTEAM_DONE",
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

  const { engine, store } = createEngine(adapter, { maxSteps: 1, adapterMode: "cli" });
  try {
    await engine.processUserMessage("Draft architecture summary");
    await waitForRunStatus(engine, "waiting_user_input");
    assert.equal(sendTurnCalls, 1);

    engine.setMode("manual");
    await engine.processUserMessage("@claude quick follow-up");
    assert.equal(sendCalls, 1);
    assert.equal(sendTurnCalls, 1);
  } finally {
    await engine.shutdown();
    store.close();
  }
});

test("team prompt uses newest user context tail", async () => {
  const adapter = makeAdapter("claude");
  const { engine, store } = createEngine(adapter, { maxSteps: 1, adapterMode: "agentic" });
  try {
    engine.setMode("manual");
    for (let i = 1; i <= 30; i++) {
      await engine.processUserMessage(`seed-message-${i}`);
    }

    engine.setMode("team");
    await engine.processUserMessage("start team runtime");
    await waitForRunStatus(engine, "waiting_user_input");

    const prompt = adapter.calls[0]?.prompt ?? "";
    assert.match(prompt, /seed-message-30/);
    assert.match(prompt, /seed-message-25/);
    assert.doesNotMatch(prompt, /seed-message-1/);
  } finally {
    await engine.shutdown();
    store.close();
  }
});

test("team run sanitizes noisy assistant output", async () => {
  const calls: SendTurnInput[] = [];
  const adapter: PersistentAdapter = {
    name: "claude",
    async *send() {
      throw new Error("send() should not be used in team tests");
    },
    async *sendTurn(input: SendTurnInput): AsyncGenerator<AdapterEvent> {
      calls.push(input);
      const base = {
        roomId: input.roomId,
        sessionId: input.sessionId,
        requestId: input.requestId,
        source: "adapter.claude",
      };
      const payload = {
        messageId: createId("msg"),
        author: "agent.claude",
        role: "assistant" as const,
        text:
          "1→# noisy dump\n" +
          "I’ll read docs and run grep first.\n" +
          "<system-reminder>ignore this</system-reminder>\n" +
          "Final clean answer",
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

  const { engine, store } = createEngine(adapter, { maxSteps: 1, adapterMode: "agentic" });
  try {
    await engine.processUserMessage("Write a concise update");
    await waitForRunStatus(engine, "waiting_user_input");

    const log = engine.teamLog(10);
    assert.ok(log);
    const combined = log.steps.map((step) => step.outputText).join("\n");
    assert.equal(combined.includes("<system-reminder>"), false);
    assert.equal(/\n?\s*\d+→/.test(combined), false);
    assert.equal(/i.?ll read docs/i.test(combined), false);
    assert.equal(combined.includes("Final clean answer"), true);
  } finally {
    await engine.shutdown();
    store.close();
  }
});

test("team auto-start honors @mention for first actor", async () => {
  const codex = makeAdapter("codex");
  const claude = makeAdapter("claude");
  const store = new SQLiteStore(":memory:");
  store.init();
  const session = new SessionService(store);
  const config: ChatRuntimeConfig = {
    dbPath: ":memory:",
    mode: "team",
    roomName: "team-room",
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
      maxSteps: 1,
      maxNoProgressSteps: 2,
      maxDurationMs: 900_000,
      checksEnabledByDefault: false,
      checkCommands: ["npm run typecheck", "npm test"],
      strict: {
        maxSteps: 8,
        maxNoProgressSteps: 2,
        maxDurationMs: 900_000,
        checksEnabledByDefault: true,
      },
      finalGate: "proposal",
      singleActive: true,
      trigger: {
        autoOnMessage: true,
        commandStart: true,
      },
    },
    agentSkills: {},
  };

  const engine = new ChatEngine(session, { codex, claude }, config);
  engine.init();
  try {
    await engine.processUserMessage("@claude review the docs");
    await waitForRunStatus(engine, "waiting_user_input");
    assert.equal(codex.calls.length, 0);
    assert.equal(claude.calls.length, 1);
  } finally {
    await engine.shutdown();
    store.close();
  }
});

test("@all in team goal forces at least one turn from each agent", async () => {
  const codex = makeAdapter("codex", 0, () => "Codex summary\nTEAM_DONE");
  const claude = makeAdapter("claude", 0, () => "Claude summary\nTEAM_DONE");
  const store = new SQLiteStore(":memory:");
  store.init();
  const session = new SessionService(store);
  const config: ChatRuntimeConfig = {
    dbPath: ":memory:",
    mode: "team",
    roomName: "team-room",
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
      maxSteps: 1,
      maxNoProgressSteps: 2,
      maxDurationMs: 900_000,
      checksEnabledByDefault: false,
      checkCommands: ["npm run typecheck", "npm test"],
      strict: {
        maxSteps: 8,
        maxNoProgressSteps: 2,
        maxDurationMs: 900_000,
        checksEnabledByDefault: true,
      },
      finalGate: "proposal",
      singleActive: true,
      trigger: {
        autoOnMessage: true,
        commandStart: true,
      },
    },
    agentSkills: {},
  };

  const engine = new ChatEngine(session, { codex, claude }, config);
  engine.init();
  try {
    await engine.processUserMessage("@all describe this repo");
    await waitForRunStatus(engine, "waiting_user_input");

    assert.equal(codex.calls.length, 1);
    assert.equal(claude.calls.length, 1);
    const log = engine.teamLog(10);
    assert.ok(log);
    assert.equal(log.run.stepCount, 2);
  } finally {
    await engine.shutdown();
    store.close();
  }
});
