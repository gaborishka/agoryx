import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { SQLiteStore } from "../../internal/storage/sqlite.js";
import { SessionService } from "../../internal/session/service.js";
import { ChatEngine } from "../../internal/engine/chat.js";
import { MemoryService } from "../../internal/memory/service.js";
import { WorktreeManager } from "../../internal/worktree/manager.js";
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

function createTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "agoryx-wt-eng-test-"));
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# Test\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

function cleanupRepo(dir: string): void {
  try {
    const output = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: dir,
      encoding: "utf-8",
    });
    const worktrees = output
      .split("\n\n")
      .filter(Boolean)
      .map((block) => {
        const match = block.match(/^worktree (.+)$/m);
        return match?.[1] ?? null;
      })
      .filter((p): p is string => p !== null && p !== dir);

    for (const wt of worktrees) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: dir });
      } catch {
        // ignore
      }
    }
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

const makeAdapter = (
  name: string,
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

      const payload = {
        messageId: createId("msg"),
        author: `agent.${name}`,
        role: "assistant" as const,
        text: `Done with work.\nTEAM_DONE`,
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

test("team run auto-creates worktrees per agent", async () => {
  const repo = createTempGitRepo();
  const adapter = makeAdapter("codex");
  const store = new SQLiteStore(":memory:");
  store.init();
  const session = new SessionService(store);
  const memoryService = new MemoryService(store);
  const worktreeManager = new WorktreeManager(repo);

  const config: ChatRuntimeConfig = {
    dbPath: ":memory:",
    mode: "team",
    roomName: "wt-test",
    agents: ["codex"],
    roomConfig: {
      mode: "team",
      checkpointThreshold: 50,
      maxHistoryMessages: 100,
      maxContextTokens: 30_000,
    },
    adapterConfig: {
      codex: {
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

  const engine = new ChatEngine(
    session,
    { codex: adapter },
    config,
    {},
    memoryService,
    worktreeManager,
  );
  engine.init();

  try {
    await engine.processUserMessage("Build something");

    // Wait for team run to complete
    for (let i = 0; i < 40; i++) {
      const status = engine.teamStatus();
      if (
        status?.run.status === "waiting_user_input" ||
        status?.run.status === "done"
      ) {
        break;
      }
      await wait(25);
    }

    // Worktree should exist
    const wt = worktreeManager.getForAgent("codex");
    assert.ok(wt, "worktree should be created for codex");
    assert.ok(wt!.path.includes(".agoryx/worktrees/codex"));

    // worktree_create event should be in memory_log
    const state = engine.getState();
    const events = store.listMemoryEvents(state.room.id);
    const wtEvents = events.filter((e) => e.eventType === "worktree_create");
    assert.ok(wtEvents.length > 0, "should have worktree_create event");
    assert.equal((wtEvents[0].payload as any).agent, "codex");
  } finally {
    await engine.shutdown();
    store.close();
    cleanupRepo(repo);
  }
});

test("workspaceCwd set to worktree path per-dispatch", async () => {
  const repo = createTempGitRepo();
  const adapter = makeAdapter("codex");
  const store = new SQLiteStore(":memory:");
  store.init();
  const session = new SessionService(store);
  const memoryService = new MemoryService(store);
  const worktreeManager = new WorktreeManager(repo);

  const config: ChatRuntimeConfig = {
    dbPath: ":memory:",
    mode: "team",
    roomName: "wt-test",
    agents: ["codex"],
    roomConfig: {
      mode: "team",
      checkpointThreshold: 50,
      maxHistoryMessages: 100,
      maxContextTokens: 30_000,
    },
    adapterConfig: {
      codex: {
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

  const engine = new ChatEngine(
    session,
    { codex: adapter },
    config,
    {},
    memoryService,
    worktreeManager,
  );
  engine.init();

  try {
    await engine.processUserMessage("Build something");

    for (let i = 0; i < 40; i++) {
      const status = engine.teamStatus();
      if (
        status?.run.status === "waiting_user_input" ||
        status?.run.status === "done"
      ) {
        break;
      }
      await wait(25);
    }

    // The adapter config should have workspaceCwd set
    assert.ok(config.adapterConfig.codex.workspaceCwd);
    assert.ok(
      config.adapterConfig.codex.workspaceCwd!.includes(".agoryx/worktrees/codex"),
    );
  } finally {
    await engine.shutdown();
    store.close();
    cleanupRepo(repo);
  }
});

test("shutdown does NOT remove worktrees", async () => {
  const repo = createTempGitRepo();
  const adapter = makeAdapter("codex");
  const store = new SQLiteStore(":memory:");
  store.init();
  const session = new SessionService(store);
  const memoryService = new MemoryService(store);
  const worktreeManager = new WorktreeManager(repo);

  const config: ChatRuntimeConfig = {
    dbPath: ":memory:",
    mode: "team",
    roomName: "wt-test",
    agents: ["codex"],
    roomConfig: {
      mode: "team",
      checkpointThreshold: 50,
      maxHistoryMessages: 100,
      maxContextTokens: 30_000,
    },
    adapterConfig: {
      codex: {
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

  const engine = new ChatEngine(
    session,
    { codex: adapter },
    config,
    {},
    memoryService,
    worktreeManager,
  );
  engine.init();

  try {
    await engine.processUserMessage("Build something");

    for (let i = 0; i < 40; i++) {
      const status = engine.teamStatus();
      if (
        status?.run.status === "waiting_user_input" ||
        status?.run.status === "done"
      ) {
        break;
      }
      await wait(25);
    }

    await engine.shutdown();

    // Worktree should still exist after shutdown
    const wt = worktreeManager.getForAgent("codex");
    assert.ok(wt, "worktree should persist after shutdown");
  } finally {
    store.close();
    cleanupRepo(repo);
  }
});

test("reconcile() called at engine init recovers worktree map", async () => {
  const repo = createTempGitRepo();
  const store = new SQLiteStore(":memory:");
  store.init();

  // Create a worktree manually (simulating previous session)
  const mgr1 = new WorktreeManager(repo);
  mgr1.create("codex");

  // Create new manager (simulates fresh start)
  const mgr2 = new WorktreeManager(repo);
  assert.equal(mgr2.list().length, 0, "fresh manager should be empty");

  const adapter = makeAdapter("codex");
  const session = new SessionService(store);
  const config: ChatRuntimeConfig = {
    dbPath: ":memory:",
    mode: "manual",
    roomName: "wt-test",
    agents: ["codex"],
    roomConfig: {
      mode: "manual",
      checkpointThreshold: 50,
      maxHistoryMessages: 100,
      maxContextTokens: 30_000,
    },
    adapterConfig: {
      codex: {
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

  const engine = new ChatEngine(
    session,
    { codex: adapter },
    config,
    {},
    undefined,
    mgr2,
  );
  engine.init(); // Should call reconcile()

  try {
    // After init, mgr2 should have recovered the worktree
    assert.equal(mgr2.list().length, 1, "reconcile should recover worktree");
    assert.equal(mgr2.list()[0].agent, "codex");
  } finally {
    await engine.shutdown();
    store.close();
    cleanupRepo(repo);
  }
});
