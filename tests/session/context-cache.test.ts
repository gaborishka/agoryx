import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ContextCache, type CachedStaticContext } from "../../internal/session/context-cache.js";
import type { Message } from "../../internal/events/types.js";

function makeCachedEntry(overrides?: Partial<CachedStaticContext>): CachedStaticContext {
  return {
    messages: [
      {
        id: "system-prompt",
        roomId: "room_1",
        author: "system",
        role: "system",
        text: "You are a helpful assistant.",
        format: "plain",
        metadata: {},
        createdAt: new Date().toISOString(),
      },
    ],
    tokenCount: 7,
    hash: "test-hash",
    cachedAt: Date.now(),
    ...overrides,
  };
}

describe("ContextCache.buildKey", () => {
  it("produces consistent keys for same inputs", () => {
    const k1 = ContextCache.buildKey("room_1", "sys prompt", ["pin_a", "pin_b"], "workspace");
    const k2 = ContextCache.buildKey("room_1", "sys prompt", ["pin_a", "pin_b"], "workspace");
    assert.equal(k1, k2);
  });

  it("produces consistent keys regardless of pin order", () => {
    const k1 = ContextCache.buildKey("room_1", "sys prompt", ["pin_b", "pin_a"], "workspace");
    const k2 = ContextCache.buildKey("room_1", "sys prompt", ["pin_a", "pin_b"], "workspace");
    assert.equal(k1, k2);
  });

  it("produces different keys for different system prompts", () => {
    const k1 = ContextCache.buildKey("room_1", "prompt A", [], undefined);
    const k2 = ContextCache.buildKey("room_1", "prompt B", [], undefined);
    assert.notEqual(k1, k2);
  });

  it("produces different keys for different rooms", () => {
    const k1 = ContextCache.buildKey("room_1", "sys", [], undefined);
    const k2 = ContextCache.buildKey("room_2", "sys", [], undefined);
    assert.notEqual(k1, k2);
  });

  it("produces different keys for different pin sets", () => {
    const k1 = ContextCache.buildKey("room_1", "sys", ["pin_a"], undefined);
    const k2 = ContextCache.buildKey("room_1", "sys", ["pin_b"], undefined);
    assert.notEqual(k1, k2);
  });

  it("produces different keys for different workspace blocks", () => {
    const k1 = ContextCache.buildKey("room_1", "sys", [], "workspace A");
    const k2 = ContextCache.buildKey("room_1", "sys", [], "workspace B");
    assert.notEqual(k1, k2);
  });

  it("handles undefined system prompt and workspace", () => {
    const k1 = ContextCache.buildKey("room_1", undefined, [], undefined);
    const k2 = ContextCache.buildKey("room_1", undefined, [], undefined);
    assert.equal(k1, k2);
  });
});

describe("ContextCache get/set", () => {
  it("returns cached entry on hit", () => {
    const cache = new ContextCache();
    const key = "room_1:abc";
    const entry = makeCachedEntry();
    cache.set(key, entry);

    const result = cache.get(key);
    assert.deepEqual(result, entry);
  });

  it("returns null on cache miss", () => {
    const cache = new ContextCache();
    assert.equal(cache.get("nonexistent"), null);
  });

  it("returns null for expired entries", () => {
    const cache = new ContextCache({ ttlMs: 50 });
    const key = "room_1:abc";
    const entry = makeCachedEntry({ cachedAt: Date.now() - 100 });
    cache.set(key, entry);

    const result = cache.get(key);
    assert.equal(result, null);
    // Expired entry should also be removed from the map
    assert.equal(cache.size, 0);
  });

  it("returns entry that is still within TTL", () => {
    const cache = new ContextCache({ ttlMs: 10_000 });
    const key = "room_1:abc";
    const entry = makeCachedEntry({ cachedAt: Date.now() - 5_000 });
    cache.set(key, entry);

    const result = cache.get(key);
    assert.notEqual(result, null);
    assert.equal(result!.tokenCount, entry.tokenCount);
  });
});

describe("ContextCache.invalidateRoom", () => {
  it("removes all entries for the specified room", () => {
    const cache = new ContextCache();
    cache.set("room_1:hash1", makeCachedEntry());
    cache.set("room_1:hash2", makeCachedEntry());
    cache.set("room_2:hash1", makeCachedEntry());

    cache.invalidateRoom("room_1");

    assert.equal(cache.get("room_1:hash1"), null);
    assert.equal(cache.get("room_1:hash2"), null);
    assert.notEqual(cache.get("room_2:hash1"), null);
    assert.equal(cache.size, 1);
  });

  it("does nothing if no entries match the room", () => {
    const cache = new ContextCache();
    cache.set("room_1:hash1", makeCachedEntry());

    cache.invalidateRoom("room_99");

    assert.equal(cache.size, 1);
  });
});

describe("ContextCache.clear", () => {
  it("removes all entries", () => {
    const cache = new ContextCache();
    cache.set("room_1:a", makeCachedEntry());
    cache.set("room_2:b", makeCachedEntry());
    cache.set("room_3:c", makeCachedEntry());

    cache.clear();

    assert.equal(cache.size, 0);
    assert.equal(cache.get("room_1:a"), null);
    assert.equal(cache.get("room_2:b"), null);
    assert.equal(cache.get("room_3:c"), null);
  });
});

describe("ContextCache max entries eviction", () => {
  it("evicts oldest entry when at capacity", () => {
    const cache = new ContextCache({ maxEntries: 3 });
    cache.set("room_1:a", makeCachedEntry({ hash: "a" }));
    cache.set("room_1:b", makeCachedEntry({ hash: "b" }));
    cache.set("room_1:c", makeCachedEntry({ hash: "c" }));

    // Adding a 4th entry should evict the oldest (a)
    cache.set("room_1:d", makeCachedEntry({ hash: "d" }));

    assert.equal(cache.size, 3);
    assert.equal(cache.get("room_1:a"), null); // evicted
    assert.notEqual(cache.get("room_1:b"), null);
    assert.notEqual(cache.get("room_1:c"), null);
    assert.notEqual(cache.get("room_1:d"), null);
  });

  it("accessing an entry refreshes its LRU position", () => {
    const cache = new ContextCache({ maxEntries: 3 });
    cache.set("room_1:a", makeCachedEntry({ hash: "a" }));
    cache.set("room_1:b", makeCachedEntry({ hash: "b" }));
    cache.set("room_1:c", makeCachedEntry({ hash: "c" }));

    // Access 'a' to refresh it
    cache.get("room_1:a");

    // Now 'b' is the oldest; adding a new entry should evict 'b'
    cache.set("room_1:d", makeCachedEntry({ hash: "d" }));

    assert.equal(cache.size, 3);
    assert.notEqual(cache.get("room_1:a"), null); // refreshed, should survive
    assert.equal(cache.get("room_1:b"), null);     // evicted
    assert.notEqual(cache.get("room_1:c"), null);
    assert.notEqual(cache.get("room_1:d"), null);
  });

  it("overwriting an existing key does not increase size", () => {
    const cache = new ContextCache({ maxEntries: 3 });
    cache.set("room_1:a", makeCachedEntry({ hash: "a1" }));
    cache.set("room_1:b", makeCachedEntry({ hash: "b1" }));

    // Overwrite 'a'
    cache.set("room_1:a", makeCachedEntry({ hash: "a2" }));

    assert.equal(cache.size, 2);
    const result = cache.get("room_1:a");
    assert.equal(result!.hash, "a2");
  });
});

describe("ContextCache.size", () => {
  it("returns 0 for empty cache", () => {
    const cache = new ContextCache();
    assert.equal(cache.size, 0);
  });

  it("tracks additions accurately", () => {
    const cache = new ContextCache();
    cache.set("room_1:a", makeCachedEntry());
    assert.equal(cache.size, 1);
    cache.set("room_1:b", makeCachedEntry());
    assert.equal(cache.size, 2);
  });

  it("tracks removals via invalidateRoom", () => {
    const cache = new ContextCache();
    cache.set("room_1:a", makeCachedEntry());
    cache.set("room_1:b", makeCachedEntry());
    cache.invalidateRoom("room_1");
    assert.equal(cache.size, 0);
  });

  it("tracks removals via clear", () => {
    const cache = new ContextCache();
    cache.set("room_1:a", makeCachedEntry());
    cache.clear();
    assert.equal(cache.size, 0);
  });
});
