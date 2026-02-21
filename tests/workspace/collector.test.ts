import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  WorkspaceCollector,
  DEFAULT_WORKSPACE_CONFIG,
  type WorkspaceConfig,
} from "../../internal/workspace/collector.js";

function makeTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "agoryx-ws-test-"));
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# test\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

test("collectAlwaysOn returns branch, status, diff, tree", () => {
  const dir = makeTempGitRepo();
  try {
    const collector = new WorkspaceCollector(DEFAULT_WORKSPACE_CONFIG);
    const ctx = collector.collectAlwaysOn(dir);
    assert.ok(ctx.branch, "branch should be present");
    assert.ok(typeof ctx.status === "string");
    assert.ok(typeof ctx.stagedDiff === "string");
    assert.ok(typeof ctx.unstagedDiff === "string");
    assert.ok(typeof ctx.tree === "string");
    assert.ok(ctx.tree.includes("README.md"), "tree should include README.md");
  } finally {
    cleanup(dir);
  }
});

test("collectAlwaysOn detects staged and unstaged changes separately", () => {
  const dir = makeTempGitRepo();
  try {
    // Create a staged change
    writeFileSync(join(dir, "staged.txt"), "staged content\n");
    execFileSync("git", ["add", "staged.txt"], { cwd: dir });

    // Create an unstaged change
    writeFileSync(join(dir, "README.md"), "# modified\n");

    const collector = new WorkspaceCollector(DEFAULT_WORKSPACE_CONFIG);
    const ctx = collector.collectAlwaysOn(dir);

    assert.ok(ctx.stagedDiff.includes("staged.txt"), "staged diff should include staged.txt");
    assert.ok(ctx.unstagedDiff.includes("README.md"), "unstaged diff should include README.md");
    assert.ok(ctx.status.includes("staged.txt"), "status should include staged.txt");
  } finally {
    cleanup(dir);
  }
});

test("format produces [Workspace] block with all sections", () => {
  const dir = makeTempGitRepo();
  try {
    writeFileSync(join(dir, "new.ts"), "export const x = 1;\n");
    execFileSync("git", ["add", "new.ts"], { cwd: dir });

    const collector = new WorkspaceCollector(DEFAULT_WORKSPACE_CONFIG);
    const ctx = collector.collectAlwaysOn(dir);
    const block = collector.format(ctx);

    assert.ok(block.startsWith("[Workspace]"), "should start with [Workspace]");
    assert.ok(block.includes("Branch:"), "should include Branch section");
    assert.ok(block.includes("Files:"), "should include Files section");
  } finally {
    cleanup(dir);
  }
});

test("respects config limits for tree lines", () => {
  const dir = makeTempGitRepo();
  try {
    // Create many files
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(dir, `file${i}.ts`), `export const x${i} = ${i};\n`);
    }
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "add files"], { cwd: dir });

    const config: WorkspaceConfig = { ...DEFAULT_WORKSPACE_CONFIG, treeLines: 3 };
    const collector = new WorkspaceCollector(config);
    const ctx = collector.collectAlwaysOn(dir);

    const treeLineCount = ctx.tree.split("\n").filter(Boolean).length;
    assert.ok(treeLineCount <= 3, `tree should have <= 3 lines, got ${treeLineCount}`);
  } finally {
    cleanup(dir);
  }
});

test("respects config limits for diff lines", () => {
  const dir = makeTempGitRepo();
  try {
    // Create a file with many lines of change
    const content = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    writeFileSync(join(dir, "big.ts"), content);

    const config: WorkspaceConfig = { ...DEFAULT_WORKSPACE_CONFIG, diffLines: 5 };
    const collector = new WorkspaceCollector(config);
    const ctx = collector.collectAlwaysOn(dir);

    const diffLineCount = ctx.unstagedDiff.split("\n").filter(Boolean).length;
    assert.ok(diffLineCount <= 5, `diff should have <= 5 lines, got ${diffLineCount}`);
  } finally {
    cleanup(dir);
  }
});

test("degraded mode returns unavailable message for non-git directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "agoryx-ws-nongit-"));
  try {
    const collector = new WorkspaceCollector(DEFAULT_WORKSPACE_CONFIG);
    const ctx = collector.collectAlwaysOn(dir);
    const block = collector.format(ctx);

    assert.ok(block.includes("[Workspace unavailable"), "should indicate workspace unavailable");
  } finally {
    cleanup(dir);
  }
});

test("uses git ls-files for tree listing", () => {
  const dir = makeTempGitRepo();
  try {
    // Create an untracked file — should NOT appear in tree (git ls-files only shows tracked)
    writeFileSync(join(dir, "untracked.ts"), "nope\n");

    const collector = new WorkspaceCollector(DEFAULT_WORKSPACE_CONFIG);
    const ctx = collector.collectAlwaysOn(dir);

    assert.ok(!ctx.tree.includes("untracked.ts"), "untracked file should not appear in git ls-files tree");
    assert.ok(ctx.tree.includes("README.md"), "tracked file should appear");
  } finally {
    cleanup(dir);
  }
});

test("collectOnDemand returns log and branch diff", () => {
  const dir = makeTempGitRepo();
  try {
    // Create a couple commits for log
    writeFileSync(join(dir, "a.ts"), "a\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "add a"], { cwd: dir });

    writeFileSync(join(dir, "b.ts"), "b\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "add b"], { cwd: dir });

    const collector = new WorkspaceCollector(DEFAULT_WORKSPACE_CONFIG);
    const onDemand = collector.collectOnDemand(dir);

    assert.ok(typeof onDemand.recentLog === "string");
    assert.ok(onDemand.recentLog.includes("add b"), "log should include recent commit");
    assert.ok(onDemand.recentLog.includes("add a"), "log should include older commit");
  } finally {
    cleanup(dir);
  }
});

test("pinnedDocs are truncated with marker when exceeding limit", () => {
  const dir = makeTempGitRepo();
  try {
    const docsDir = join(dir, "docs");
    mkdirSync(docsDir);
    // Create a doc larger than the limit
    const bigContent = "x".repeat(200);
    writeFileSync(join(docsDir, "BIG.md"), bigContent);
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "add docs"], { cwd: dir });

    const config: WorkspaceConfig = { ...DEFAULT_WORKSPACE_CONFIG, pinnedDocCharsPerFile: 50 };
    const collector = new WorkspaceCollector(config);
    const ctx = collector.collectAlwaysOn(dir, [join(docsDir, "BIG.md")]);

    assert.ok(ctx.pinnedDocs.length === 1);
    assert.ok(ctx.pinnedDocs[0].content.length <= 60, "content should be truncated");
    assert.ok(ctx.pinnedDocs[0].truncated, "should be marked as truncated");
  } finally {
    cleanup(dir);
  }
});

test("collectAlwaysOn skips pinned docs outside workspace root", () => {
  const dir = makeTempGitRepo();
  const outsideDir = mkdtempSync(join(tmpdir(), "agoryx-ws-outside-"));
  try {
    const outsideDocPath = join(outsideDir, "SECRET.md");
    writeFileSync(outsideDocPath, "outside");

    const collector = new WorkspaceCollector(DEFAULT_WORKSPACE_CONFIG);
    const ctx = collector.collectAlwaysOn(dir, [outsideDocPath]);

    assert.equal(ctx.pinnedDocs.length, 0);
  } finally {
    cleanup(dir);
    cleanup(outsideDir);
  }
});
