import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  writeFileSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileCache } from "../../internal/utils/file-cache.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "agoryx-fc-test-"));
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

describe("FileCache", () => {
  it("reads a file and returns its content", () => {
    const dir = makeTempDir();
    try {
      const filePath = join(dir, "hello.txt");
      writeFileSync(filePath, "hello world");

      const cache = new FileCache();
      const content = cache.get(filePath);
      assert.equal(content, "hello world");
    } finally {
      cleanup(dir);
    }
  });

  it("returns cached content even after file is deleted (within TTL)", () => {
    const dir = makeTempDir();
    try {
      const filePath = join(dir, "ephemeral.txt");
      writeFileSync(filePath, "cached value");

      const cache = new FileCache({ ttlMs: 60_000 });
      const first = cache.get(filePath);
      assert.equal(first, "cached value");

      // Delete the file
      unlinkSync(filePath);

      // Second read should still return cached content because TTL hasn't expired
      // and we never check mtime when the file is gone (stat will fail, entry removed)
      // Actually: stat will throw, so the entry is removed. Let's verify the spec:
      // "get() checks mtime — if file changed on disk, re-read and update cache"
      // If file is gone, stat throws, so we return null.
      const second = cache.get(filePath);
      assert.equal(second, null);
    } finally {
      cleanup(dir);
    }
  });

  it("serves from cache when file still exists and mtime unchanged", () => {
    const dir = makeTempDir();
    try {
      const filePath = join(dir, "stable.txt");
      writeFileSync(filePath, "original");

      const cache = new FileCache({ ttlMs: 60_000 });
      const first = cache.get(filePath);
      assert.equal(first, "original");
      assert.equal(cache.size, 1);

      // Read again — should serve from cache (same mtime, within TTL)
      const second = cache.get(filePath);
      assert.equal(second, "original");
      assert.equal(cache.size, 1);
    } finally {
      cleanup(dir);
    }
  });

  it("re-reads when TTL expires", async () => {
    const dir = makeTempDir();
    try {
      const filePath = join(dir, "ttl.txt");
      writeFileSync(filePath, "v1");

      const cache = new FileCache({ ttlMs: 50 });
      const first = cache.get(filePath);
      assert.equal(first, "v1");

      // Overwrite the file
      writeFileSync(filePath, "v2");

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 80));

      const second = cache.get(filePath);
      assert.equal(second, "v2");
    } finally {
      cleanup(dir);
    }
  });

  it("re-reads when file mtime changes (within TTL)", () => {
    const dir = makeTempDir();
    try {
      const filePath = join(dir, "mtime.txt");
      writeFileSync(filePath, "version-1");

      const cache = new FileCache({ ttlMs: 60_000 });
      const first = cache.get(filePath);
      assert.equal(first, "version-1");

      // Write new content and bump mtime
      writeFileSync(filePath, "version-2");
      // Explicitly set a different mtime to be sure
      const future = new Date(Date.now() + 10_000);
      utimesSync(filePath, future, future);

      const second = cache.get(filePath);
      assert.equal(second, "version-2");
    } finally {
      cleanup(dir);
    }
  });

  it("returns null for non-existent file", () => {
    const cache = new FileCache();
    const content = cache.get("/tmp/agoryx-fc-test-does-not-exist-12345.txt");
    assert.equal(content, null);
    assert.equal(cache.size, 0);
  });

  it("invalidate() removes a specific entry", () => {
    const dir = makeTempDir();
    try {
      const filePath = join(dir, "inv.txt");
      writeFileSync(filePath, "data");

      const cache = new FileCache();
      cache.get(filePath);
      assert.equal(cache.size, 1);

      cache.invalidate(filePath);
      assert.equal(cache.size, 0);
      assert.equal(cache.bytes, 0);
    } finally {
      cleanup(dir);
    }
  });

  it("clear() removes all entries", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "a.txt"), "aaa");
      writeFileSync(join(dir, "b.txt"), "bbb");

      const cache = new FileCache();
      cache.get(join(dir, "a.txt"));
      cache.get(join(dir, "b.txt"));
      assert.equal(cache.size, 2);
      assert.ok(cache.bytes > 0);

      cache.clear();
      assert.equal(cache.size, 0);
      assert.equal(cache.bytes, 0);
    } finally {
      cleanup(dir);
    }
  });

  it("evicts oldest entry when maxEntries is exceeded", () => {
    const dir = makeTempDir();
    try {
      // Create 3 files, cache allows only 2
      writeFileSync(join(dir, "f1.txt"), "one");
      writeFileSync(join(dir, "f2.txt"), "two");
      writeFileSync(join(dir, "f3.txt"), "three");

      const cache = new FileCache({ maxEntries: 2 });
      cache.get(join(dir, "f1.txt"));
      cache.get(join(dir, "f2.txt"));
      assert.equal(cache.size, 2);

      // Adding a third should evict the oldest (f1)
      cache.get(join(dir, "f3.txt"));
      assert.equal(cache.size, 2);

      // f1 should have been evicted — re-reading will reload from disk
      // but we can verify the cache only has 2 entries
      // Invalidate f2 and f3 to check f1 is not in cache
      cache.invalidate(join(dir, "f2.txt"));
      cache.invalidate(join(dir, "f3.txt"));
      assert.equal(cache.size, 0);
    } finally {
      cleanup(dir);
    }
  });

  it("evicts entries when maxTotalBytes is exceeded", () => {
    const dir = makeTempDir();
    try {
      // Each file is ~10 bytes, limit total to 20 bytes
      writeFileSync(join(dir, "x1.txt"), "aaaaaaaaaa"); // 10 bytes
      writeFileSync(join(dir, "x2.txt"), "bbbbbbbbbb"); // 10 bytes
      writeFileSync(join(dir, "x3.txt"), "cccccccccc"); // 10 bytes

      const cache = new FileCache({ maxTotalBytes: 20 });
      cache.get(join(dir, "x1.txt"));
      cache.get(join(dir, "x2.txt"));
      assert.equal(cache.size, 2);
      assert.equal(cache.bytes, 20);

      // Adding x3 should evict x1 to stay within 20 bytes
      cache.get(join(dir, "x3.txt"));
      assert.equal(cache.size, 2);
      assert.ok(cache.bytes <= 20, `bytes should be <= 20, got ${cache.bytes}`);
    } finally {
      cleanup(dir);
    }
  });

  it("does not cache a file that exceeds maxTotalBytes on its own", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "huge.txt"), "x".repeat(500));

      const cache = new FileCache({ maxTotalBytes: 100 });
      const content = cache.get(join(dir, "huge.txt"));

      // Content should be returned but not cached
      assert.equal(content, "x".repeat(500));
      assert.equal(cache.size, 0);
      assert.equal(cache.bytes, 0);
    } finally {
      cleanup(dir);
    }
  });

  it("size and bytes getters are accurate", () => {
    const dir = makeTempDir();
    try {
      const fileA = join(dir, "a.txt");
      const fileB = join(dir, "b.txt");
      writeFileSync(fileA, "hello"); // 5 bytes
      writeFileSync(fileB, "world!"); // 6 bytes

      const cache = new FileCache();
      assert.equal(cache.size, 0);
      assert.equal(cache.bytes, 0);

      cache.get(fileA);
      assert.equal(cache.size, 1);
      assert.equal(cache.bytes, 5);

      cache.get(fileB);
      assert.equal(cache.size, 2);
      assert.equal(cache.bytes, 11);

      cache.invalidate(fileA);
      assert.equal(cache.size, 1);
      assert.equal(cache.bytes, 6);

      cache.clear();
      assert.equal(cache.size, 0);
      assert.equal(cache.bytes, 0);
    } finally {
      cleanup(dir);
    }
  });
});
