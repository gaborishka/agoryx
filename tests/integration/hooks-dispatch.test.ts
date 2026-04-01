import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type {
  Adapter,
  AdapterEvent,
  AdapterStatus,
  AgentInput,
} from "../../internal/adapters/adapter.js";
import {
  messageCompleted,
  messageDelta,
  messageStarted,
} from "../../internal/adapters/event-factory.js";
import type { ChatRuntimeConfig } from "../../internal/config/default.js";
import {
  setFeatureEnabled,
  resetFeatureFlags,
} from "../../internal/config/features.js";
import type { MessageEventPayload } from "../../internal/events/types.js";
import { ChatEngine } from "../../internal/engine/chat.js";
import type {
  PreDispatchPayload,
  PostDispatchPayload,
} from "../../internal/engine/hooks.js";
import { SessionService } from "../../internal/session/service.js";
import { SQLiteStore } from "../../internal/storage/sqlite.js";

/** Minimal stub adapter that completes immediately with a canned response. */
class StubAdapter implements Adapter {
  public readonly name = "codex";

  public async *send(input: AgentInput): AsyncGenerator<AdapterEvent> {
    const base = {
      roomId: input.roomId,
      sessionId: input.sessionId,
      requestId: input.requestId,
      source: "adapter.codex",
    };
    const payload: MessageEventPayload = {
      messageId: `msg_${input.requestId}`,
      author: "agent.codex",
      role: "assistant",
      text: "stub response",
      format: "markdown",
      metadata: {
        provider: "openai",
        model: "codex",
        requestId: input.requestId,
      },
    };

    yield messageStarted(base, payload);
    yield messageDelta(base, payload);
    yield messageCompleted(base, payload);
  }

  public async cancel(): Promise<void> {}
  public async health(): Promise<AdapterStatus> {
    return "ready";
  }
}

const createEngine = (): { engine: ChatEngine; close: () => void } => {
  const store = new SQLiteStore(":memory:");
  store.init();
  const session = new SessionService(store);
  const config: ChatRuntimeConfig = {
    dbPath: ":memory:",
    mode: "manual",
    agents: ["codex"],
    adapterConfig: {
      codex: {
        mode: "stub",
        timeoutMs: 2_000,
        maxTokens: 2_000,
        systemPrompt: "You are codex in a hooks test.",
      },
    },
    roomConfig: {
      mode: "manual",
      checkpointThreshold: 50,
      maxHistoryMessages: 100,
      maxContextTokens: 30_000,
    },
    roomName: "Hooks Test",
  } as ChatRuntimeConfig;

  const engine = new ChatEngine(session, { codex: new StubAdapter() }, config);
  engine.init();
  return {
    engine,
    close: () => store.close(),
  };
};

describe("HookRegistry integration with DispatchEngine", () => {
  beforeEach(() => {
    resetFeatureFlags();
  });

  afterEach(() => {
    resetFeatureFlags();
  });

  it("fires pre and post hooks during a dispatch when feature is enabled", async () => {
    setFeatureEnabled("HOOK_SYSTEM", true);
    const { engine, close } = createEngine();

    const preCalls: PreDispatchPayload[] = [];
    const postCalls: PostDispatchPayload[] = [];

    const registry = engine.getHookRegistry();
    registry.onPreDispatch((payload) => {
      preCalls.push(payload);
    });
    registry.onPostDispatch((payload) => {
      postCalls.push(payload);
    });

    try {
      const results = await engine.processUserMessage("@codex hello");
      assert.equal(results.length, 1);
      assert.equal(results[0]?.success, true);

      // Pre hook should have fired once
      assert.equal(preCalls.length, 1);
      assert.equal(preCalls[0]?.targetAdapter, "codex");
      assert.ok(preCalls[0]?.dispatchId);
      assert.ok(preCalls[0]?.requestId);
      assert.ok(preCalls[0]?.roomId);
      assert.ok(preCalls[0]?.timestamp);

      // Post hook should have fired once
      assert.equal(postCalls.length, 1);
      assert.equal(postCalls[0]?.targetAdapter, "codex");
      assert.equal(postCalls[0]?.success, true);
      assert.ok(postCalls[0]?.text);
      assert.equal(typeof postCalls[0]?.durationMs, "number");
      assert.ok(postCalls[0]!.durationMs >= 0);
      assert.ok(postCalls[0]?.timestamp);
    } finally {
      close();
    }
  });

  it("does not fire hooks when HOOK_SYSTEM feature flag is disabled", async () => {
    setFeatureEnabled("HOOK_SYSTEM", false);
    const { engine, close } = createEngine();

    const preCalls: PreDispatchPayload[] = [];
    const postCalls: PostDispatchPayload[] = [];

    const registry = engine.getHookRegistry();
    registry.onPreDispatch((payload) => {
      preCalls.push(payload);
    });
    registry.onPostDispatch((payload) => {
      postCalls.push(payload);
    });

    try {
      const results = await engine.processUserMessage("@codex hello");
      assert.equal(results.length, 1);
      assert.equal(results[0]?.success, true);

      // Hooks should NOT have fired
      assert.equal(preCalls.length, 0);
      assert.equal(postCalls.length, 0);
    } finally {
      close();
    }
  });

  it("hook errors do not crash the dispatch", async () => {
    setFeatureEnabled("HOOK_SYSTEM", true);
    const { engine, close } = createEngine();

    const registry = engine.getHookRegistry();
    registry.onPreDispatch(() => {
      throw new Error("pre-hook explosion");
    });
    registry.onPostDispatch(() => {
      throw new Error("post-hook explosion");
    });

    try {
      const results = await engine.processUserMessage("@codex hello");
      assert.equal(results.length, 1);
      assert.equal(results[0]?.success, true);
      assert.ok(results[0]?.text, "dispatch should still complete with response text");
    } finally {
      close();
    }
  });
});
