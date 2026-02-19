import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Adapter, AdapterEvent } from "../../internal/adapters/adapter.js";
import type { ChatRuntimeConfig } from "../../internal/config/default.js";
import { defaultTeamConfig } from "../../internal/config/default.js";
import { ChatEngine } from "../../internal/engine/chat.js";
import { SessionService } from "../../internal/session/service.js";
import { SQLiteStore } from "../../internal/storage/sqlite.js";
import { MemoryService } from "../../internal/memory/service.js";
import { WorktreeManager } from "../../internal/worktree/manager.js";
import { DEFAULT_WORKSPACE_CONFIG } from "../../internal/workspace/collector.js";

interface ChatRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const makeAdapter = (name: string): Adapter => ({
  name,
  async *send(): AsyncGenerator<AdapterEvent> {
    return;
  },
  async cancel() {},
  async health() {
    return "ready" as const;
  },
});

const makeConfig = (
  adapterName: string,
  overrides: Partial<ChatRuntimeConfig> = {},
): ChatRuntimeConfig => ({
  dbPath: ":memory:",
  mode: "manual",
  roomName: "startup-recovery",
  agents: [adapterName],
  roomConfig: {
    mode: "manual",
    checkpointThreshold: 50,
    maxHistoryMessages: 100,
    maxContextTokens: 8_000,
  },
  adapterConfig: {
    [adapterName]: {
      mode: "stub",
      timeoutMs: 5_000,
      maxTokens: 2_000,
    },
  },
  team: defaultTeamConfig(),
  agentSkills: {},
  workspace: { ...DEFAULT_WORKSPACE_CONFIG, enabled: false },
  ...overrides,
});

const runChat = (
  args: string[],
  stdinInput: string,
  timeoutMs = 20_000,
): Promise<ChatRunResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "cmd/agoryx/main.ts", "chat", ...args],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("chat CLI startup-recovery test timed out"));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });

    child.stdin.end(stdinInput);
  });

const createTempGitRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agoryx-startup-recovery-git-"));
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# startup recovery\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
};

const cleanupRepo = (repoRoot: string): void => {
  try {
    const output = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const extra = output
      .split("\n\n")
      .filter(Boolean)
      .map((block) => {
        const match = block.match(/^worktree (.+)$/m);
        return match?.[1] ?? null;
      })
      .filter((path): path is string => path !== null && path !== repoRoot);

    for (const path of extra) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", path], { cwd: repoRoot });
      } catch {
        // best effort cleanup
      }
    }
  } catch {
    // best effort cleanup
  }
  rmSync(repoRoot, { recursive: true, force: true });
};

test("engine init calls checkAndRecover for active room and replays missing events", async () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  const session = new SessionService(store);
  const adapter = makeAdapter("codex");
  const seed = session.createSession({
    roomName: "startup-recovery-room",
    participants: ["user", "agent.codex"],
    roomConfig: {
      mode: "manual",
      checkpointThreshold: 50,
      maxHistoryMessages: 100,
      maxContextTokens: 8_000,
    },
  });

  const seedService = new MemoryService(store);
  seedService.recordDecision(seed.room.id, "Before snapshot");
  seedService.rebuildSnapshot(seed.room.id);
  seedService.recordDecision(seed.room.id, "After snapshot");

  const memoryService = new MemoryService(store);
  const originalCheckAndRecover = memoryService.checkAndRecover.bind(memoryService);
  const calledRoomIds: string[] = [];
  (memoryService as any).checkAndRecover = (roomId: string) => {
    calledRoomIds.push(roomId);
    return originalCheckAndRecover(roomId);
  };

  const config = makeConfig("codex", {
    resumeRoomId: seed.room.id,
  });

  const engine = new ChatEngine(session, { codex: adapter }, config, {}, memoryService);

  try {
    const initialized = engine.init();
    assert.equal(initialized.room.id, seed.room.id);
    assert.deepEqual(calledRoomIds, [seed.room.id]);

    const snapshot = store.getMemorySnapshot(seed.room.id);
    assert.ok(snapshot);
    assert.ok(snapshot.keyDecisions.includes("After snapshot"));
  } finally {
    await engine.shutdown();
    await memoryService.dispose();
    await seedService.dispose();
    store.close();
  }
});

test("engine init calls worktreeManager.reconcile()", async () => {
  const repoRoot = createTempGitRepo();
  const store = new SQLiteStore(":memory:");
  store.init();
  const session = new SessionService(store);
  const adapter = makeAdapter("codex");
  const memoryService = new MemoryService(store);
  const worktreeManager = new WorktreeManager(repoRoot);
  const originalReconcile = worktreeManager.reconcile.bind(worktreeManager);
  let reconcileCalls = 0;
  (worktreeManager as any).reconcile = () => {
    reconcileCalls += 1;
    return originalReconcile();
  };

  const config = makeConfig("codex");
  const engine = new ChatEngine(
    session,
    { codex: adapter },
    config,
    {},
    memoryService,
    worktreeManager,
  );

  try {
    engine.init();
    assert.equal(reconcileCalls, 1);
  } finally {
    await engine.shutdown();
    await memoryService.dispose();
    store.close();
    cleanupRepo(repoRoot);
  }
});

test("/help includes memory/worktree/workspace command surface", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agoryx-startup-recovery-help-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const dbPath = join(dir, "help.db");
  const result = await runChat(
    [
      "--agents",
      "codex,claude",
      "--mode",
      "manual",
      "--adapter-mode",
      "stub",
      "--db",
      dbPath,
    ],
    "/help\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /\/memory \[show\]/);
  assert.match(result.stdout, /\/memory render/);
  assert.match(result.stdout, /\/worktree list \[--json\]/);
  assert.match(result.stdout, /\/worktree status \[--json\]/);
  assert.match(result.stdout, /\/workspace show \[--json\]/);
  assert.match(result.stdout, /\/workspace full \[--json\]/);
});
