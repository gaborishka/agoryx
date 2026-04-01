import { readFileSync, statSync } from "node:fs";

export interface FileCacheOptions {
  /** Maximum number of cached entries. Default: 50 */
  maxEntries?: number;
  /** Maximum total bytes across all cached entries. Default: 2MB */
  maxTotalBytes?: number;
  /** Time-to-live in milliseconds. Entries older than this are re-validated. Default: 60s */
  ttlMs?: number;
}

interface CacheEntry {
  content: string;
  mtimeMs: number;
  byteLength: number;
  cachedAt: number;
}

/**
 * In-memory file cache with TTL, mtime-based invalidation, and size limits.
 *
 * On `get(path)`:
 * 1. If the entry exists and TTL has not expired, return cached content.
 * 2. If TTL expired, stat the file: if mtime unchanged, refresh TTL and return cached content.
 * 3. Otherwise, re-read the file, update the entry.
 * 4. Returns `null` if the file cannot be read (ENOENT, EPERM, etc.).
 */
export class FileCache {
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;
  private readonly ttlMs: number;
  private readonly entries = new Map<string, CacheEntry>();
  private totalBytes = 0;

  constructor(options: FileCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 50;
    this.maxTotalBytes = options.maxTotalBytes ?? 2 * 1024 * 1024;
    this.ttlMs = options.ttlMs ?? 60_000;
  }

  /**
   * Read a file, returning cached content when possible.
   * Returns `null` if the file does not exist or cannot be read.
   */
  public get(filePath: string): string | null {
    const now = Date.now();
    const existing = this.entries.get(filePath);

    if (existing) {
      // Fast path: TTL not expired
      if (now - existing.cachedAt < this.ttlMs) {
        return existing.content;
      }

      // TTL expired — check if file changed via mtime
      try {
        const stat = statSync(filePath);
        if (stat.mtimeMs === existing.mtimeMs) {
          // File unchanged — refresh TTL
          existing.cachedAt = now;
          return existing.content;
        }
      } catch {
        // File gone or unreadable — evict
        this.evict(filePath);
        return null;
      }
    }

    // Cache miss or stale — read from disk
    try {
      const content = readFileSync(filePath, "utf-8");
      const stat = statSync(filePath);
      this.put(filePath, content, stat.mtimeMs, now);
      return content;
    } catch {
      return null;
    }
  }

  /** Remove a specific entry from the cache. */
  public invalidate(filePath: string): void {
    this.evict(filePath);
  }

  /** Clear the entire cache. */
  public clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  /** Number of cached entries. */
  public get size(): number {
    return this.entries.size;
  }

  /** Total bytes of cached file content. */
  public get bytes(): number {
    return this.totalBytes;
  }

  private put(filePath: string, content: string, mtimeMs: number, now: number): void {
    const byteLength = Buffer.byteLength(content, "utf-8");

    // Evict the old entry for this path if present
    this.evict(filePath);

    // Evict LRU entries if we exceed limits
    while (
      this.entries.size >= this.maxEntries ||
      this.totalBytes + byteLength > this.maxTotalBytes
    ) {
      const oldest = this.findOldestEntry();
      if (!oldest) break;
      this.evict(oldest);
    }

    // If a single file exceeds the budget, still cache it (but it will be alone)
    this.entries.set(filePath, { content, mtimeMs, byteLength, cachedAt: now });
    this.totalBytes += byteLength;
  }

  private evict(filePath: string): void {
    const entry = this.entries.get(filePath);
    if (entry) {
      this.totalBytes -= entry.byteLength;
      this.entries.delete(filePath);
    }
  }

  private findOldestEntry(): string | null {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of this.entries) {
      if (entry.cachedAt < oldestTime) {
        oldestTime = entry.cachedAt;
        oldestKey = key;
      }
    }
    return oldestKey;
  }
}
