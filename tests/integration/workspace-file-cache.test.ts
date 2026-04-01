import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  WorkspaceCollector,
  DEFAULT_WORKSPACE_CONFIG,
  type WorkspaceConfig,
} from "../../internal/workspace/collector.js";
import { FileCache } from "../../internal/utils/file-cache.js";

function makeTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "agoryx-fc-test-"));
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

describe("WorkspaceCollector FileCache integration", () => {
  it("first collectAlwaysOn reads files from disk and populates cache", () => {
    const dir = makeTempGitRepo();
    try {
      const docsDir = join(dir, "docs");
      mkdirSync(docsDir);
      writeFileSync(join(docsDir, "GUIDE.md"), "# Guide\nSome content here.");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-m", "add guide"], { cwd: dir });

      const collector = new WorkspaceCollector(DEFAULT_WORKSPACE_CONFIG);
      const cache = collector.getFileCache();

      assert.equal(cache.size, 0, "cache should be empty before first call");

      const ctx = collector.collectAlwaysOn(dir, ["docs/GUIDE.md"]);

      assert.equal(ctx.pinnedDocs.length, 1);
      assert.equal(ctx.pinnedDocs[0].content, "# Guide\nSome content here.");
      assert.equal(ctx.pinnedDocs[0].truncated, false);
      assert.ok(cache.size > 0, "cache should have entries after reading pinned docs");
    } finally {
      cleanup(dir);
    }
  });

  it("second call returns cached content without re-reading disk", () => {
    const dir = makeTempGitRepo();
    try {
      const docsDir = join(dir, "docs");
      mkdirSync(docsDir);
      writeFileSync(join(docsDir, "CACHED.md"), "cached content");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-m", "add cached"], { cwd: dir });

      const collector = new WorkspaceCollector(DEFAULT_WORKSPACE_CONFIG);
      const cache = collector.getFileCache();

      // First call — populates cache
      const ctx1 = collector.collectAlwaysOn(dir, ["docs/CACHED.md"]);
      assert.equal(ctx1.pinnedDocs.length, 1);
      const sizeAfterFirst = cache.size;
      assert.ok(sizeAfterFirst > 0, "cache should have entries after first call");

      // Second call — uses cache
      const ctx2 = collector.collectAlwaysOn(dir, ["docs/CACHED.md"]);
      assert.equal(ctx2.pinnedDocs.length, 1);
      assert.equal(ctx2.pinnedDocs[0].content, "cached content");
      assert.equal(cache.size, sizeAfterFirst, "cache size should not change on second call");
    } finally {
      cleanup(dir);
    }
  });

  it("file modification is picked up after TTL expires", () => {
    const dir = makeTempGitRepo();
    try {
      const docsDir = join(dir, "docs");
      mkdirSync(docsDir);
      writeFileSync(join(docsDir, "MUTABLE.md"), "version 1");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-m", "add mutable"], { cwd: dir });

      // Use a very short TTL so it expires immediately
      const shortTtlCache = new FileCache({
        maxEntries: 20,
        maxTotalBytes: 512 * 1024,
        ttlMs: 1, // 1ms TTL — will expire by the time we call again
      });

      const collector = new WorkspaceCollector(DEFAULT_WORKSPACE_CONFIG, {
        fileCache: shortTtlCache,
      });

      // First call
      const ctx1 = collector.collectAlwaysOn(dir, ["docs/MUTABLE.md"]);
      assert.equal(ctx1.pinnedDocs[0].content, "version 1");

      // Modify the file (change mtime)
      writeFileSync(join(docsDir, "MUTABLE.md"), "version 2");

      // Second call — TTL expired, mtime changed, should re-read
      const ctx2 = collector.collectAlwaysOn(dir, ["docs/MUTABLE.md"]);
      assert.equal(ctx2.pinnedDocs[0].content, "version 2");
    } finally {
      cleanup(dir);
    }
  });

  it("non-existent pinned doc path does not crash", () => {
    const dir = makeTempGitRepo();
    try {
      const collector = new WorkspaceCollector(DEFAULT_WORKSPACE_CONFIG);

      // Pass a path that exists within the workspace root but the file is missing
      const ctx = collector.collectAlwaysOn(dir, ["docs/NOPE.md"]);

      // Should not crash, just skip the missing doc
      assert.equal(ctx.pinnedDocs.length, 0);
      assert.equal(ctx.unavailable, null);
    } finally {
      cleanup(dir);
    }
  });

  it("custom FileCache can be injected via constructor", () => {
    const dir = makeTempGitRepo();
    try {
      const docsDir = join(dir, "docs");
      mkdirSync(docsDir);
      writeFileSync(join(docsDir, "INJECT.md"), "injected cache test");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-m", "add inject"], { cwd: dir });

      const customCache = new FileCache({
        maxEntries: 5,
        maxTotalBytes: 1024,
        ttlMs: 60_000,
      });

      const collector = new WorkspaceCollector(DEFAULT_WORKSPACE_CONFIG, {
        fileCache: customCache,
      });

      assert.equal(collector.getFileCache(), customCache, "should use injected cache instance");

      const ctx = collector.collectAlwaysOn(dir, ["docs/INJECT.md"]);
      assert.equal(ctx.pinnedDocs.length, 1);
      assert.equal(ctx.pinnedDocs[0].content, "injected cache test");
      assert.ok(customCache.size > 0, "injected cache should have entries");
    } finally {
      cleanup(dir);
    }
  });
});
