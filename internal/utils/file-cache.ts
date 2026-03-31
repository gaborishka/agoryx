import { readFileSync, statSync } from "node:fs";

export interface FileCacheOptions {
  /** Max number of entries. Default: 100 */
  maxEntries?: number;
  /** Max total size in bytes across all entries. Default: 2MB */
  maxTotalBytes?: number;
  /** TTL in milliseconds. Default: 30_000 (30s) */
  ttlMs?: number;
}

interface CacheEntry {
  content: string;
  sizeBytes: number;
  mtimeMs: number;
  cachedAt: number;
}

export class FileCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;
  private readonly ttlMs: number;
  private totalBytes = 0;

  constructor(options: FileCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 100;
    this.maxTotalBytes = options.maxTotalBytes ?? 2 * 1024 * 1024;
    this.ttlMs = options.ttlMs ?? 30_000;
  }

  /**
   * Get file content. Returns cached content if:
   * - Entry exists, is not expired, and file mtime hasn't changed.
   * Otherwise reads from disk, caches, and returns.
   * Returns null if file doesn't exist or can't be read.
   */
  get(filePath: string): string | null {
    const now = Date.now();
    const existing = this.cache.get(filePath);

    if (existing) {
      const expired = now - existing.cachedAt >= this.ttlMs;
      if (!expired) {
        // Check mtime to detect on-disk changes within TTL
        try {
          const stat = statSync(filePath);
          if (stat.mtimeMs === existing.mtimeMs) {
            return existing.content;
          }
          // mtime changed — fall through to re-read
        } catch {
          // File gone — remove entry and return null
          this.removeEntry(filePath);
          return null;
        }
      }
      // Expired or mtime changed — remove stale entry before re-read
      this.removeEntry(filePath);
    }

    // Read from disk
    let content: string;
    let mtimeMs: number;
    try {
      const stat = statSync(filePath);
      mtimeMs = stat.mtimeMs;
      content = readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }

    const sizeBytes = Buffer.byteLength(content, "utf-8");

    // If a single file exceeds maxTotalBytes, don't cache it
    if (sizeBytes > this.maxTotalBytes) {
      return content;
    }

    // Evict until there is room
    while (
      this.cache.size >= this.maxEntries ||
      this.totalBytes + sizeBytes > this.maxTotalBytes
    ) {
      if (this.cache.size === 0) break;
      this.evict();
    }

    this.cache.set(filePath, {
      content,
      sizeBytes,
      mtimeMs,
      cachedAt: now,
    });
    this.totalBytes += sizeBytes;

    return content;
  }

  /** Invalidate a specific entry. */
  invalidate(filePath: string): void {
    this.removeEntry(filePath);
  }

  /** Clear all cached entries. */
  clear(): void {
    this.cache.clear();
    this.totalBytes = 0;
  }

  /** Number of cached entries. */
  get size(): number {
    return this.cache.size;
  }

  /** Total bytes of cached content. */
  get bytes(): number {
    return this.totalBytes;
  }

  /** Remove a single entry and adjust totalBytes. */
  private removeEntry(filePath: string): void {
    const entry = this.cache.get(filePath);
    if (entry) {
      this.totalBytes -= entry.sizeBytes;
      this.cache.delete(filePath);
    }
  }

  /** Evict the oldest entry by cachedAt (LRU). */
  private evict(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.cachedAt < oldestTime) {
        oldestTime = entry.cachedAt;
        oldestKey = key;
      }
    }

    if (oldestKey !== null) {
      this.removeEntry(oldestKey);
    }
  }
}
