import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { WorktreeManager } from "../../internal/worktree/manager.js";

function createTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "agoryx-wt-test-"));
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# Test\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

function cleanup(dir: string): void {
  try {
    // Remove worktrees first to avoid git complaints
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

test("create() creates worktree for agent", () => {
  const repo = createTempGitRepo();
  try {
    const mgr = new WorktreeManager(repo);
    const info = mgr.create("codex");
    assert.ok(info.path.includes(".agoryx/worktrees/codex"));
    assert.equal(info.agent, "codex");
    assert.ok(info.branch.startsWith("agoryx/codex-"));
  } finally {
    cleanup(repo);
  }
});

test("create() rejects invalid agent names", () => {
  const repo = createTempGitRepo();
  try {
    const mgr = new WorktreeManager(repo);
    assert.throws(() => {
      mgr.create("../../tmp/evil");
    }, /invalid agent name/i);
  } finally {
    cleanup(repo);
  }
});

test("create() is idempotent — same agent returns existing", () => {
  const repo = createTempGitRepo();
  try {
    const mgr = new WorktreeManager(repo);
    const first = mgr.create("codex");
    const second = mgr.create("codex");
    assert.equal(first.path, second.path);
    assert.equal(first.branch, second.branch);
  } finally {
    cleanup(repo);
  }
});

test("create() creates separate worktrees for different agents", () => {
  const repo = createTempGitRepo();
  try {
    const mgr = new WorktreeManager(repo);
    const codex = mgr.create("codex");
    const claude = mgr.create("claude");
    assert.notEqual(codex.path, claude.path);
    assert.notEqual(codex.branch, claude.branch);
  } finally {
    cleanup(repo);
  }
});

test("list() returns all managed worktrees", () => {
  const repo = createTempGitRepo();
  try {
    const mgr = new WorktreeManager(repo);
    mgr.create("codex");
    mgr.create("claude");
    const list = mgr.list();
    assert.equal(list.length, 2);
    const agents = list.map((w) => w.agent).sort();
    assert.deepEqual(agents, ["claude", "codex"]);
  } finally {
    cleanup(repo);
  }
});

test("getForAgent() returns info for specific agent", () => {
  const repo = createTempGitRepo();
  try {
    const mgr = new WorktreeManager(repo);
    mgr.create("codex");
    const info = mgr.getForAgent("codex");
    assert.ok(info);
    assert.equal(info!.agent, "codex");
    assert.equal(mgr.getForAgent("nobody"), null);
  } finally {
    cleanup(repo);
  }
});

test("remove() removes worktree for agent", () => {
  const repo = createTempGitRepo();
  try {
    const mgr = new WorktreeManager(repo);
    mgr.create("codex");
    mgr.remove("codex");
    assert.equal(mgr.getForAgent("codex"), null);
    assert.equal(mgr.list().length, 0);
  } finally {
    cleanup(repo);
  }
});

test("remove() fails on dirty worktree without force", () => {
  const repo = createTempGitRepo();
  try {
    const mgr = new WorktreeManager(repo);
    const info = mgr.create("codex");
    // Make worktree dirty
    writeFileSync(join(info.path, "dirty.txt"), "dirty content\n");
    execFileSync("git", ["add", "dirty.txt"], { cwd: info.path });

    assert.throws(() => {
      mgr.remove("codex", false);
    }, /dirty|uncommitted/i);
  } finally {
    cleanup(repo);
  }
});

test("remove() treats git status failures as dirty without force", () => {
  const repo = createTempGitRepo();
  try {
    const mgr = new WorktreeManager(repo);
    const invalidPath = join(repo, "nonexistent-worktree");
    (
      mgr as unknown as {
        agentMap: Map<string, { agent: string; path: string; branch: string; head: string }>;
      }
    ).agentMap.set("codex", {
      agent: "codex",
      path: invalidPath,
      branch: "agoryx/codex-fake",
      head: "",
    });

    assert.throws(() => {
      mgr.remove("codex", false);
    }, /uncommitted changes/i);
  } finally {
    cleanup(repo);
  }
});

test("remove() with force succeeds on dirty worktree", () => {
  const repo = createTempGitRepo();
  try {
    const mgr = new WorktreeManager(repo);
    const info = mgr.create("codex");
    writeFileSync(join(info.path, "dirty.txt"), "dirty content\n");
    execFileSync("git", ["add", "dirty.txt"], { cwd: info.path });

    mgr.remove("codex", true);
    assert.equal(mgr.getForAgent("codex"), null);
  } finally {
    cleanup(repo);
  }
});

test("reconcile() recovers agent map from git worktree list", () => {
  const repo = createTempGitRepo();
  try {
    const mgr1 = new WorktreeManager(repo);
    mgr1.create("codex");
    mgr1.create("claude");

    // Create new manager instance (simulates restart)
    const mgr2 = new WorktreeManager(repo);
    assert.equal(mgr2.list().length, 0, "fresh manager has no entries");

    mgr2.reconcile();
    const list = mgr2.list();
    assert.equal(list.length, 2, "reconcile should recover 2 worktrees");
    const agents = list.map((w) => w.agent).sort();
    assert.deepEqual(agents, ["claude", "codex"]);
  } finally {
    cleanup(repo);
  }
});

test("reconcile() with custom root does not import legacy default-root worktrees", () => {
  const repo = createTempGitRepo();
  try {
    const defaultMgr = new WorktreeManager(repo);
    defaultMgr.create("codex");

    const customMgr = new WorktreeManager(repo, join(repo, "custom-worktrees"));
    customMgr.reconcile();
    assert.equal(customMgr.list().length, 0);
  } finally {
    cleanup(repo);
  }
});

test("reconcile() prunes stale entries after external worktree removal", () => {
  const repo = createTempGitRepo();
  try {
    const mgr = new WorktreeManager(repo);
    mgr.create("codex");
    mgr.create("claude");
    assert.equal(mgr.list().length, 2);

    // Externally remove one worktree (simulates `git worktree remove` outside agoryx)
    const codexInfo = mgr.getForAgent("codex")!;
    execFileSync("git", ["worktree", "remove", "--force", codexInfo.path], { cwd: repo });

    // Before reconcile, agentMap still has the stale entry
    assert.equal(mgr.list().length, 2, "stale entry still in map before reconcile");

    mgr.reconcile();
    assert.equal(mgr.list().length, 1, "stale entry should be pruned after reconcile");
    assert.equal(mgr.getForAgent("codex"), null, "codex should be gone");
    assert.ok(mgr.getForAgent("claude"), "claude should remain");
  } finally {
    cleanup(repo);
  }
});

test("reconcile() is safe in non-git directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "agoryx-wt-nongit-"));
  try {
    const mgr = new WorktreeManager(dir);
    // Should not throw
    mgr.reconcile();
    assert.equal(mgr.list().length, 0);
  } finally {
    cleanup(dir);
  }
});

test("reconcile() in non-git directory does not print git fatal noise", () => {
  const dir = mkdtempSync(join(tmpdir(), "agoryx-wt-nongit-"));
  const originalWrite = process.stderr.write.bind(process.stderr);
  let stderrOutput = "";
  (process.stderr as any).write = (chunk: unknown, ...args: unknown[]) => {
    stderrOutput += String(chunk);
    if (typeof args[args.length - 1] === "function") {
      (args[args.length - 1] as (error?: Error | null) => void)(null);
    }
    return true;
  };

  try {
    const mgr = new WorktreeManager(dir);
    mgr.reconcile();
    assert.equal(mgr.list().length, 0);
    assert.ok(
      !/fatal:\s+not a git repository/i.test(stderrOutput),
      `unexpected git fatal noise: ${stderrOutput}`,
    );
  } finally {
    (process.stderr as any).write = originalWrite;
    cleanup(dir);
  }
});
