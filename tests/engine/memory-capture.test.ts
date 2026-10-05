import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { SQLiteStore } from "../../internal/storage/sqlite.js";
import { SessionService } from "../../internal/session/service.js";
import { ChatEngine } from "../../internal/engine/chat.js";
import { MemoryService } from "../../internal/memory/service.js";
import type {
  AdapterEvent,
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
  options: { fail?: boolean; text?: string } = {},
): PersistentAdapter & { calls: SendTurnInput[] } => {
  const calls: SendTurnInput[] = [];
  return {
    name,
    calls,
    async *send() {
      throw new Error("send() should not be used in these tests");
    },
    async *sendTurn(input: SendTurnInput): AsyncGenerator<AdapterEvent> {
      calls.push(input);
      const base = {
        roomId: input.roomId,
        sessionId: input.sessionId,
        requestId: input.requestId,
        source: `adapter.${name}`,
      };

      if (options.fail) {
        yield messageError(base, "PROCESS_CRASH", "Adapter crashed");
        return;
      }

      const payload = {
        messageId: createId("msg"),
        author: `agent.${name}`,
        role: "assistant" as const,
        text: options.text ?? `response from ${name}`,
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

const createTestEngine = (
  adapter: PersistentAdapter,
  options: {
    mode?: "manual" | "team";
    maxSteps?: number;
    adapterMode?: "cli" | "agentic";
  } = {},
) => {
  const store = new SQLiteStore(":memory:");
  store.init();
  const session = new SessionService(store);
  const memoryService = new MemoryService(store);
  const config: ChatRuntimeConfig = {
    dbPath: ":memory:",
    mode: options.mode ?? "manual",
    roomName: "mem-test",
    agents: [adapter.name],
    roomConfig: {
      mode: options.mode ?? "manual",
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
      maxDurationMs: 900_000,
      checksEnabledByDefault: false,
      checkCommands: [],
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

  const engine = new ChatEngine(session, { [adapter.name]: adapter }, config, {}, memoryService);
  engine.init();
  return { engine, store, session, memoryService };
};

test("dispatch writes dispatch_start and dispatch_end to memory_log", async () => {
  const adapter = makeAdapter("codex");
  const { engine, store } = createTestEngine(adapter, { mode: "manual" });
  try {
    await engine.processUserMessage("@codex hello");

    const state = engine.getState();
    const events = store.listMemoryEvents(state.room.id);
    const types = events.map((e) => e.eventType);

    assert.ok(types.includes("dispatch_start"), "should have dispatch_start");
    assert.ok(types.includes("dispatch_end"), "should have dispatch_end");

    const start = events.find((e) => e.eventType === "dispatch_start")!;
    assert.equal(start.source, "engine");
    assert.equal((start.payload as any).agent, "codex");

    const end = events.find((e) => e.eventType === "dispatch_end")!;
    assert.equal(end.source, "engine");
    assert.equal((end.payload as any).agent, "codex");
    assert.equal((end.payload as any).result, "done");
  } finally {
    await engine.shutdown();
    store.close();
  }
});

test("failed dispatch writes error event to memory_log", async () => {
  const adapter = makeAdapter("codex", { fail: true });
  const { engine, store } = createTestEngine(adapter, { mode: "manual" });
  try {
    await engine.processUserMessage("@codex hello");

    const state = engine.getState();
    const events = store.listMemoryEvents(state.room.id);
    const types = events.map((e) => e.eventType);

    assert.ok(types.includes("dispatch_start"), "should have dispatch_start");
    assert.ok(types.includes("error"), "should have error event");

    const errorEvt = events.find((e) => e.eventType === "error")!;
    assert.equal(errorEvt.source, "engine");
    assert.equal((errorEvt.payload as any).agent, "codex");
    assert.ok((errorEvt.payload as any).error);
  } finally {
    await engine.shutdown();
    store.close();
  }
});

test("team step writes team_step event to memory_log", async () => {
  const adapter = makeAdapter("claude", {
    text: "I completed the task.\nTEAM_DONE",
  });
  const { engine, store } = createTestEngine(adapter, {
    mode: "team",
    maxSteps: 1,
  });
  try {
    await engine.processUserMessage("Build something");

    // Wait for team run to complete
    for (let i = 0; i < 40; i++) {
      const status = engine.teamStatus();
      if (status?.run.status === "waiting_user_input" || status?.run.status === "done") {
        break;
      }
      await wait(25);
    }

    const state = engine.getState();
    const events = store.listMemoryEvents(state.room.id);
    const types = events.map((e) => e.eventType);

    assert.ok(types.includes("team_step"), "should have team_step event");

    const step = events.find((e) => e.eventType === "team_step")!;
    assert.equal((step.payload as any).actor, "claude");
    assert.ok((step.payload as any).runId);
  } finally {
    await engine.shutdown();
    store.close();
  }
});
