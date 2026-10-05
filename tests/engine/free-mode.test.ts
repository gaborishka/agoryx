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
  messageStarted,
} from "../../internal/adapters/event-factory.js";
import type { ChatRuntimeConfig } from "../../internal/config/default.js";
import type { MessageEventPayload } from "../../internal/events/types.js";
import { ChatEngine } from "../../internal/engine/chat.js";
import { SessionService } from "../../internal/session/service.js";
import { SQLiteStore } from "../../internal/storage/sqlite.js";

class ScriptedAdapter implements Adapter {
  public readonly calls: AgentInput[] = [];

  public constructor(
    public readonly name: string,
    private readonly responses: string[],
  ) {}

  public async *send(input: AgentInput): AsyncGenerator<AdapterEvent> {
    this.calls.push(input);
    const responseIndex = this.calls.length - 1;
    const text = this.responses[responseIndex] ?? this.responses[this.responses.length - 1] ?? "::pass::";
    const payload = assistantPayload(input.requestId, this.name, text);
    const base = {
      roomId: input.roomId,
      sessionId: input.sessionId,
      requestId: input.requestId,
      source: `adapter.${this.name}`,
    };

    yield messageStarted(base, payload);
    yield messageDelta(base, payload);
    yield messageCompleted(base, payload);
  }

  public async cancel(_requestId: string): Promise<void> {
    return;
  }

  public async health(): Promise<AdapterStatus> {
    return "ready";
  }
}

const assistantPayload = (
  requestId: string,
  adapter: string,
  text: string,
): MessageEventPayload => ({
  messageId: `msg_${adapter}_${requestId}`,
  author: `agent.${adapter}`,
  role: "assistant",
  text,
  format: "markdown",
  metadata: {
    provider: adapter === "codex" ? "openai" : "anthropic",
    model: adapter,
    requestId,
  },
});

const createEngine = (
  adapters: { codex: Adapter; claude: Adapter },
): { engine: ChatEngine; close: () => void } => {
  const store = new SQLiteStore(":memory:");
  store.init();
  const session = new SessionService(store);

  const config: ChatRuntimeConfig = {
    dbPath: ":memory:",
    mode: "free",
    agents: ["codex", "claude"],
    adapterConfig: {
      codex: {
        mode: "stub",
        timeoutMs: 2_000,
        maxTokens: 2_000,
        systemPrompt: "You are codex.",
      },
      claude: {
        mode: "stub",
        timeoutMs: 2_000,
        maxTokens: 2_000,
        systemPrompt: "You are claude.",
      },
    },
    roomConfig: {
      mode: "free",
      checkpointThreshold: 50,
      maxHistoryMessages: 100,
      maxContextTokens: 30_000,
    },
    roomName: "Free Mode Test",
  };

  const engine = new ChatEngine(session, adapters, config);
  engine.init();
  return {
    engine,
    close: () => store.close(),
  };
};

test("free mode runs one user turn for each agent and stops on ::pass::", async () => {
  const codex = new ScriptedAdapter("codex", ["::pass::"]);
  const claude = new ScriptedAdapter("claude", ["::pass::"]);
  const { engine, close } = createEngine({ codex, claude });

  try {
    const results = await engine.processUserMessage("hello team");
    assert.equal(results.length, 2);
    assert.equal(codex.calls.length, 1);
    assert.equal(claude.calls.length, 1);
    assert.ok(results.every((result) => result.success));
  } finally {
    close();
  }
});

test("free mode does not repeat an agent on plain mention follow-up", async () => {
  const codex = new ScriptedAdapter("codex", ["@claude please verify this"]);
  const claude = new ScriptedAdapter("claude", ["ack", "::pass::"]);
  const { engine, close } = createEngine({ codex, claude });

  try {
    const results = await engine.processUserMessage("@claude kick this off");
    assert.equal(results.length, 2);
    assert.equal(codex.calls.length, 1);
    assert.equal(claude.calls.length, 1);
    assert.ok(results.every((result) => result.success));
  } finally {
    close();
  }
});

test("free mode allows one extra turn on explicit @agent! handoff", async () => {
  const codex = new ScriptedAdapter("codex", ["@claude! please answer this point"]);
  const claude = new ScriptedAdapter("claude", ["opening", "::pass::"]);
  const { engine, close } = createEngine({ codex, claude });

  try {
    const results = await engine.processUserMessage("@claude kick this off");
    assert.equal(results.length, 3);
    assert.equal(codex.calls.length, 1);
    assert.equal(claude.calls.length, 2);
    assert.ok(results.every((result) => result.success));
  } finally {
    close();
  }
});

test("free mode allows repeat turn when follow-up explicitly signals disagreement", async () => {
  const codex = new ScriptedAdapter("codex", ["@claude!! I disagree with that framing."]);
  const claude = new ScriptedAdapter("claude", ["ack", "::pass::"]);
  const { engine, close } = createEngine({ codex, claude });

  try {
    const results = await engine.processUserMessage("@claude kick this off");
    assert.equal(results.length, 3);
    assert.equal(codex.calls.length, 1);
    assert.equal(claude.calls.length, 2);
    assert.ok(results.every((result) => result.success));
  } finally {
    close();
  }
});

test("free mode does not enqueue duplicate pending target when already queued", async () => {
  const codex = new ScriptedAdapter("codex", ["::pass::", "::pass::"]);
  const claude = new ScriptedAdapter("claude", ["@codex! please add your take"]);
  const { engine, close } = createEngine({ codex, claude });

  try {
    const results = await engine.processUserMessage("@claude @codex share thoughts");
    assert.equal(results.length, 2);
    assert.equal(claude.calls.length, 1);
    assert.equal(codex.calls.length, 1);
    assert.ok(results.every((result) => result.success));
  } finally {
    close();
  }
});
