/**
 * Context Cache
 *
 * Caches the static portions of a built context (system prompt, workspace
 * block, pinned context messages) so that repeated buildFullContext calls
 * for the same room can skip re-serialising those sections.
 *
 * The cache key is derived from room ID, system prompt text, pinned context
 * IDs (order-sensitive), and workspace block text. Any change to those
 * inputs produces a different key and therefore a cache miss.
 */

import { createHash } from "node:crypto";
import type { Message } from "../events/types.js";

export interface CachedStaticContext {
  /** The static Message objects (system-prompt, workspace-context, pins). */
  messages: Message[];
  /** Token estimate for cached messages (chars / 4, ceiling). */
  tokenCount: number;
  /** The cache key hash that produced this entry. */
  hash: string;
  /** Timestamp when this entry was cached. */
  cachedAt: number;
}

/**
 * In-memory LRU-ish context cache keyed by a deterministic hash.
 *
 * - One entry per unique (room + static-inputs) combination.
 * - invalidateRoom() drops all entries whose key starts with the room prefix.
 * - Bounded by maxEntries to prevent unbounded growth.
 */
export class ContextCache {
  private readonly entries = new Map<string, CachedStaticContext>();
  private readonly roomIndex = new Map<string, Set<string>>();
  private readonly maxEntries: number;

  constructor(maxEntries = 64) {
    this.maxEntries = maxEntries;
  }

  /**
   * Build a deterministic cache key from the inputs that define static context.
   */
  static buildKey(
    roomId: string,
    systemPrompt: string | undefined,
    pinIds: string[],
    workspaceBlock: string | undefined,
  ): string {
    const h = createHash("sha256");
    h.update(roomId);
    h.update("\0");
    h.update(systemPrompt ?? "");
    h.update("\0");
    h.update(pinIds.join(","));
    h.update("\0");
    h.update(workspaceBlock ?? "");
    return `${roomId}:${h.digest("hex").slice(0, 16)}`;
  }

  get(key: string): CachedStaticContext | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: CachedStaticContext): void {
    // Evict oldest entry if at capacity (simple FIFO via insertion order)
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.deleteEntry(oldest);
    }

    this.entries.set(key, value);

    // Update room index
    const roomId = key.split(":")[0];
    let roomKeys = this.roomIndex.get(roomId);
    if (!roomKeys) {
      roomKeys = new Set();
      this.roomIndex.set(roomId, roomKeys);
    }
    roomKeys.add(key);
  }

  /**
   * Invalidate all cached entries for a given room.
   */
  invalidateRoom(roomId: string): void {
    const keys = this.roomIndex.get(roomId);
    if (!keys) return;
    for (const key of keys) {
      this.entries.delete(key);
    }
    this.roomIndex.delete(roomId);
  }

  get size(): number {
    return this.entries.size;
  }

  private deleteEntry(key: string): void {
    this.entries.delete(key);
    const roomId = key.split(":")[0];
    const roomKeys = this.roomIndex.get(roomId);
    if (roomKeys) {
      roomKeys.delete(key);
      if (roomKeys.size === 0) {
        this.roomIndex.delete(roomId);
      }
    }
  }
}
