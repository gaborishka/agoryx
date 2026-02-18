import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

const makeAdapter = (name: string): PersistentAdapter => ({
  name,
  async *send() {
    throw new Error("send() is not expected");
  },
  async *sendTurn(input: SendTurnInput): AsyncGenerator<AdapterEvent> {
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
      text: "done",
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
});

const makeConfig = (dbPath: string, resumeRoomId?: string): ChatRuntimeConfig => ({
  dbPath,
  mode: "team",
  roomName: "team-room",
  resumeRoomId,
  agents: ["claude"],
  roomConfig: {
    mode: "team",
    checkpointThreshold: 50,
    maxHistoryMessages: 100,
    maxContextTokens: 30_000,
  },
  adapterConfig: {
    claude: {
      mode: "agentic",
      timeoutMs: 30_000,
      maxTokens: 4_000,
    },
  },
  team: {
    profile: "enthusiast",
    maxSteps: 1,
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
});

test("manual resume loads latest resumable team run after restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agoryx-team-resume-"));
  const dbPath = join(dir, "team.db");
  try {
    const store1 = new SQLiteStore(dbPath);
    store1.init();
    const engine1 = new ChatEngine(
      new SessionService(store1),
      { claude: makeAdapter("claude") },
      makeConfig(dbPath),
    );
    const init1 = engine1.init();
    await engine1.processUserMessage("Create proposal");

    for (let i = 0; i < 30; i++) {
      const status = engine1.teamStatus();
      if (status?.run.status === "waiting_user_input") {
        break;
      }
      await wait(25);
    }
    const ready = engine1.teamStatus();
    assert.ok(ready);
    assert.equal(ready.run.status, "waiting_user_input");
    const roomId = init1.room.id;
    await engine1.shutdown();
    store1.close();

    const store2 = new SQLiteStore(dbPath);
    store2.init();
    const engine2 = new ChatEngine(
      new SessionService(store2),
      { claude: makeAdapter("claude") },
      makeConfig(dbPath, roomId),
    );
    engine2.init();

    const resumed = engine2.teamResume();
    assert.ok(resumed);
    assert.equal(resumed.status, "waiting_user_input");
    await engine2.shutdown();
    store2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
