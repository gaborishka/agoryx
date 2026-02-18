import test from "node:test";
import assert from "node:assert/strict";
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
  messageError,
  messageStarted,
  sessionBound,
} from "../../internal/adapters/event-factory.js";
import { createId } from "../../internal/session/ids.js";
import type { ChatRuntimeConfig } from "../../internal/config/default.js";

function makeStubPersistentAdapter(
  name: string,
  turns: Array<{
    text?: string;
    nativeSessionId?: string;
    errorClass?: "SESSION_EXPIRED" | "PROCESS_CRASH";
  }>,
): PersistentAdapter & { sendTurnCalls: SendTurnInput[]; destroyCalls: string[] } {
  const sendTurnCalls: SendTurnInput[] = [];
  const destroyCalls: string[] = [];
  let turnIndex = 0;

  return {
    name,
    sendTurnCalls,
    destroyCalls,
    async *send(input) {
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
        text: "stub",
        format: "plain" as const,
        metadata: { provider: "test", model: "test", requestId: input.requestId },
      };

      yield messageStarted(base, { ...payload, text: "" });
      yield messageCompleted(base, payload);
    },
    async *sendTurn(input: SendTurnInput): AsyncGenerator<AdapterEvent> {
      sendTurnCalls.push(input);
      const turn = turns[turnIndex % turns.length];
      turnIndex += 1;

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
        text: turn.text ?? "ok",
        format: "plain" as const,
        metadata: { provider: "test", model: "test", requestId: input.requestId },
      };

      if (turn.errorClass) {
        yield messageStarted(base, { ...payload, text: "" });
        yield messageError(base, turn.errorClass, `${turn.errorClass} error`, "");
        return;
      }

      yield messageStarted(base, { ...payload, text: "" });
      if (turn.nativeSessionId) {
        yield sessionBound(base, turn.nativeSessionId);
      }
      yield messageCompleted(base, payload);
    },
    async cancel() {},
    async destroy(nativeSessionId: string) {
      destroyCalls.push(nativeSessionId);
    },
    async health() {
      return "ready" as const;
    },
  };
}

function makeEngine(adapter: PersistentAdapter): {
  engine: ChatEngine;
  store: SQLiteStore;
} {
  const store = new SQLiteStore(":memory:");
  store.init();

  const session = new SessionService(store);
  const config: ChatRuntimeConfig = {
    dbPath: ":memory:",
    mode: "manual",
    roomName: "test-room",
    agents: [adapter.name],
    roomConfig: {
      mode: "manual",
      checkpointThreshold: 50,
      maxHistoryMessages: 100,
      maxContextTokens: 8000,
    },
    adapterConfig: {
      [adapter.name]: {
        mode: "persistent",
        timeoutMs: 5000,
        maxTokens: 4000,
      },
    },
    agentSkills: {},
  };

  const engine = new ChatEngine(session, { [adapter.name]: adapter }, config);
  engine.init();
  return { engine, store };
}

test("cold start: first turn has nativeSessionId=null", async () => {
  const adapter = makeStubPersistentAdapter("claude", [
    { text: "hello", nativeSessionId: "sid-1" },
  ]);
  const { engine, store } = makeEngine(adapter);

  try {
    await engine.processUserMessage("@claude hi");

    assert.equal(adapter.sendTurnCalls.length, 1);
    assert.equal(adapter.sendTurnCalls[0]?.nativeSessionId, null);
  } finally {
    store.close();
  }
});

test("warm turn: second turn uses saved nativeSessionId", async () => {
  const adapter = makeStubPersistentAdapter("claude", [
    { text: "first", nativeSessionId: "sid-1" },
    { text: "second" },
  ]);
  const { engine, store } = makeEngine(adapter);

  try {
    await engine.processUserMessage("@claude msg 1");
    await engine.processUserMessage("@claude msg 2");

    assert.equal(adapter.sendTurnCalls.length, 2);
    assert.equal(adapter.sendTurnCalls[1]?.nativeSessionId, "sid-1");
  } finally {
    store.close();
  }
});

test("warm turn: prompt contains delta, not full history", async () => {
  const adapter = makeStubPersistentAdapter("claude", [
    { text: "first", nativeSessionId: "sid-1" },
    { text: "second" },
  ]);
  const { engine, store } = makeEngine(adapter);

  try {
    await engine.processUserMessage("@claude first question");
    await engine.processUserMessage("@claude second question");

    const secondPrompt = adapter.sendTurnCalls[1]?.prompt ?? "";
    assert.ok(secondPrompt.includes("second question"));
    assert.ok(!secondPrompt.includes("first question"));
  } finally {
    store.close();
  }
});

test("SESSION_EXPIRED: auto-retry with cold start", async () => {
  const adapter = makeStubPersistentAdapter("claude", [
    { text: "first", nativeSessionId: "sid-1" },
    { errorClass: "SESSION_EXPIRED" },
    { text: "recovered", nativeSessionId: "sid-2" },
  ]);
  const { engine, store } = makeEngine(adapter);

  try {
    await engine.processUserMessage("@claude msg 1");
    const results = await engine.processUserMessage("@claude msg 2");

    assert.equal(adapter.sendTurnCalls.length, 3);
    assert.equal(adapter.sendTurnCalls[2]?.nativeSessionId, null);
    assert.ok(results.some((result) => result.success));
  } finally {
    store.close();
  }
});

test("session.bound event saves nativeSessionId to agent_sessions", async () => {
  const adapter = makeStubPersistentAdapter("claude", [
    { text: "hello", nativeSessionId: "sid-999" },
  ]);
  const { engine, store } = makeEngine(adapter);

  try {
    await engine.processUserMessage("@claude hi");

    const state = engine.getState();
    const sessions = store.listActiveAgentSessions(state.room.id);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.nativeSessionId, "sid-999");
  } finally {
    store.close();
  }
});

test("stub mode: uses send() not sendTurn()", async () => {
  const adapter = makeStubPersistentAdapter("claude", [{ text: "stub" }]);
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    const session = new SessionService(store);
    const config: ChatRuntimeConfig = {
      dbPath: ":memory:",
      mode: "manual",
      roomName: "test-room",
      agents: ["claude"],
      roomConfig: {
        mode: "manual",
        checkpointThreshold: 50,
        maxHistoryMessages: 100,
        maxContextTokens: 8000,
      },
      adapterConfig: {
        claude: {
          mode: "stub",
          timeoutMs: 5000,
          maxTokens: 4000,
        },
      },
      agentSkills: {},
    };

    const engine = new ChatEngine(session, { claude: adapter }, config);
    engine.init();

    await engine.processUserMessage("@claude hi");

    assert.equal(adapter.sendTurnCalls.length, 0);
  } finally {
    store.close();
  }
});

test("agentic mode: uses sendTurn()", async () => {
  const adapter = makeStubPersistentAdapter("claude", [{ text: "agentic" }]);
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    const session = new SessionService(store);
    const config: ChatRuntimeConfig = {
      dbPath: ":memory:",
      mode: "manual",
      roomName: "test-room",
      agents: ["claude"],
      roomConfig: {
        mode: "manual",
        checkpointThreshold: 50,
        maxHistoryMessages: 100,
        maxContextTokens: 8000,
      },
      adapterConfig: {
        claude: {
          mode: "agentic",
          timeoutMs: 5000,
          maxTokens: 4000,
        },
      },
      team: {
        profile: "enthusiast",
        maxSteps: 8,
        maxNoProgressSteps: 2,
        maxDurationMs: 900_000,
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

    const engine = new ChatEngine(session, { claude: adapter }, config);
    engine.init();

    await engine.processUserMessage("@claude hi");

    assert.equal(adapter.sendTurnCalls.length, 1);
  } finally {
    store.close();
  }
});

test("shutdown destroys active adapter session by nativeSessionId", async () => {
  const adapter = makeStubPersistentAdapter("claude", [
    { text: "hello", nativeSessionId: "sid-shutdown-1" },
  ]);
  const { engine, store } = makeEngine(adapter);

  try {
    await engine.processUserMessage("@claude hi");
    await engine.shutdown();
    assert.deepEqual(adapter.destroyCalls, ["sid-shutdown-1"]);
  } finally {
    store.close();
  }
});
