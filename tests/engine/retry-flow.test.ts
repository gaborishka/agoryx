import assert from "node:assert/strict";
import test from "node:test";
import type {
  Adapter,
  AdapterEvent,
  AdapterStatus,
  AgentInput,
} from "../../internal/adapters/adapter.js";
import {
  messageCompleted,
  messageDelta,
  messageError,
  messageStarted,
} from "../../internal/adapters/event-factory.js";
import type { ChatRuntimeConfig } from "../../internal/config/default.js";
import type { ErrorClass, MessageEventPayload } from "../../internal/events/types.js";
import { ChatEngine } from "../../internal/engine/chat.js";
import { SessionService } from "../../internal/session/service.js";
import { SQLiteStore } from "../../internal/storage/sqlite.js";

class RecoveringAdapter implements Adapter {
  public readonly name = "codex";
  public readonly cancelledRequestIds: string[] = [];

  public constructor(
    private readonly failingClass: ErrorClass,
    private failuresRemaining = 1,
  ) {}

  public async *send(input: AgentInput): AsyncGenerator<AdapterEvent> {
    const base = {
      roomId: input.roomId,
      sessionId: input.sessionId,
      requestId: input.requestId,
      source: "adapter.codex",
    };
    const payload = assistantPayload(input.requestId, "");

    yield messageStarted(base, payload);

    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      yield messageError(
        base,
        this.failingClass,
        `${this.failingClass.toLowerCase()} during adapter call`,
      );
      return;
    }

    const text = `[retry-ok] recovered after ${this.failingClass}`;
    yield messageDelta(base, assistantPayload(input.requestId, text));
    yield messageCompleted(base, assistantPayload(input.requestId, text));
  }

  public async cancel(requestId: string): Promise<void> {
    this.cancelledRequestIds.push(requestId);
  }

  public async health(): Promise<AdapterStatus> {
    return "ready";
  }
}

const assistantPayload = (requestId: string, text: string): MessageEventPayload => ({
  messageId: `msg_${requestId}`,
  author: "agent.codex",
  role: "assistant",
  text,
  format: "markdown",
  metadata: {
    provider: "openai",
    model: "codex",
    requestId,
  },
});

const createEngine = (adapter: Adapter): { engine: ChatEngine; close: () => void } => {
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
        systemPrompt: "You are codex in a retry-flow test.",
      },
    },
    roomConfig: {
      mode: "manual",
      checkpointThreshold: 50,
      maxHistoryMessages: 100,
      maxContextTokens: 30_000,
    },
    roomName: "Retry Flow Test",
  };

  const engine = new ChatEngine(session, { codex: adapter }, config);
  engine.init();
  return {
    engine,
    close: () => store.close(),
  };
};

for (const errorClass of ["TIMEOUT", "PROCESS_CRASH"] as const) {
  test(`retry flow recovers from ${errorClass}`, async () => {
    const adapter = new RecoveringAdapter(errorClass, 1);
    const { engine, close } = createEngine(adapter);

    try {
      const firstAttempt = await engine.processUserMessage("@codex please respond");
      assert.equal(firstAttempt.length, 1);
      assert.equal(firstAttempt[0]?.success, false);
      assert.match(firstAttempt[0]?.error ?? "", new RegExp(`^${errorClass}:`));

      const failedRequestId = firstAttempt[0]?.requestId ?? "";
      assert.ok(failedRequestId, "failed attempt should have a request id");
      assert.equal(engine.getLastFailedRequest("codex"), failedRequestId);

      const retry = await engine.retryFailed("codex");
      assert.ok(retry, "retry should run when there is an active failure");
      assert.equal(retry?.failedRequestId, failedRequestId);
      assert.equal(adapter.cancelledRequestIds[0], failedRequestId);
      assert.equal(retry?.success, true);
      assert.notEqual(retry?.requestId, failedRequestId);
      assert.match(retry?.text ?? "", /\[retry-ok\]/);

      // Successful completion should clear the active failure marker.
      assert.equal(engine.getLastFailedRequest("codex"), null);
      assert.equal(await engine.retryFailed("codex"), null);

      const messages = engine.listMessages(10);
      assert.equal(messages.length, 2);
      assert.equal(messages[0]?.role, "user");
      assert.equal(messages[1]?.role, "assistant");
      assert.equal(messages[1]?.metadata.requestId, retry?.requestId);
    } finally {
      close();
    }
  });
}

test("retryFailed returns null when adapter has no unresolved failures", async () => {
  const adapter = new RecoveringAdapter("TIMEOUT", 0);
  const { engine, close } = createEngine(adapter);

  try {
    const attempt = await engine.processUserMessage("@codex healthy request");
    assert.equal(attempt.length, 1);
    assert.equal(attempt[0]?.success, true);

    const retry = await engine.retryFailed("codex");
    assert.equal(retry, null);
  } finally {
    close();
  }
});
