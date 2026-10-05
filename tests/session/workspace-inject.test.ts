import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContext } from "../../internal/session/context.js";
import type { RoomConfig } from "../../internal/events/types.js";
import { SessionService } from "../../internal/session/service.js";
import { SQLiteStore } from "../../internal/storage/sqlite.js";

const ROOM_CONFIG: RoomConfig = {
  mode: "manual",
  checkpointThreshold: 50,
  maxHistoryMessages: 100,
  maxContextTokens: 100_000,
};

function createTempGitRepo(
  prefix: string,
  uniqueFileName: string,
  branchName?: string,
): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@agoryx.local"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Agoryx Test"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# test\n", "utf8");
  writeFileSync(join(repo, uniqueFileName), "tracked\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo });
  if (branchName) {
    execFileSync("git", ["checkout", "-q", "-b", branchName], { cwd: repo });
  }
  return repo;
}

function cleanupDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

test("buildContext injects [Workspace] before pinned context", () => {
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    const room = store.createRoom("workspace-order", ["user"], ROOM_CONFIG);
    store.addPinnedContext(room.id, "rules", "always use tests", "user");
    store.saveMessage({
      id: "msg_1",
      roomId: room.id,
      author: "user",
      role: "user",
      text: "hello",
      format: "plain",
      metadata: {},
      createdAt: new Date().toISOString(),
    });

    const ctx = buildContext(store, {
      roomId: room.id,
      workspaceBlock: "[Workspace]\nBranch: test-branch",
      maxHistoryMessages: 100,
      checkpointThreshold: 50,
      maxContextTokens: 100_000,
    });

    const workspaceIndex = ctx.messages.findIndex((message) =>
      message.text.includes("[Workspace]"),
    );
    const pinnedIndex = ctx.messages.findIndex((message) =>
      message.text.includes("[Pinned: rules]"),
    );

    assert.ok(workspaceIndex >= 0, "workspace block should be present");
    assert.ok(pinnedIndex >= 0, "pinned block should be present");
    assert.ok(
      workspaceIndex < pinnedIndex,
      "workspace block should be injected before pinned context",
    );
  } finally {
    store.close();
  }
});

test("buildDeltaPrompt injects [Workspace] for warm persistent turns", () => {
  const repo = createTempGitRepo("agoryx-ws-delta-", "delta-only.txt");
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    const service = new SessionService(store, {
      workspace: {
        config: { enabled: true },
        rootCwd: repo,
      },
    });
    const room = store.createRoom("workspace-delta", ["user", "agent.claude"], ROOM_CONFIG);
    store.saveMessage({
      id: "msg_1",
      roomId: room.id,
      author: "user",
      role: "user",
      text: "first",
      format: "plain",
      metadata: {},
      createdAt: new Date().toISOString(),
    });
    const seq = store.getMaxMessageSeq(room.id);
    assert.ok(seq !== null);

    store.saveMessage({
      id: "msg_2",
      roomId: room.id,
      author: "user",
      role: "user",
      text: "second",
      format: "plain",
      metadata: {},
      createdAt: new Date().toISOString(),
    });

    const result = service.buildDeltaPrompt(room, "claude", seq);
    assert.match(result.prompt, /\[Workspace\]/);
    assert.match(result.prompt, /delta-only\.txt/);
    assert.match(result.prompt, /\[Team context since your last response\]/);
  } finally {
    store.close();
    cleanupDir(repo);
  }
});

test("buildTeamPrompt uses actor-specific workspace cwd", () => {
  const rootRepo = createTempGitRepo("agoryx-ws-root-", "root-only.txt");
  const actorRepo = createTempGitRepo(
    "agoryx-ws-actor-",
    "actor-only.txt",
    "feature/codex",
  );
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    const service = new SessionService(store, {
      workspace: {
        config: { enabled: true },
        rootCwd: rootRepo,
        resolveAgentCwd: (agent) => (agent === "codex" ? actorRepo : undefined),
      },
    });
    const room = store.createRoom("workspace-team", ["user", "agent.codex"], {
      ...ROOM_CONFIG,
      mode: "team",
    });
    const run = service.createTeamRun({
      roomId: room.id,
      strategy: "debate",
      goal: "Ship v0.3",
      participants: ["codex"],
      maxSteps: 4,
      maxNoProgressSteps: 2,
      maxDurationMs: 600_000,
      checksEnabled: false,
      createdBy: "user",
    });

    const prompt = service.buildTeamPrompt(room, run, "debate", "codex", {
      instructions: "Do one concrete step.",
    });

    assert.match(prompt, /\[Workspace\]/);
    assert.match(prompt, /actor-only\.txt/);
    assert.doesNotMatch(prompt, /root-only\.txt/);
  } finally {
    store.close();
    cleanupDir(rootRepo);
    cleanupDir(actorRepo);
  }
});

test("degraded mode injects unavailable marker without crashing", () => {
  const nonGitDir = mkdtempSync(join(tmpdir(), "agoryx-ws-nongit-"));
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    const service = new SessionService(store, {
      workspace: {
        config: { enabled: true },
        rootCwd: nonGitDir,
      },
    });
    const room = store.createRoom("workspace-degraded", ["user"], ROOM_CONFIG);
    store.saveMessage({
      id: "msg_1",
      roomId: room.id,
      author: "user",
      role: "user",
      text: "hello",
      format: "plain",
      metadata: {},
      createdAt: new Date().toISOString(),
    });

    const messages = service.buildContextMessages(room, undefined, "claude");
    const workspaceMessage = messages.find((message) =>
      message.text.startsWith("[Workspace unavailable:"),
    );
    assert.ok(workspaceMessage, "degraded mode marker should be present");
  } finally {
    store.close();
    cleanupDir(nonGitDir);
  }
});

test("workspace context is cwd-specific across agents", () => {
  const codexRepo = createTempGitRepo("agoryx-ws-codex-", "codex-only.txt");
  const claudeRepo = createTempGitRepo("agoryx-ws-claude-", "claude-only.txt");
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    const service = new SessionService(store, {
      workspace: {
        config: { enabled: true },
        rootCwd: codexRepo,
        resolveAgentCwd: (agent) => (agent === "claude" ? claudeRepo : codexRepo),
      },
    });
    const room = store.createRoom("workspace-cwd", ["user"], ROOM_CONFIG);
    store.saveMessage({
      id: "msg_1",
      roomId: room.id,
      author: "user",
      role: "user",
      text: "hello",
      format: "plain",
      metadata: {},
      createdAt: new Date().toISOString(),
    });

    const codexContextText = service
      .buildContextMessages(room, undefined, "codex")
      .map((message) => message.text)
      .join("\n");
    const claudeContextText = service
      .buildContextMessages(room, undefined, "claude")
      .map((message) => message.text)
      .join("\n");

    assert.match(codexContextText, /codex-only\.txt/);
    assert.doesNotMatch(codexContextText, /claude-only\.txt/);
    assert.match(claudeContextText, /claude-only\.txt/);
    assert.doesNotMatch(claudeContextText, /codex-only\.txt/);
  } finally {
    store.close();
    cleanupDir(codexRepo);
    cleanupDir(claudeRepo);
  }
});
