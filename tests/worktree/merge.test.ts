import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorktreeManager } from "../../internal/worktree/manager.js";

const createTestRepo = (t: Parameters<Parameters<typeof test>[1]>[0]): string => {
  const dir = mkdtempSync(join(tmpdir(), "wt-merge-test-"));
  t.after(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# Test\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
};

test("merge: merges agent branch into current branch", (t) => {
  const repo = createTestRepo(t);
  const manager = new WorktreeManager(repo);
  const wt = manager.create("codex");

  // Create a file in the worktree
  writeFileSync(join(wt.path, "codex-output.txt"), "hello from codex\n");
  execFileSync("git", ["add", "."], { cwd: wt.path });
  execFileSync("git", ["commit", "-m", "codex work"], { cwd: wt.path });

  const result = manager.merge("codex");
  assert.equal(result.success, true);
  assert.equal(result.conflicts, null);

  // Verify the file is now on main
  const content = execFileSync("git", ["show", "HEAD:codex-output.txt"], {
    cwd: repo,
    encoding: "utf-8",
  });
  assert.equal(content.trim(), "hello from codex");
});

test("merge: reports conflicts when branches conflict", (t) => {
  const repo = createTestRepo(t);
  const manager = new WorktreeManager(repo);
  const wt = manager.create("codex");

  // Modify same file in both branches
  writeFileSync(join(repo, "README.md"), "# Modified on main\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "main change"], { cwd: repo });

  writeFileSync(join(wt.path, "README.md"), "# Modified by codex\n");
  execFileSync("git", ["add", "."], { cwd: wt.path });
  execFileSync("git", ["commit", "-m", "codex change"], { cwd: wt.path });

  const result = manager.merge("codex");
  assert.equal(result.success, false);
  assert.ok(result.conflicts);
  assert.ok(result.conflicts.length > 0);
});

test("merge: returns success with no changes when branch is not ahead", (t) => {
  const repo = createTestRepo(t);
  const manager = new WorktreeManager(repo);
  manager.create("codex");

  // No changes made in worktree
  const result = manager.merge("codex");
  assert.equal(result.success, true);
});

test("merge: throws for unknown agent", (t) => {
  const repo = createTestRepo(t);
  const manager = new WorktreeManager(repo);
  assert.throws(() => manager.merge("nonexistent"), /No worktree found/);
});
