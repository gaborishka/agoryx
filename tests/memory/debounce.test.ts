import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { SQLiteStore } from "../../internal/storage/sqlite.js";
import { MemoryService } from "../../internal/memory/service.js";
import type { RoomConfig } from "../../internal/events/types.js";

const ROOM_CONFIG: RoomConfig = {
  mode: "manual",
  checkpointThreshold: 10,
  maxHistoryMessages: 100,
  maxContextTokens: 4_000,
};

const makeStore = (): SQLiteStore => {
  const store = new SQLiteStore(":memory:");
  store.init();
  return store;
};

test("multiple rapid semantic events trigger one debounced render", async () => {
  const store = makeStore();
  const writes: string[] = [];
  let service: MemoryService | null = null;
  try {
    const room = store.createRoom("debounce", ["user"], ROOM_CONFIG);
    service = new MemoryService(store, {
      rootDir: "/tmp/agoryx-memory",
      debounceMs: 30,
      writer: (_root, content) => {
        writes.push(content);
        return "/tmp/agoryx-memory/.agoryx/memory.md";
      },
    });

    service.recordDecision(room.id, "Decision A");
    service.recordNote(room.id, "Note A");
    service.recordWorktreeRemove(room.id, "codex", "/tmp/wt/codex");

    await wait(150);
    assert.equal(writes.length, 1);
  } finally {
    service?.dispose();
    store.close();
  }
});

test("decision event triggers memory render after debounce window", async () => {
  const store = makeStore();
  const writes: string[] = [];
  let service: MemoryService | null = null;
  try {
    const room = store.createRoom("debounce-decision", ["user"], ROOM_CONFIG);
    service = new MemoryService(store, {
      rootDir: "/tmp/agoryx-memory",
      debounceMs: 30,
      writer: (_root, content) => {
        writes.push(content);
        return "/tmp/agoryx-memory/.agoryx/memory.md";
      },
    });

    service.recordDecision(room.id, "Use shared renderer");
    await wait(150);

    assert.equal(writes.length, 1);
    assert.match(writes[0], /Use shared renderer/);
  } finally {
    service?.dispose();
    store.close();
  }
});

test("worktree_create event triggers memory render after debounce window", async () => {
  const store = makeStore();
  const writes: string[] = [];
  let service: MemoryService | null = null;
  try {
    const room = store.createRoom("debounce-worktree", ["user"], ROOM_CONFIG);
    service = new MemoryService(store, {
      rootDir: "/tmp/agoryx-memory",
      debounceMs: 30,
      writer: (_root, content) => {
        writes.push(content);
        return "/tmp/agoryx-memory/.agoryx/memory.md";
      },
    });

    service.recordWorktreeCreate(room.id, "codex", "/tmp/wt/codex", "agoryx/codex-main");
    await wait(150);

    assert.equal(writes.length, 1);
    assert.match(writes[0], /\| engine \| worktree_create \|/);
  } finally {
    service?.dispose();
    store.close();
  }
});
