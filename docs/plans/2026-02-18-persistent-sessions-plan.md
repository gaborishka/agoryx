# Persistent Agent Sessions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move Agoryx from stateless per-turn spawning to persistent agent sessions where Claude and Codex maintain their own context windows between turns via native CLI `--resume` / `exec resume`.

**Architecture:** Thin `PersistentAdapter` contract with `sendTurn()` (cold/warm via `nativeSessionId: string | null`). Session Service owns delta computation, cursor management, concurrency lock, and error recovery. `agent_sessions` table in SQLite with monotonic `rowid`-based cursor and partial unique index. Adapters emit `session.bound` event with provider session ID. Engine orchestrates lifecycle with atomic post-turn transactions.

**Tech Stack:** TypeScript, `better-sqlite3` (sync), Node.js built-in test runner (`node:test`), `tsx --test` for running tests.

**Design doc:** `docs/plans/2026-02-18-persistent-sessions-design.md`

---

## Pre-flight

Before starting, verify current test count and typecheck:

```bash
npm run typecheck && npm test 2>&1 | tail -5
```

Record the starting test count (expected: 136 pass).

Also verify Codex resume syntax is available:

```bash
codex exec resume --help 2>&1 | head -5
```

Expected: `Resume a previous session by id...`

---

### Task 1: Extend canonical types

**Files:**
- Modify: `internal/events/types.ts`

**Purpose:** Add `SESSION_EXPIRED` to `ErrorClass`, `session.bound` to `EventType`, and `SessionBoundPayload` type.

**Step 1: Edit `internal/events/types.ts`**

Add `SESSION_EXPIRED` to `ErrorClass`:
```typescript
export type ErrorClass =
  | "AUTH_ERROR"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "PROCESS_CRASH"
  | "PROTOCOL_ERROR"
  | "SESSION_EXPIRED"
  | "UNKNOWN";
```

Add `session.bound` to `EventType`:
```typescript
export type EventType =
  | "message.started"
  | "message.delta"
  | "message.completed"
  | "message.error"
  | "session.bound"
  | "tool.call.started"
  | "tool.call.completed"
  | "agent.status"
  | "session.checkpoint";
```

Add `SessionBoundPayload` interface (after `MessageErrorPayload`):
```typescript
export interface SessionBoundPayload {
  nativeSessionId: string;
}
```

**Step 2: Verify typecheck passes**

```bash
npm run typecheck
```

Expected: no errors.

**Step 3: Run existing tests to verify no regressions**

```bash
npm test
```

Expected: all 136 pass.

**Step 4: Commit**

```bash
git add internal/events/types.ts
git commit -m "feat(types): add SESSION_EXPIRED, session.bound event type, SessionBoundPayload"
```

---

### Task 2: Add session.bound event factory

**Files:**
- Modify: `internal/adapters/event-factory.ts`
- Create: `tests/adapters/session-bound-event.test.ts`

**Step 1: Write failing test**

Create `tests/adapters/session-bound-event.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { sessionBound } from "../../internal/adapters/event-factory.js";

test("sessionBound creates event with session.bound type and nativeSessionId", () => {
  const event = sessionBound(
    { roomId: "room_1", sessionId: "sess_1", requestId: "req_1", source: "adapter.codex" },
    "thread_abc-123",
  );

  assert.equal(event.type, "session.bound");
  assert.equal(event.roomId, "room_1");
  assert.ok(event.eventId.startsWith("evt_"));
  const payload = event.payload as { nativeSessionId: string };
  assert.equal(payload.nativeSessionId, "thread_abc-123");
});
```

**Step 2: Run to verify failure**

```bash
npm test 2>&1 | grep -A2 "session-bound"
```

Expected: import error — `sessionBound` does not exist.

**Step 3: Add `sessionBound` to `internal/adapters/event-factory.ts`**

Add import at top:
```typescript
import type {
  ErrorClass,
  MessageEventPayload,
  MessageErrorPayload,
  SessionBoundPayload,
} from "../events/types.js";
```

Add factory function at the bottom of the file:
```typescript
export const sessionBound = (
  args: BaseArgs,
  nativeSessionId: string,
): AdapterEvent => ({
  eventId: createId("evt"),
  roomId: args.roomId,
  sessionId: args.sessionId,
  timestamp: nowIso(),
  source: args.source,
  type: "session.bound",
  requestId: args.requestId,
  payload: { nativeSessionId } satisfies SessionBoundPayload,
});
```

Note: `AdapterEvent` type in `adapter.ts` currently only allows `MessageEventPayload | MessageErrorPayload`. Update it:

In `internal/adapters/adapter.ts`, change:
```typescript
import type {
  ErrorClass,
  EventEnvelope,
  Message,
  MessageEventPayload,
  MessageErrorPayload,
  SessionBoundPayload,
} from "../events/types.js";
```

And update `AdapterEvent`:
```typescript
export type AdapterEvent =
  | EventEnvelope<MessageEventPayload>
  | EventEnvelope<MessageErrorPayload>
  | EventEnvelope<SessionBoundPayload>;
```

**Step 4: Run tests**

```bash
npm run typecheck && npm test
```

Expected: all pass including new test.

**Step 5: Commit**

```bash
git add internal/adapters/event-factory.ts internal/adapters/adapter.ts \
        internal/events/types.ts tests/adapters/session-bound-event.test.ts
git commit -m "feat(events): add session.bound event factory and adapter event type"
```

---

### Task 3: Add `agent_sessions` storage schema and CRUD

**Files:**
- Modify: `internal/storage/sqlite.ts`
- Create: `tests/storage/agent-sessions.test.ts`

**Step 1: Write failing tests**

Create `tests/storage/agent-sessions.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../../internal/storage/sqlite.js";
import type { RoomConfig } from "../../internal/events/types.js";

const ROOM_CONFIG: RoomConfig = {
  mode: "manual",
  checkpointThreshold: 10,
  maxHistoryMessages: 100,
  maxContextTokens: 4000,
};

test("createAgentSession creates new active session", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const sess = store.createAgentSession(room.id, "claude");

    assert.ok(sess.id.startsWith("agtsess_"));
    assert.equal(sess.roomId, room.id);
    assert.equal(sess.agentName, "claude");
    assert.equal(sess.nativeSessionId, null);
    assert.equal(sess.status, "active");
    assert.equal(sess.lastSeenSeq, null);
    assert.equal(sess.failCount, 0);
    assert.equal(sess.transportMode, "resume");
    assert.ok(typeof sess.createdAt === "number");
  } finally {
    store.close();
  }
});

test("getActiveAgentSession returns active session for room+agent", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const created = store.createAgentSession(room.id, "claude");
    const found = store.getActiveAgentSession(room.id, "claude");

    assert.ok(found);
    assert.equal(found.id, created.id);
  } finally {
    store.close();
  }
});

test("getActiveAgentSession returns null when no active session", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const result = store.getActiveAgentSession(room.id, "claude");
    assert.equal(result, null);
  } finally {
    store.close();
  }
});

test("updateAgentSessionNativeId saves native session ID", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const sess = store.createAgentSession(room.id, "claude");
    store.updateAgentSessionNativeId(sess.id, "thread_abc");

    const updated = store.getActiveAgentSession(room.id, "claude");
    assert.equal(updated!.nativeSessionId, "thread_abc");
  } finally {
    store.close();
  }
});

test("updateAgentSessionNativeId ignores empty string", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const sess = store.createAgentSession(room.id, "claude");
    store.updateAgentSessionNativeId(sess.id, "thread_abc");
    store.updateAgentSessionNativeId(sess.id, "");

    const updated = store.getActiveAgentSession(room.id, "claude");
    assert.equal(updated!.nativeSessionId, "thread_abc");
  } finally {
    store.close();
  }
});

test("updateAgentSessionCursor uses MAX semantics", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const sess = store.createAgentSession(room.id, "claude");

    store.updateAgentSessionCursor(sess.id, 10);
    store.updateAgentSessionCursor(sess.id, 5); // should not rollback

    const updated = store.getActiveAgentSession(room.id, "claude");
    assert.equal(updated!.lastSeenSeq, 10);
  } finally {
    store.close();
  }
});

test("updateAgentSessionStatus transitions to expired", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const sess = store.createAgentSession(room.id, "claude");
    store.updateAgentSessionStatus(sess.id, "expired");

    const active = store.getActiveAgentSession(room.id, "claude");
    assert.equal(active, null); // expired is not active
  } finally {
    store.close();
  }
});

test("creating new session after expired is allowed by partial unique index", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const first = store.createAgentSession(room.id, "claude");
    store.updateAgentSessionStatus(first.id, "expired");

    const second = store.createAgentSession(room.id, "claude");
    assert.notEqual(first.id, second.id);
    assert.equal(second.status, "active");
  } finally {
    store.close();
  }
});

test("incrementAgentSessionFailCount increments and returns new count", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const sess = store.createAgentSession(room.id, "claude");

    const count1 = store.incrementAgentSessionFailCount(sess.id);
    assert.equal(count1, 1);
    const count2 = store.incrementAgentSessionFailCount(sess.id);
    assert.equal(count2, 2);
  } finally {
    store.close();
  }
});

test("listActiveAgentSessions returns only active sessions", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    store.createAgentSession(room.id, "claude");
    const codexSess = store.createAgentSession(room.id, "codex");
    store.updateAgentSessionStatus(codexSess.id, "failed");

    const active = store.listActiveAgentSessions(room.id);
    assert.equal(active.length, 1);
    assert.equal(active[0].agentName, "claude");
  } finally {
    store.close();
  }
});

test("getMaxMessageSeq returns null for empty room", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    assert.equal(store.getMaxMessageSeq(room.id), null);
  } finally {
    store.close();
  }
});

test("getMaxMessageSeq returns rowid of latest message", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    store.saveMessage({
      id: "msg_1", roomId: room.id, author: "user", role: "user",
      text: "hello", format: "plain", metadata: {}, createdAt: "2026-01-01T00:00:00Z",
    });
    store.saveMessage({
      id: "msg_2", roomId: room.id, author: "agent.claude", role: "assistant",
      text: "hi", format: "plain", metadata: {}, createdAt: "2026-01-01T00:00:01Z",
    });

    const seq = store.getMaxMessageSeq(room.id);
    assert.ok(typeof seq === "number");
    assert.ok(seq > 0);
  } finally {
    store.close();
  }
});

test("listMessagesDelta returns messages after seq excluding author", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    store.saveMessage({
      id: "msg_1", roomId: room.id, author: "user", role: "user",
      text: "first", format: "plain", metadata: {}, createdAt: "2026-01-01T00:00:00Z",
    });
    const seq1 = store.getMaxMessageSeq(room.id)!;

    store.saveMessage({
      id: "msg_2", roomId: room.id, author: "agent.claude", role: "assistant",
      text: "response", format: "plain", metadata: {}, createdAt: "2026-01-01T00:00:01Z",
    });
    store.saveMessage({
      id: "msg_3", roomId: room.id, author: "user", role: "user",
      text: "second", format: "plain", metadata: {}, createdAt: "2026-01-01T00:00:02Z",
    });
    store.saveMessage({
      id: "msg_4", roomId: room.id, author: "agent.codex", role: "assistant",
      text: "codex says hi", format: "plain", metadata: {}, createdAt: "2026-01-01T00:00:03Z",
    });
    const cutoff = store.getMaxMessageSeq(room.id)!;

    // Delta for claude: should see msg_3 (user) and msg_4 (codex), not msg_2 (own)
    const delta = store.listMessagesDelta(room.id, seq1, cutoff, "agent.claude");
    assert.equal(delta.length, 2);
    assert.equal(delta[0].id, "msg_3");
    assert.equal(delta[1].id, "msg_4");
  } finally {
    store.close();
  }
});

test("listMessagesDelta returns empty when no new messages", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    store.saveMessage({
      id: "msg_1", roomId: room.id, author: "user", role: "user",
      text: "hello", format: "plain", metadata: {}, createdAt: "2026-01-01T00:00:00Z",
    });
    const seq = store.getMaxMessageSeq(room.id)!;

    const delta = store.listMessagesDelta(room.id, seq, seq, "agent.claude");
    assert.equal(delta.length, 0);
  } finally {
    store.close();
  }
});
```

**Step 2: Run to verify failure**

```bash
npm test 2>&1 | grep -c "FAIL"
```

Expected: failures — methods don't exist yet.

**Step 3: Add `AgentSession` interface and schema to `internal/storage/sqlite.ts`**

Add interface after existing row interfaces (around line 60):

```typescript
export interface AgentSession {
  id: string;
  roomId: string;
  agentName: string;
  nativeSessionId: string | null;
  transportMode: "resume" | "interactive";
  status: "active" | "expired" | "failed";
  lastSeenSeq: number | null;
  failCount: number;
  createdAt: number;
  lastTurnAt: number | null;
}

interface AgentSessionRow {
  id: string;
  room_id: string;
  agent_name: string;
  native_session_id: string | null;
  transport_mode: string;
  status: string;
  last_seen_seq: number | null;
  fail_count: number;
  created_at: number;
  last_turn_at: number | null;
}
```

Add table creation to `init()`, after the `events_log` index:

```sql
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  native_session_id TEXT,
  transport_mode TEXT NOT NULL DEFAULT 'resume'
    CHECK(transport_mode IN ('resume', 'interactive')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active', 'expired', 'failed')),
  last_seen_seq INTEGER,
  fail_count INTEGER NOT NULL DEFAULT 0
    CHECK(fail_count >= 0),
  created_at INTEGER NOT NULL,
  last_turn_at INTEGER,
  FOREIGN KEY(room_id) REFERENCES rooms(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_sessions_active
  ON agent_sessions(room_id, agent_name)
  WHERE status = 'active';
```

**Step 4: Add CRUD methods to `SQLiteStore`**

Add before `close()`:

```typescript
public createAgentSession(roomId: string, agentName: string): AgentSession {
  const id = createId("agtsess");
  const now = Date.now();
  this.db
    .prepare(
      `INSERT INTO agent_sessions (id, room_id, agent_name, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(id, roomId, agentName, now);
  return this.getAgentSessionById(id)!;
}

public getActiveAgentSession(roomId: string, agentName: string): AgentSession | null {
  const row = this.db
    .prepare(
      `SELECT * FROM agent_sessions
       WHERE room_id = ? AND agent_name = ? AND status = 'active'`,
    )
    .get(roomId, agentName) as AgentSessionRow | undefined;
  return row ? agentSessionRowToDomain(row) : null;
}

public listActiveAgentSessions(roomId: string): AgentSession[] {
  const rows = this.db
    .prepare(
      `SELECT * FROM agent_sessions
       WHERE room_id = ? AND status = 'active'
       ORDER BY last_turn_at DESC, created_at DESC`,
    )
    .all(roomId) as AgentSessionRow[];
  return rows.map(agentSessionRowToDomain);
}

public updateAgentSessionNativeId(id: string, nativeId: string): void {
  if (!nativeId) return;
  this.db
    .prepare(
      `UPDATE agent_sessions
       SET native_session_id = ?, last_turn_at = ?
       WHERE id = ?`,
    )
    .run(nativeId, Date.now(), id);
}

public updateAgentSessionCursor(id: string, seq: number): void {
  this.db
    .prepare(
      `UPDATE agent_sessions
       SET last_seen_seq = MAX(COALESCE(last_seen_seq, 0), ?),
           last_turn_at = ?
       WHERE id = ?`,
    )
    .run(seq, Date.now(), id);
}

public updateAgentSessionStatus(
  id: string,
  status: "active" | "expired" | "failed",
): void {
  this.db
    .prepare(`UPDATE agent_sessions SET status = ? WHERE id = ?`)
    .run(status, id);
}

public incrementAgentSessionFailCount(id: string): number {
  this.db
    .prepare(
      `UPDATE agent_sessions SET fail_count = fail_count + 1 WHERE id = ?`,
    )
    .run(id);
  const row = this.db
    .prepare(`SELECT fail_count FROM agent_sessions WHERE id = ?`)
    .get(id) as { fail_count: number };
  return row.fail_count;
}

public getMaxMessageSeq(roomId: string): number | null {
  const row = this.db
    .prepare(`SELECT MAX(rowid) AS max_seq FROM messages WHERE room_id = ?`)
    .get(roomId) as { max_seq: number | null };
  return row.max_seq;
}

public listMessagesDelta(
  roomId: string,
  afterSeq: number,
  cutoffSeq: number,
  excludeAuthor: string,
): Message[] {
  const rows = this.db
    .prepare(
      `SELECT * FROM messages
       WHERE room_id = ?
         AND rowid > ?
         AND rowid <= ?
         AND author != ?
       ORDER BY rowid ASC`,
    )
    .all(roomId, afterSeq, cutoffSeq, excludeAuthor) as MessageRow[];
  return rows.map(messageRowToDomain);
}

private getAgentSessionById(id: string): AgentSession | null {
  const row = this.db
    .prepare(`SELECT * FROM agent_sessions WHERE id = ?`)
    .get(id) as AgentSessionRow | undefined;
  return row ? agentSessionRowToDomain(row) : null;
}
```

Add helper function at bottom of file (after `messageRowToDomain`):

```typescript
const agentSessionRowToDomain = (row: AgentSessionRow): AgentSession => ({
  id: row.id,
  roomId: row.room_id,
  agentName: row.agent_name,
  nativeSessionId: row.native_session_id,
  transportMode: row.transport_mode as AgentSession["transportMode"],
  status: row.status as AgentSession["status"],
  lastSeenSeq: row.last_seen_seq,
  failCount: row.fail_count,
  createdAt: row.created_at,
  lastTurnAt: row.last_turn_at,
});
```

**Step 5: Run tests**

```bash
npm run typecheck && npm test
```

Expected: all pass including 14 new agent session tests.

**Step 6: Commit**

```bash
git add internal/storage/sqlite.ts tests/storage/agent-sessions.test.ts
git commit -m "feat(storage): add agent_sessions table with CRUD, delta queries, and monotonic cursor"
```

---

### Task 4: PersistentAdapter contract

**Files:**
- Modify: `internal/adapters/adapter.ts`

**Purpose:** Add `SendTurnInput` and `PersistentAdapter` interface. No test needed — verified by typecheck when adapters implement it in Tasks 5-6.

**Step 1: Add types to `internal/adapters/adapter.ts`**

Add after `AgentInput`:

```typescript
export interface SendTurnInput {
  roomId: string;
  sessionId: string;
  requestId: string;
  nativeSessionId: string | null;
  prompt: string;
  config: AdapterConfig;
}

export interface PersistentAdapter extends Adapter {
  sendTurn(input: SendTurnInput): AsyncGenerator<AdapterEvent>;
  destroy?(nativeSessionId: string): Promise<void>;
}
```

**Step 2: Verify typecheck**

```bash
npm run typecheck
```

Expected: no errors.

**Step 3: Run tests**

```bash
npm test
```

Expected: all pass.

**Step 4: Commit**

```bash
git add internal/adapters/adapter.ts
git commit -m "feat(adapters): add PersistentAdapter interface with sendTurn contract"
```

---

### Task 5: Codex adapter — sendTurn with resume and session.bound

**Files:**
- Modify: `internal/adapters/codex/index.ts`
- Create: `tests/adapters/codex-resume.test.ts`

**Step 1: Write failing tests**

Create `tests/adapters/codex-resume.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCodexSpawnArgs,
  extractCodexThreadId,
} from "../../internal/adapters/codex/index.js";

test("buildCodexSpawnArgs cold: exec --json <prompt>", () => {
  const args = buildCodexSpawnArgs("hello", null);
  assert.deepEqual(args, ["exec", "--json", "hello"]);
});

test("buildCodexSpawnArgs resume: exec resume <id> --json <prompt>", () => {
  const args = buildCodexSpawnArgs("hello", "thread_abc");
  assert.deepEqual(args, ["exec", "resume", "thread_abc", "--json", "hello"]);
});

test("extractCodexThreadId extracts thread_id from thread.started event", () => {
  const line = '{"type":"thread.started","thread_id":"019c6deb-323f-7672-976a-ce4c0587d505"}';
  assert.equal(extractCodexThreadId(line), "019c6deb-323f-7672-976a-ce4c0587d505");
});

test("extractCodexThreadId returns null for non-thread event", () => {
  const line = '{"type":"item.completed","item":{"text":"hello"}}';
  assert.equal(extractCodexThreadId(line), null);
});

test("extractCodexThreadId returns null for non-JSON", () => {
  assert.equal(extractCodexThreadId("not json"), null);
});
```

**Step 2: Run to verify failure**

```bash
npm test 2>&1 | grep "codex-resume"
```

Expected: import error — functions don't exist.

**Step 3: Implement in `internal/adapters/codex/index.ts`**

Add imports:
```typescript
import type { PersistentAdapter, SendTurnInput } from "../adapter.js";
import { sessionBound } from "../event-factory.js";
```

Change `class CodexAdapter implements Adapter` to `class CodexAdapter implements PersistentAdapter`.

Add exported helper functions:

```typescript
export const buildCodexSpawnArgs = (
  prompt: string,
  nativeSessionId: string | null,
): string[] =>
  nativeSessionId
    ? ["exec", "resume", nativeSessionId, "--json", prompt]
    : ["exec", "--json", prompt];

export const extractCodexThreadId = (line: string): string | null => {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj.type === "thread.started" && typeof obj.thread_id === "string") {
      return obj.thread_id;
    }
  } catch {
    // not JSON
  }
  return null;
};
```

Add `sendTurn` method to `CodexAdapter`:

```typescript
public async *sendTurn(input: SendTurnInput) {
  const messageId = createId("msg");
  const startedPayload = {
    messageId,
    author: "agent.codex",
    role: "assistant" as const,
    text: "",
    format: "markdown" as const,
    metadata: {
      provider: "openai",
      model: "codex",
      requestId: input.requestId,
    },
  };
  const base = {
    roomId: input.roomId,
    sessionId: input.sessionId,
    requestId: input.requestId,
    source: SOURCE,
  };

  yield messageStarted(base, startedPayload);

  this.status = "busy";
  const child = spawn(
    "codex",
    buildCodexSpawnArgs(input.prompt, input.nativeSessionId),
    { stdio: ["ignore", "pipe", "pipe"], env: process.env },
  );
  this.running.set(input.requestId, child);

  let stderr = "";
  let output = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, input.config.timeoutMs);

  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  try {
    for await (const chunk of child.stdout) {
      const raw = chunk.toString("utf8");

      // Check for session.bound (thread_id)
      for (const line of raw.split(/\r?\n/)) {
        const threadId = extractCodexThreadId(line.trim());
        if (threadId) {
          yield sessionBound(base, threadId);
        }
      }

      const text = parseChunkToText(raw);
      if (!text) continue;
      output += text;
      yield messageDelta(base, { ...startedPayload, text });
    }

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("close", resolve);
    });

    if (timedOut) {
      yield messageError(base, "TIMEOUT", "codex request timed out", stderr);
    } else if (exitCode !== 0) {
      const isExpired = input.nativeSessionId && isSessionExpiredError(stderr);
      yield messageError(
        base,
        isExpired ? "SESSION_EXPIRED" : "PROCESS_CRASH",
        isExpired
          ? "codex session expired or not found"
          : `codex process exited with code ${String(exitCode)}`,
        stderr,
      );
    } else {
      yield messageCompleted(base, {
        ...startedPayload,
        text: output.trim() || "(no content)",
      });
    }
  } catch (error) {
    yield messageError(
      base,
      "UNKNOWN",
      error instanceof Error ? error.message : "unknown codex adapter failure",
      stderr,
    );
  } finally {
    clearTimeout(timer);
    this.running.delete(input.requestId);
    this.status = "ready";
  }
}
```

Add error detection helper (inside file, not exported):

```typescript
const isSessionExpiredError = (stderr: string): boolean => {
  const lower = stderr.toLowerCase();
  return (
    lower.includes("session") &&
    (lower.includes("not found") ||
      lower.includes("expired") ||
      lower.includes("invalid"))
  );
};
```

**Step 4: Run tests**

```bash
npm run typecheck && npm test
```

Expected: all pass including 5 new codex resume tests.

**Step 5: Commit**

```bash
git add internal/adapters/codex/index.ts tests/adapters/codex-resume.test.ts
git commit -m "feat(adapter/codex): add sendTurn with native resume, session.bound, SESSION_EXPIRED"
```

---

### Task 6: Claude adapter — sendTurn with resume and session.bound

**Files:**
- Modify: `internal/adapters/claude/index.ts`
- Modify: `tests/adapters/claude-cli.test.ts` (update existing `buildClaudeSpawnArgs` calls)
- Create: `tests/adapters/claude-resume.test.ts`

**Step 1: Write failing tests**

Create `tests/adapters/claude-resume.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClaudeResumeSpawnArgs,
  extractClaudeSessionId,
} from "../../internal/adapters/claude/index.js";

test("buildClaudeResumeSpawnArgs cold: -p <prompt> (no --resume)", () => {
  const args = buildClaudeResumeSpawnArgs("hello", null);
  assert.ok(!args.includes("--resume"));
  assert.equal(args[0], "-p");
  assert.equal(args[1], "hello");
  assert.ok(args.includes("--output-format"));
});

test("buildClaudeResumeSpawnArgs resume: --resume <id> -p <prompt>", () => {
  const args = buildClaudeResumeSpawnArgs("hello", "sid-123");
  assert.equal(args[0], "--resume");
  assert.equal(args[1], "sid-123");
  assert.equal(args[2], "-p");
  assert.equal(args[3], "hello");
});

test("extractClaudeSessionId extracts session_id from result event", () => {
  const line = '{"type":"result","result":"hello","session_id":"sid-abc"}';
  assert.equal(extractClaudeSessionId(line), "sid-abc");
});

test("extractClaudeSessionId extracts conversation_id as fallback", () => {
  const line = '{"type":"result","result":"hello","conversation_id":"conv-xyz"}';
  assert.equal(extractClaudeSessionId(line), "conv-xyz");
});

test("extractClaudeSessionId returns null when no ID present", () => {
  const line = '{"type":"result","result":"hello"}';
  assert.equal(extractClaudeSessionId(line), null);
});

test("extractClaudeSessionId returns null for non-JSON", () => {
  assert.equal(extractClaudeSessionId("not json"), null);
});
```

**Step 2: Run to verify failure**

```bash
npm test 2>&1 | grep "claude-resume"
```

Expected: import error.

**Step 3: Implement in `internal/adapters/claude/index.ts`**

Add imports:
```typescript
import type { PersistentAdapter, SendTurnInput } from "../adapter.js";
import { sessionBound } from "../event-factory.js";
```

Change `class ClaudeAdapter implements Adapter` to `class ClaudeAdapter implements PersistentAdapter`.

Add exported helpers:

```typescript
export const buildClaudeResumeSpawnArgs = (
  prompt: string,
  nativeSessionId: string | null,
): string[] => [
  ...(nativeSessionId ? ["--resume", nativeSessionId] : []),
  "-p",
  prompt,
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
];

export const extractClaudeSessionId = (line: string): string | null => {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    // Try session_id first, then conversation_id as fallback
    for (const key of ["session_id", "conversation_id"]) {
      const val = obj[key];
      if (typeof val === "string" && val.length > 0) return val;
    }
  } catch {
    // not JSON
  }
  return null;
};
```

Add `sendTurn` method to `ClaudeAdapter` (structured like `send` but uses resume args):

```typescript
public async *sendTurn(input: SendTurnInput) {
  const messageId = createId("msg");
  const startedPayload = {
    messageId,
    author: "agent.claude",
    role: "assistant" as const,
    text: "",
    format: "markdown" as const,
    metadata: {
      provider: "anthropic",
      model: "claude-code",
      requestId: input.requestId,
    },
  };
  const base = {
    roomId: input.roomId,
    sessionId: input.sessionId,
    requestId: input.requestId,
    source: SOURCE,
  };

  yield messageStarted(base, startedPayload);

  this.status = "busy";
  const child = spawn(
    "claude",
    buildClaudeResumeSpawnArgs(input.prompt, input.nativeSessionId),
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: buildClaudeSpawnEnv(process.env),
      cwd: buildClaudeSpawnCwd(process.env),
    },
  );
  this.running.set(input.requestId, child);

  let stderr = "";
  let output = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, input.config.timeoutMs);

  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  try {
    let resultText: string | null = null;

    for await (const chunk of child.stdout) {
      const raw = chunk.toString("utf8");

      // Scan all lines for session ID
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const sid = extractClaudeSessionId(trimmed);
        if (sid) {
          yield sessionBound(base, sid);
        }
      }

      const parsedChunk = parseClaudeChunk(raw);
      if (parsedChunk.resultText) {
        resultText = parsedChunk.resultText;
      }
      if (parsedChunk.deltaParts.length === 0) continue;

      const chunkParts = parsedChunk.deltaParts.map((part, index) =>
        index === 0 ? part : `\n${part}`,
      );
      for (const text of chunkParts) {
        output += text;
        yield messageDelta(base, { ...startedPayload, text });
      }
    }

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("close", resolve);
    });

    if (timedOut) {
      yield messageError(base, "TIMEOUT", "claude request timed out", stderr);
    } else if (exitCode !== 0) {
      const isExpired = input.nativeSessionId && isSessionExpiredError(stderr);
      yield messageError(
        base,
        isExpired ? "SESSION_EXPIRED" : "PROCESS_CRASH",
        isExpired
          ? "claude session expired or not found"
          : `claude process exited with code ${String(exitCode)}`,
        stderr,
      );
    } else {
      yield messageCompleted(base, {
        ...startedPayload,
        text: output.trim() || resultText?.trim() || "(no content)",
      });
    }
  } catch (error) {
    yield messageError(
      base,
      "UNKNOWN",
      error instanceof Error ? error.message : "unknown claude adapter failure",
      stderr,
    );
  } finally {
    clearTimeout(timer);
    this.running.delete(input.requestId);
    this.status = "ready";
  }
}
```

Add error helper:

```typescript
const isSessionExpiredError = (stderr: string): boolean => {
  const lower = stderr.toLowerCase();
  return (
    lower.includes("session") &&
    (lower.includes("not found") ||
      lower.includes("expired") ||
      lower.includes("invalid"))
  );
};
```

**Step 4: Update existing tests that call `buildClaudeSpawnArgs`**

In `tests/adapters/claude-cli.test.ts`, find any calls to `buildClaudeSpawnArgs` and ensure they still compile. The existing function is unchanged — only a new `buildClaudeResumeSpawnArgs` was added.

**Step 5: Run tests**

```bash
npm run typecheck && npm test
```

Expected: all pass including 6 new claude resume tests.

**Step 6: Commit**

```bash
git add internal/adapters/claude/index.ts tests/adapters/claude-resume.test.ts
git commit -m "feat(adapter/claude): add sendTurn with native resume, session.bound, SESSION_EXPIRED"
```

---

### Task 7: Session Service — delta computation and concurrency lock

**Files:**
- Modify: `internal/session/service.ts`
- Create: `tests/session/delta.test.ts`

**Step 1: Write failing tests**

Create `tests/session/delta.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../../internal/storage/sqlite.js";
import { SessionService } from "../../internal/session/service.js";
import type { Message, RoomConfig } from "../../internal/events/types.js";

const ROOM_CONFIG: RoomConfig = {
  mode: "manual",
  checkpointThreshold: 50,
  maxHistoryMessages: 100,
  maxContextTokens: 8000,
};

function msg(roomId: string, id: string, author: string, text: string): Message {
  return {
    id, roomId, author,
    role: author === "user" ? "user" : "assistant",
    text, format: "plain", metadata: {},
    createdAt: "2026-01-01T00:00:00Z",
  };
}

test("buildDeltaPrompt returns full context on cold start (null lastSeenSeq)", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const service = new SessionService(store);
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    store.saveMessage(msg(room.id, "msg_1", "user", "hello"));

    const result = service.buildDeltaPrompt(room, "claude", null);
    assert.ok(result.prompt.includes("hello"));
    assert.ok(result.cutoffSeq !== null);
  } finally {
    store.close();
  }
});

test("buildDeltaPrompt returns only delta messages for warm turn", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const service = new SessionService(store);
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    store.saveMessage(msg(room.id, "msg_1", "user", "first"));
    const seq1 = store.getMaxMessageSeq(room.id)!;

    store.saveMessage(msg(room.id, "msg_2", "agent.claude", "my response"));
    store.saveMessage(msg(room.id, "msg_3", "agent.codex", "codex says hi"));
    store.saveMessage(msg(room.id, "msg_4", "user", "second question"));

    const result = service.buildDeltaPrompt(room, "claude", seq1);
    // Should include codex message and user message, NOT claude's own
    assert.ok(result.prompt.includes("codex says hi"));
    assert.ok(result.prompt.includes("second question"));
    assert.ok(!result.prompt.includes("my response"));
  } finally {
    store.close();
  }
});

test("buildDeltaPrompt returns empty delta section when no new messages", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const service = new SessionService(store);
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    store.saveMessage(msg(room.id, "msg_1", "user", "hello"));
    const seq = store.getMaxMessageSeq(room.id)!;

    const result = service.buildDeltaPrompt(room, "claude", seq);
    assert.equal(result.prompt, "");
    assert.equal(result.cutoffSeq, seq);
  } finally {
    store.close();
  }
});

test("acquireTurnLock serializes concurrent turns for same agent", async () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const service = new SessionService(store);
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const order: number[] = [];

    const turn1 = service.acquireTurnLock(room.id, "claude", async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push(1);
      return 1;
    });

    const turn2 = service.acquireTurnLock(room.id, "claude", async () => {
      order.push(2);
      return 2;
    });

    await Promise.all([turn1, turn2]);
    assert.deepEqual(order, [1, 2]); // turn2 waits for turn1
  } finally {
    store.close();
  }
});

test("acquireTurnLock allows concurrent turns for different agents", async () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const service = new SessionService(store);
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const order: string[] = [];

    const turn1 = service.acquireTurnLock(room.id, "claude", async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push("claude");
      return "claude";
    });

    const turn2 = service.acquireTurnLock(room.id, "codex", async () => {
      order.push("codex");
      return "codex";
    });

    await Promise.all([turn1, turn2]);
    // codex should complete first (no waiting)
    assert.equal(order[0], "codex");
  } finally {
    store.close();
  }
});
```

**Step 2: Run to verify failure**

```bash
npm test 2>&1 | grep "delta"
```

Expected: methods don't exist.

**Step 3: Add methods to `SessionService` in `internal/session/service.ts`**

Add at the top of the class:

```typescript
private readonly turnLocks = new Map<string, Promise<unknown>>();
```

Add new methods:

```typescript
public buildDeltaPrompt(
  room: Room,
  agentName: string,
  lastSeenSeq: number | null,
): { prompt: string; cutoffSeq: number | null } {
  const cutoffSeq = this.store.getMaxMessageSeq(room.id);

  // Cold start: return full context
  if (lastSeenSeq === null) {
    const messages = this.buildContextMessages(room);
    const prompt = messages
      .map((m) => `[${m.author}] ${m.text}`)
      .join("\n\n")
      .slice(-20000);
    return { prompt, cutoffSeq };
  }

  // No cutoff = no messages at all
  if (cutoffSeq === null) {
    return { prompt: "", cutoffSeq: null };
  }

  // Warm: delta only
  const delta = this.store.listMessagesDelta(
    room.id,
    lastSeenSeq,
    cutoffSeq,
    `agent.${agentName}`,
  );

  if (delta.length === 0) {
    return { prompt: "", cutoffSeq };
  }

  const lines = delta.map(
    (m) => `- [${m.author}][${m.id}] ${m.text}`,
  );
  const prompt = [
    "[Team context since your last response]",
    ...lines,
  ].join("\n");

  return { prompt, cutoffSeq };
}

public async acquireTurnLock<T>(
  roomId: string,
  agentName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${roomId}:${agentName}`;
  const prev = this.turnLocks.get(key) ?? Promise.resolve();

  const current = prev.then(fn, fn); // run fn after previous completes (even if it rejected)
  this.turnLocks.set(key, current.then(() => {}, () => {})); // swallow result for next waiter

  return current;
}
```

Add `Room` to imports if not present:

```typescript
import type { Message, PinnedContext, Room, RoomConfig } from "../events/types.js";
```

**Step 4: Run tests**

```bash
npm run typecheck && npm test
```

Expected: all pass including 5 new delta tests.

**Step 5: Commit**

```bash
git add internal/session/service.ts tests/session/delta.test.ts
git commit -m "feat(session): add buildDeltaPrompt and acquireTurnLock for persistent sessions"
```

---

### Task 8: Engine integration — persistent dispatch with session lifecycle

**Files:**
- Modify: `internal/engine/chat.ts`
- Create: `tests/engine/persistent-session.test.ts`

This is the most complex task. The engine's `runDispatch` is modified to:
1. Get or create agent session
2. Build delta prompt (cold or warm)
3. Call `sendTurn` (or fallback to `send` for stub)
4. Handle `session.bound` events
5. Atomic post-turn: save native ID, update cursor
6. Error recovery: SESSION_EXPIRED → close + cold retry

**Step 1: Write failing tests**

Create `tests/engine/persistent-session.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../../internal/storage/sqlite.js";
import { SessionService } from "../../internal/session/service.js";
import { ChatEngine } from "../../internal/engine/chat.js";
import type { PersistentAdapter, SendTurnInput, AdapterEvent } from "../../internal/adapters/adapter.js";
import {
  messageStarted,
  messageCompleted,
  messageError,
  sessionBound,
} from "../../internal/adapters/event-factory.js";
import { createId } from "../../internal/session/ids.js";

function makeStubPersistentAdapter(
  name: string,
  turns: Array<{
    text?: string;
    nativeSessionId?: string;
    errorClass?: "SESSION_EXPIRED" | "PROCESS_CRASH";
  }>,
): PersistentAdapter & { sendTurnCalls: SendTurnInput[] } {
  let turnIdx = 0;
  const sendTurnCalls: SendTurnInput[] = [];

  return {
    name,
    sendTurnCalls,
    async *send(input) {
      // Fallback for stub — not used in persistent mode
      const msgId = createId("msg");
      const base = { roomId: input.roomId, sessionId: input.sessionId, requestId: input.requestId, source: `adapter.${name}` };
      const payload = { messageId: msgId, author: `agent.${name}`, role: "assistant" as const, text: "stub", format: "plain" as const, metadata: { provider: "test", model: "test", requestId: input.requestId } };
      yield messageStarted(base, payload);
      yield messageCompleted(base, payload);
    },
    async *sendTurn(input: SendTurnInput) {
      sendTurnCalls.push(input);
      const turn = turns[turnIdx % turns.length];
      turnIdx++;

      const base = { roomId: input.roomId, sessionId: input.sessionId, requestId: input.requestId, source: `adapter.${name}` };
      const msgId = createId("msg");
      const payload = { messageId: msgId, author: `agent.${name}`, role: "assistant" as const, text: turn.text ?? "ok", format: "plain" as const, metadata: { provider: "test", model: "test", requestId: input.requestId } };

      if (turn.errorClass) {
        yield messageError(base, turn.errorClass, `${turn.errorClass} error`, "");
        return;
      }

      if (turn.nativeSessionId) {
        yield sessionBound(base, turn.nativeSessionId);
      }
      yield messageStarted(base, payload);
      yield messageCompleted(base, payload);
    },
    async cancel() {},
    async health() { return "ready" as const; },
  };
}

function makeEngine(adapter: PersistentAdapter) {
  const store = new SQLiteStore(":memory:");
  store.init();
  const session = new SessionService(store);
  const config = {
    roomName: "test-room",
    agents: [adapter.name],
    roomConfig: { mode: "manual" as const, checkpointThreshold: 50, maxHistoryMessages: 100, maxContextTokens: 8000 },
    adapterMode: "persistent" as const,
    adapterTimeoutMs: 5000,
    adapterMaxTokens: 4000,
    agentSkills: {},
  };
  const engine = new ChatEngine(session, { [adapter.name]: adapter }, config);
  engine.init();
  return { engine, store, session };
}

test("cold start: first turn has nativeSessionId=null", async () => {
  const adapter = makeStubPersistentAdapter("claude", [
    { text: "hello", nativeSessionId: "sid-1" },
  ]);
  const { engine } = makeEngine(adapter);

  await engine.processUserMessage("hi");

  assert.equal(adapter.sendTurnCalls.length, 1);
  assert.equal(adapter.sendTurnCalls[0].nativeSessionId, null);
});

test("warm turn: second turn uses saved nativeSessionId", async () => {
  const adapter = makeStubPersistentAdapter("claude", [
    { text: "first", nativeSessionId: "sid-1" },
    { text: "second" },
  ]);
  const { engine } = makeEngine(adapter);

  await engine.processUserMessage("msg 1");
  await engine.processUserMessage("msg 2");

  assert.equal(adapter.sendTurnCalls.length, 2);
  assert.equal(adapter.sendTurnCalls[1].nativeSessionId, "sid-1");
});

test("warm turn: prompt contains delta, not full history", async () => {
  const adapter = makeStubPersistentAdapter("claude", [
    { text: "first", nativeSessionId: "sid-1" },
    { text: "second" },
  ]);
  const { engine } = makeEngine(adapter);

  await engine.processUserMessage("first question");
  await engine.processUserMessage("second question");

  const secondPrompt = adapter.sendTurnCalls[1].prompt;
  assert.ok(secondPrompt.includes("second question"));
  // Should NOT include the full first exchange in delta
  assert.ok(!secondPrompt.includes("first question") || secondPrompt.includes("[Team context"));
});

test("SESSION_EXPIRED: auto-retry with cold start", async () => {
  const adapter = makeStubPersistentAdapter("claude", [
    { text: "first", nativeSessionId: "sid-1" },
    { errorClass: "SESSION_EXPIRED" },  // turn 2 fails
    { text: "recovered", nativeSessionId: "sid-2" },  // cold retry succeeds
  ]);
  const { engine } = makeEngine(adapter);

  await engine.processUserMessage("msg 1");
  const results = await engine.processUserMessage("msg 2");

  // 3 sendTurn calls: turn1, expired-turn2, cold-retry-turn2
  assert.equal(adapter.sendTurnCalls.length, 3);
  // Cold retry has nativeSessionId=null
  assert.equal(adapter.sendTurnCalls[2].nativeSessionId, null);
  // Result is success (from cold retry)
  assert.ok(results.some((r) => r.success));
});

test("session.bound event saves nativeSessionId to agent_sessions", async () => {
  const adapter = makeStubPersistentAdapter("claude", [
    { text: "hello", nativeSessionId: "sid-999" },
  ]);
  const { engine, store } = makeEngine(adapter);

  await engine.processUserMessage("hi");

  const state = engine.getState();
  const sessions = store.listActiveAgentSessions(state.room.id);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].nativeSessionId, "sid-999");
});

test("stub mode: uses send() not sendTurn()", async () => {
  const adapter = makeStubPersistentAdapter("claude", [{ text: "stub" }]);
  const store = new SQLiteStore(":memory:");
  store.init();
  const session = new SessionService(store);
  const config = {
    roomName: "test-room",
    agents: ["claude"],
    roomConfig: { mode: "manual" as const, checkpointThreshold: 50, maxHistoryMessages: 100, maxContextTokens: 8000 },
    adapterMode: "stub" as const,
    adapterTimeoutMs: 5000,
    adapterMaxTokens: 4000,
    agentSkills: {},
  };
  const engine = new ChatEngine(session, { claude: adapter }, config);
  engine.init();

  await engine.processUserMessage("hi");

  // sendTurn should NOT be called for stub mode
  assert.equal(adapter.sendTurnCalls.length, 0);
});
```

**Step 2: Run to verify failure**

```bash
npm test 2>&1 | grep "persistent-session"
```

Expected: failures — engine doesn't support persistent mode yet.

**Step 3: Modify `internal/engine/chat.ts`**

Add imports:

```typescript
import type { PersistentAdapter, SendTurnInput } from "../adapters/adapter.js";
import type { AgentSession } from "../storage/sqlite.js";
import type { SessionBoundPayload } from "../events/types.js";
```

Add `adapterMode` to `ChatRuntimeConfig` type check — verify `internal/config/default.ts` includes `adapterMode`. If `AdapterMode` is defined as `'stub' | 'cli'`, extend it to `'stub' | 'cli' | 'persistent'` in `internal/adapters/adapter.ts`.

In `runDispatch`, add persistent session logic. Replace the method with:

```typescript
private async runDispatch(dispatch: Dispatch, isSessionRetry = false): Promise<DispatchResult> {
  const state = this.getState();
  const adapter = this.adapters[dispatch.targetAdapter];
  if (!adapter) {
    return {
      adapter: dispatch.targetAdapter,
      requestId: dispatch.requestId,
      success: false,
      text: "",
      error: `Adapter ${dispatch.targetAdapter} is not available.`,
    };
  }

  const adapterConfig = this.resolveAdapterConfig(dispatch.targetAdapter);
  const isPersistent = adapterConfig.mode === "persistent" && "sendTurn" in adapter;

  if (!isPersistent) {
    return this.runLegacyDispatch(dispatch, adapter, adapterConfig);
  }

  // Persistent session path
  return this.session.acquireTurnLock(
    state.room.id,
    dispatch.targetAdapter,
    () => this.runPersistentDispatch(dispatch, adapter as PersistentAdapter, adapterConfig, isSessionRetry),
  );
}
```

Add the persistent dispatch method:

```typescript
private async runPersistentDispatch(
  dispatch: Dispatch,
  adapter: PersistentAdapter,
  adapterConfig: AdapterConfig,
  isSessionRetry: boolean,
): Promise<DispatchResult> {
  const state = this.getState();

  // Get or create agent session
  let agentSession = this.session.store.getActiveAgentSession(
    state.room.id,
    dispatch.targetAdapter,
  );
  if (!agentSession) {
    agentSession = this.session.store.createAgentSession(
      state.room.id,
      dispatch.targetAdapter,
    );
  }

  // Build delta prompt
  const { prompt, cutoffSeq } = this.session.buildDeltaPrompt(
    state.room,
    dispatch.targetAdapter,
    agentSession.lastSeenSeq,
  );

  const input: SendTurnInput = {
    roomId: state.room.id,
    sessionId: state.sessionId,
    requestId: dispatch.requestId,
    nativeSessionId: agentSession.nativeSessionId,
    prompt,
    config: adapterConfig,
  };

  let finalText = "";
  let failed: { errorClass: string; message: string } | undefined;
  let boundNativeId: string | null = null;

  for await (const event of adapter.sendTurn(input)) {
    this.session.appendEvent(event);
    this.hooks.onAdapterEvent?.(dispatch.targetAdapter, event);

    if (event.type === "session.bound") {
      const payload = event.payload as SessionBoundPayload;
      boundNativeId = payload.nativeSessionId;
    }
    if (event.type === "message.delta") {
      const text = extractPayloadText(event.payload);
      if (text) finalText += text;
    }
    if (event.type === "message.completed") {
      const text = extractPayloadText(event.payload);
      finalText = text || finalText;
    }
    if (event.type === "message.error") {
      failed = extractErrorInfo(event.payload);
    }
  }

  // Post-turn atomic updates
  if (boundNativeId) {
    this.session.store.updateAgentSessionNativeId(agentSession.id, boundNativeId);
  }
  if (cutoffSeq !== null) {
    this.session.store.updateAgentSessionCursor(agentSession.id, cutoffSeq);
  }

  // Error recovery: SESSION_EXPIRED → close + cold retry (once)
  if (failed?.errorClass === "SESSION_EXPIRED" && !isSessionRetry) {
    this.session.store.updateAgentSessionStatus(agentSession.id, "expired");
    const retryDispatch: Dispatch = {
      ...dispatch,
      requestId: createId("req"),
    };
    return this.runPersistentDispatch(
      retryDispatch,
      adapter,
      adapterConfig,
      true,
    );
  }

  if (failed) {
    if (failed.errorClass !== "SESSION_EXPIRED") {
      this.session.store.incrementAgentSessionFailCount(agentSession.id);
    }
    return {
      adapter: dispatch.targetAdapter,
      requestId: dispatch.requestId,
      success: false,
      text: finalText,
      error: `${failed.errorClass}: ${failed.message}`,
    };
  }

  // Cold start without session.bound → fatal
  if (!agentSession.nativeSessionId && !boundNativeId) {
    this.session.store.updateAgentSessionStatus(agentSession.id, "failed");
    return {
      adapter: dispatch.targetAdapter,
      requestId: dispatch.requestId,
      success: false,
      text: finalText,
      error: "FATAL: no native session ID received on cold start",
    };
  }

  const provider = dispatch.targetAdapter === "codex" ? "openai" : "anthropic";
  const model = dispatch.targetAdapter === "codex" ? "codex" : "claude-code";
  this.session.saveAssistantMessage(
    state.room.id,
    `agent.${dispatch.targetAdapter}`,
    finalText.trim() || "(empty response)",
    dispatch.requestId,
    dispatch.dispatchId,
    provider,
    model,
  );

  return {
    adapter: dispatch.targetAdapter,
    requestId: dispatch.requestId,
    success: true,
    text: finalText.trim() || "(empty response)",
  };
}
```

Extract the existing `runDispatch` logic into `runLegacyDispatch`:

```typescript
private async runLegacyDispatch(
  dispatch: Dispatch,
  adapter: Adapter,
  adapterConfig: AdapterConfig,
): Promise<DispatchResult> {
  // ... move the existing send() logic here verbatim ...
}
```

Also add `AdapterConfig` to the import from `../adapters/adapter.js` if not already imported.

Expose store as public on SessionService (for engine to call agent session methods):

In `internal/session/service.ts`, change:
```typescript
public constructor(private readonly store: SQLiteStore) {
```
to:
```typescript
public constructor(public readonly store: SQLiteStore) {
```

**Step 4: Update `AdapterMode` in `internal/adapters/adapter.ts`**

```typescript
export type AdapterMode = "stub" | "cli" | "persistent";
```

**Step 5: Run tests**

```bash
npm run typecheck && npm test
```

Expected: all pass including 6 new persistent session engine tests.

**Step 6: Commit**

```bash
git add internal/engine/chat.ts internal/session/service.ts \
        internal/adapters/adapter.ts tests/engine/persistent-session.test.ts
git commit -m "feat(engine): integrate persistent session lifecycle with sendTurn, recovery, and concurrency lock"
```

---

### Task 9: Regression validation

**Purpose:** Verify all existing v0.1 tests still pass and no behavior change for stub/cli modes.

**Step 1: Run full test suite**

```bash
npm run typecheck && npm test
```

Expected: all tests pass (136 original + ~30 new).

**Step 2: Quick CLI smoke test with stub mode**

```bash
echo -e "@claude hello\n/quit" | tsx cmd/agoryx/main.ts chat --adapter-mode stub 2>/dev/null
```

Expected: stub response, clean exit.

**Step 3: Commit if any fixes were needed**

If no fixes needed, skip this step.

---

### Task 10: Update bridge files

**Files:**
- Modify: `bridge/SESSION.md`
- Append: `bridge/LOG.md`

**Step 1: Record final test count**

```bash
npm test 2>&1 | tail -3
```

**Step 2: Update `bridge/SESSION.md`**

Add a new section with persistent sessions implementation summary. Update project structure to include `agent_sessions` table, `PersistentAdapter`, `sendTurn`, `session.bound` event.

**Step 3: Append to `bridge/LOG.md`**

Follow the LOG format. Include:
- Summary of what was implemented
- Files changed/created
- Test count before → after
- Risks: Claude session ID extraction unvalidated
- Next: live smoke test with `--adapter-mode persistent`

**Step 4: Commit**

```bash
git add bridge/SESSION.md bridge/LOG.md
git commit -m "docs(bridge): update session state after persistent sessions implementation"
```

---

## Quick reference

| Command | Purpose |
|---------|---------|
| `npm run typecheck` | TypeScript type checking |
| `npm test` | Run all tests |
| `npm run typecheck && npm test` | Both |
| `echo -e "@claude hi\n/quit" \| tsx cmd/agoryx/main.ts chat --adapter-mode stub` | Quick CLI smoke |

## Risks and validation items

| Risk | Mitigation |
|------|-----------|
| Claude `session_id` field name unverified | Test `claude -p "hello" --output-format stream-json --verbose` from outside Claude Code; adapt `extractClaudeSessionId` keys |
| `codex exec resume` prompt position | Validated via `codex exec resume --help` and live test in brainstorming phase |
| Existing tests may depend on `send()` behavior | `runLegacyDispatch` preserves all existing behavior for `stub`/`cli` modes |
| `messages.rowid` may not be reliable across DB migration | `rowid` is stable in SQLite; only vacuum can change it, which Agoryx doesn't use |
| Delta prompt format may confuse agents | Tune format strings in `buildDeltaPrompt` based on smoke test feedback |
