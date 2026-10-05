/**
 * Context cache for static prompt sections.
 *
 * Static sections (system prompt + pinned context + workspace block) rarely change
 * between dispatches in the same session. Caching them avoids re-serializing
 * and re-estimating tokens on every dispatch.
 *
 * The cache key is a hash of the inputs that produce the static section.
 * Cache is invalidated when pins change, system prompt changes, or workspace changes.
 */

import type { Message, PinnedContext } from "../events/types.js";

export interface CachedStaticContext {
  /** Pre-built system + pin + workspace messages */
  messages: Message[];
  /** Token count of the static portion */
  tokenCount: number;
  /** Hash of inputs that produced this cache entry */
  hash: string;
  /** Timestamp when cached */
  cachedAt: number;
}

/**
 * Simple djb2 hash — fast, non-crypto, good distribution for cache keys.
 */
function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff;
  }
  return hash.toString(36);
}

export class ContextCache {
  private entries = new Map<string, CachedStaticContext>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(options?: { maxEntries?: number; ttlMs?: number }) {
    this.maxEntries = options?.maxEntries ?? 50;
    this.ttlMs = options?.ttlMs ?? 60_000; // 1 minute default
  }

  /**
   * Build a cache key from the inputs that determine the static context.
   * Uses a simple hash of: systemPrompt + pin IDs + workspace block.
   */
  static buildKey(
    roomId: string,
    systemPrompt: string | undefined,
    pinIds: string[],
    workspaceBlock: string | undefined,
  ): string {
    const sorted = [...pinIds].sort();
    const raw = [
      systemPrompt ?? "",
      sorted.join(","),
      workspaceBlock ?? "",
    ].join("|");
    return `${roomId}:${simpleHash(raw)}`;
  }

  /** Get cached static context, or null if miss/expired. */
  get(key: string): CachedStaticContext | null {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    // Move to end for LRU freshness (delete + re-set keeps insertion order)
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  /** Store a static context result. */
  set(key: string, entry: CachedStaticContext): void {
    // If key already exists, delete first so it moves to end
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    // Evict oldest entry if at capacity
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
    this.entries.set(key, entry);
  }

  /** Invalidate all entries for a room. */
  invalidateRoom(roomId: string): void {
    const prefix = `${roomId}:`;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }
  }

  /** Clear entire cache. */
  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
