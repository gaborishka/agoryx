# Persistent Agent Sessions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move Agoryx from stateless per-turn spawning to SessionManager-first architecture where Claude and Codex maintain their own context windows between turns via native CLI session resume.

**Architecture:** A new `AgentSessionManager` (wrapping `SQLiteStore`) stores session bindings per `(room, agent)`. `ChatEngine.runDispatch()` calls the manager before each turn, passes a `SessionHandle` to the adapter, and adapters use `--resume`/`exec resume` when a native session ID exists. On `SESSION_EXPIRED`, the engine closes the binding and retries once via cold start.

**Tech Stack:** TypeScript, `better-sqlite3` (sync), Node.js built-in test runner (`node:test`), `tsx --test` for running tests.

---

## Pre-flight: Verify Codex resume CLI syntax

Before starting Task 7, run these commands to confirm the exact `codex` CLI resume syntax:

```bash
codex --help | grep -i resume
codex exec --help 2>&1 | head -40
```

If `codex exec resume <session-id> <prompt>` is confirmed, proceed with Task 7 as written.
If the syntax differs, adjust `buildCodexSpawnArgs` accordingly and note in commit message.

---

### Task 1: Extend canonical types

**Files:**
- Modify: `internal/events/types.ts`

**Purpose:** Add `SESSION_EXPIRED` to `ErrorClass` and `agentNativeSessionId` to `MessageMetadata`. No test needed — verified by typecheck.

**Step 1: Edit `internal/events/types.ts`**

Change `ErrorClass`:
```typescript
export type ErrorClass =
  | "AUTH_ERROR"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "PROCESS_CRASH"
  | "PROTOCOL_ERROR"
  | "SESSION_EXPIRED"   // new: native agent session not found or expired
  | "UNKNOWN";
```

Add `agentNativeSessionId` to `MessageMetadata`:
```typescript
export interface MessageMetadata {
  provider?: string;
  model?: string;
  tokenUsage?: {
    input: number;
    output: number;
  };
  latencyMs?: number;
  dispatchId?: string;
  requestId?: string;
  agentNativeSessionId?: string;  // new: returned by adapter after session resume
}
```

**Step 2: Verify typecheck passes**

```bash
npm run typecheck
```
Expected: no errors.

**Step 3: Commit**

```bash
git add internal/events/types.ts
git commit -m "feat(types): add SESSION_EXPIRED error class and agentNativeSessionId to MessageMetadata"
```

---

### Task 2: SQLite storage for agent sessions

**Files:**
- Modify: `internal/storage/sqlite.ts`
- Create: `tests/storage/agent-sessions-store.test.ts`

**Step 1: Write failing tests**

Create `tests/storage/agent-sessions-store.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../../internal/storage/sqlite.js";
import type { SessionPolicy } from "../../internal/session/agent-sessions.js";

const ROOM_CONFIG = {
  mode: "manual" as const,
  checkpointThreshold: 10,
  maxHistoryMessages: 100,
  maxContextTokens: 4000,
};

function makeStore() {
  const store = new SQLiteStore(":memory:");
  store.init();
  return store;
}

test("getOrCreateAgentSession creates a new chat session", () => {
  const store = makeStore();
  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const policy: SessionPolicy = { kind: "chat" };
    const handle = store.getOrCreateAgentSession(room.id, "claude", policy);

    assert.equal(handle.roomId, room.id);
    assert.equal(handle.agentName, "claude");
    assert.deepEqual(handle.policy, { kind: "chat" });
    assert.equal(handle.agentNativeSessionId, null);
    assert.equal(handle.lastSeenEventId, null);
    assert.ok(typeof handle.createdAt === "number");
  } finally {
    store.close();
  }
});

test("getOrCreateAgentSession returns existing active chat session", () => {
  const store = makeStore();
  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const policy: SessionPolicy = { kind: "chat" };

    const first = store.getOrCreateAgentSession(room.id, "claude", policy);
    const second = store.getOrCreateAgentSession(room.id, "claude", policy);

    assert.equal(first.id, second.id);
  } finally {
    store.close();
  }
});

test("getOrCreateAgentSession creates separate sessions for task policy", () => {
  const store = makeStore();
  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const policyA: SessionPolicy = { kind: "task", taskId: "task_1" };
    const policyB: SessionPolicy = { kind: "task", taskId: "task_2" };

    const a = store.getOrCreateAgentSession(room.id, "claude", policyA);
    const b = store.getOrCreateAgentSession(room.id, "claude", policyB);

    assert.notEqual(a.id, b.id);
  } finally {
    store.close();
  }
});

test("saveAgentNativeSessionId updates nativeId and lastActiveAt", () => {
  const store = makeStore();
  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const handle = store.getOrCreateAgentSession(room.id, "claude", { kind: "chat" });

    store.saveAgentNativeSessionId(handle.id, "native-abc");

    const updated = store.listActiveAgentSessions(room.id);
    assert.equal(updated[0].agentNativeSessionId, "native-abc");
    assert.ok(updated[0].lastActiveAt >= handle.lastActiveAt);
  } finally {
    store.close();
  }
});

test("saveAgentNativeSessionId does not overwrite with empty string", () => {
  const store = makeStore();
  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const handle = store.getOrCreateAgentSession(room.id, "claude", { kind: "chat" });
    store.saveAgentNativeSessionId(handle.id, "native-abc");
    store.saveAgentNativeSessionId(handle.id, "");

    const active = store.listActiveAgentSessions(room.id);
    assert.equal(active[0].agentNativeSessionId, "native-abc");
  } finally {
    store.close();
  }
});

test("updateAgentLastSeen sets eventId and lastActiveAt", () => {
  const store = makeStore();
  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const handle = store.getOrCreateAgentSession(room.id, "claude", { kind: "chat" });

    store.updateAgentLastSeen(handle.id, "evt_001");

    const active = store.listActiveAgentSessions(room.id);
    assert.equal(active[0].lastSeenEventId, "evt_001");
  } finally {
    store.close();
  }
});

test("closeAgentSession removes session from active list", () => {
  const store = makeStore();
  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const handle = store.getOrCreateAgentSession(room.id, "claude", { kind: "chat" });

    store.closeAgentSession(handle.id);

    const active = store.listActiveAgentSessions(room.id);
    assert.equal(active.length, 0);
  } finally {
    store.close();
  }
});

test("getOrCreateAgentSession creates fresh session after close", () => {
  const store = makeStore();
  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const first = store.getOrCreateAgentSession(room.id, "claude", { kind: "chat" });
    store.closeAgentSession(first.id);
    const second = store.getOrCreateAgentSession(room.id, "claude", { kind: "chat" });

    assert.notEqual(first.id, second.id);
  } finally {
    store.close();
  }
});

test("listActiveAgentSessions returns only open sessions", () => {
  const store = makeStore();
  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const s1 = store.getOrCreateAgentSession(room.id, "claude", { kind: "chat" });
    store.getOrCreateAgentSession(room.id, "codex", { kind: "chat" });
    store.closeAgentSession(s1.id);

    const active = store.listActiveAgentSessions(room.id);
    assert.equal(active.length, 1);
    assert.equal(active[0].agentName, "codex");
  } finally {
    store.close();
  }
});
```

**Step 2: Run tests to verify they fail**

```bash
npm test 2>&1 | grep -A2 "agent-sessions-store"
```
Expected: import error — `agent-sessions.js` does not exist yet.

**Step 3: Add `agent_sessions` table to `SQLiteStore.init()`**

In `internal/storage/sqlite.ts`, add to the `this.db.exec(...)` call inside `init()` after the existing tables:

```typescript
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        policy_kind TEXT NOT NULL CHECK(policy_kind IN ('chat', 'task')),
        task_id TEXT CHECK(policy_kind != 'task' OR task_id IS NOT NULL),
        agent_native_session_id TEXT,
        last_seen_event_id TEXT,
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        closed_at INTEGER,
        FOREIGN KEY(room_id) REFERENCES rooms(id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uidx_agent_sessions_chat_active
        ON agent_sessions(room_id, agent_name)
        WHERE policy_kind = 'chat' AND closed_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS uidx_agent_sessions_task_active
        ON agent_sessions(room_id, agent_name, task_id)
        WHERE policy_kind = 'task' AND closed_at IS NULL;
```

**Step 4: Add row type and helper to `SQLiteStore`** (private, at top of class alongside existing row interfaces):

```typescript
interface AgentSessionRow {
  id: string;
  room_id: string;
  agent_name: string;
  policy_kind: "chat" | "task";
  task_id: string | null;
  agent_native_session_id: string | null;
  last_seen_event_id: string | null;
  created_at: number;
  last_active_at: number;
  closed_at: number | null;
}
```

Add a private method `agentSessionRowToDomain` — place it before the new public methods:

```typescript
private agentSessionRowToDomain(row: AgentSessionRow): SessionHandle {
  const policy: SessionPolicy =
    row.policy_kind === "task"
      ? { kind: "task", taskId: row.task_id! }
      : { kind: "chat" };
  return {
    id: row.id,
    roomId: row.room_id,
    agentName: row.agent_name,
    policy,
    agentNativeSessionId: row.agent_native_session_id,
    lastSeenEventId: row.last_seen_event_id,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    ...(row.closed_at !== null ? { closedAt: row.closed_at } : {}),
  };
}
```

**Step 5: Add public CRUD methods to `SQLiteStore`**

```typescript
public getOrCreateAgentSession(
  roomId: string,
  agentName: string,
  policy: SessionPolicy,
): SessionHandle {
  const policyKind = policy.kind;
  const taskId = policyKind === "task" ? policy.taskId : null;

  const fn = this.db.transaction((): SessionHandle => {
    const existing = this.db
      .prepare(
        `SELECT * FROM agent_sessions
         WHERE room_id = ? AND agent_name = ? AND policy_kind = ?
           AND (policy_kind != 'task' OR task_id = ?)
           AND closed_at IS NULL`,
      )
      .get(roomId, agentName, policyKind, taskId) as AgentSessionRow | undefined;

    if (existing) {
      return this.agentSessionRowToDomain(existing);
    }

    const now = Date.now();
    const id = createId("ags");
    this.db
      .prepare(
        `INSERT INTO agent_sessions
           (id, room_id, agent_name, policy_kind, task_id,
            agent_native_session_id, last_seen_event_id, created_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(id, roomId, agentName, policyKind, taskId, now, now);

    return this.agentSessionRowToDomain(
      this.db
        .prepare("SELECT * FROM agent_sessions WHERE id = ?")
        .get(id) as AgentSessionRow,
    );
  });

  return fn();
}

public saveAgentNativeSessionId(id: string, nativeId: string): void {
  if (!nativeId) {
    return; // never overwrite with empty string
  }
  const now = Date.now();
  this.db
    .prepare(
      `UPDATE agent_sessions
       SET agent_native_session_id = ?, last_active_at = ?
       WHERE id = ?`,
    )
    .run(nativeId, now, id);
}

public updateAgentLastSeen(id: string, eventId: string): void {
  const now = Date.now();
  this.db
    .prepare(
      `UPDATE agent_sessions
       SET last_seen_event_id = ?, last_active_at = ?
       WHERE id = ?`,
    )
    .run(eventId, now, id);
}

public closeAgentSession(id: string): void {
  const now = Date.now();
  this.db
    .prepare("UPDATE agent_sessions SET closed_at = ? WHERE id = ?")
    .run(now, id);
}

public listActiveAgentSessions(roomId: string): SessionHandle[] {
  const rows = this.db
    .prepare(
      `SELECT * FROM agent_sessions
       WHERE room_id = ? AND closed_at IS NULL
       ORDER BY last_active_at DESC`,
    )
    .all(roomId) as AgentSessionRow[];
  return rows.map((row) => this.agentSessionRowToDomain(row));
}
```

Note: `getOrCreateAgentSession` and `agentSessionRowToDomain` reference `SessionHandle` and `SessionPolicy` types which come from `../session/agent-sessions.js`. Add the import at the top of `sqlite.ts` after creating that file in Task 3.

**Step 6: Run tests — they still fail** (missing module)

```bash
npm test 2>&1 | grep -c "PASS"
```

Proceed to Task 3 to create the types.

---

### Task 3: SessionHandle types + AgentSessionManager

**Files:**
- Create: `internal/session/agent-sessions.ts`
- Create: `tests/session/agent-sessions.test.ts`

**Step 1: Write failing tests**

Create `tests/session/agent-sessions.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../../internal/storage/sqlite.js";
import { AgentSessionManager } from "../../internal/session/agent-sessions.js";

const ROOM_CONFIG = {
  mode: "manual" as const,
  checkpointThreshold: 10,
  maxHistoryMessages: 100,
  maxContextTokens: 4000,
};

function makeManager() {
  const store = new SQLiteStore(":memory:");
  store.init();
  const manager = new AgentSessionManager(store);
  return { store, manager };
}

test("getOrCreate returns a valid SessionHandle", () => {
  const { store, manager } = makeManager();
  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const handle = manager.getOrCreate(room.id, "claude", { kind: "chat" });

    assert.ok(handle.id.startsWith("ags_"));
    assert.equal(handle.agentName, "claude");
    assert.equal(handle.agentNativeSessionId, null);
  } finally {
    store.close();
  }
});

test("getOrCreate is idempotent for chat policy", () => {
  const { store, manager } = makeManager();
  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const a = manager.getOrCreate(room.id, "claude", { kind: "chat" });
    const b = manager.getOrCreate(room.id, "claude", { kind: "chat" });
    assert.equal(a.id, b.id);
  } finally {
    store.close();
  }
});

test("saveNativeSessionId persists and does not overwrite with empty", () => {
  const { store, manager } = makeManager();
  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const handle = manager.getOrCreate(room.id, "claude", { kind: "chat" });

    manager.saveNativeSessionId(handle.id, "sid-abc");
    manager.saveNativeSessionId(handle.id, ""); // should be ignored

    const active = manager.listActive(room.id);
    assert.equal(active[0].agentNativeSessionId, "sid-abc");
  } finally {
    store.close();
  }
});

test("closeSession removes session from listActive", () => {
  const { store, manager } = makeManager();
  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const handle = manager.getOrCreate(room.id, "claude", { kind: "chat" });
    manager.closeSession(handle.id);
    assert.equal(manager.listActive(room.id).length, 0);
  } finally {
    store.close();
  }
});

test("task policy creates isolated sessions per taskId", () => {
  const { store, manager } = makeManager();
  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const a = manager.getOrCreate(room.id, "codex", { kind: "task", taskId: "t1" });
    const b = manager.getOrCreate(room.id, "codex", { kind: "task", taskId: "t2" });
    assert.notEqual(a.id, b.id);
  } finally {
    store.close();
  }
});
```

**Step 2: Run tests to verify they fail**

```bash
npm test 2>&1 | grep "agent-sessions"
```
Expected: module not found error.

**Step 3: Create `internal/session/agent-sessions.ts`**

```typescript
import type { SQLiteStore } from "../storage/sqlite.js";

export type SessionPolicy =
  | { kind: "chat" }
  | { kind: "task"; taskId: string };

export interface SessionHandle {
  id: string;
  roomId: string;
  agentName: string;
  policy: SessionPolicy;
  agentNativeSessionId: string | null;
  lastSeenEventId: string | null;
  createdAt: number;
  lastActiveAt: number;
  closedAt?: number;
}

export class AgentSessionManager {
  public constructor(private readonly store: SQLiteStore) {}

  public getOrCreate(
    roomId: string,
    agentName: string,
    policy: SessionPolicy,
  ): SessionHandle {
    return this.store.getOrCreateAgentSession(roomId, agentName, policy);
  }

  public saveNativeSessionId(handleId: string, nativeId: string): void {
    this.store.saveAgentNativeSessionId(handleId, nativeId);
  }

  public updateLastSeen(handleId: string, eventId: string): void {
    this.store.updateAgentLastSeen(handleId, eventId);
  }

  public closeSession(handleId: string): void {
    this.store.closeAgentSession(handleId);
  }

  public listActive(roomId: string): SessionHandle[] {
    return this.store.listActiveAgentSessions(roomId);
  }
}
```

**Step 4: Add import to `internal/storage/sqlite.ts`**

Add at top of `sqlite.ts`:
```typescript
import type { SessionHandle, SessionPolicy } from "../session/agent-sessions.js";
```

**Step 5: Run all tests**

```bash
npm run typecheck && npm test
```
Expected: all existing tests pass + new tests for agent-sessions pass.

**Step 6: Commit**

```bash
git add internal/session/agent-sessions.ts internal/storage/sqlite.ts \
        tests/storage/agent-sessions-store.test.ts tests/session/agent-sessions.test.ts
git commit -m "feat(session): add AgentSessionManager and agent_sessions storage"
```

---

### Task 4: Expose AgentSessionManager from SessionService

**Files:**
- Modify: `internal/session/service.ts`

**Purpose:** Make `agentSessions` available to `ChatEngine` without adding a new constructor parameter.

**Step 1: Write failing test (typecheck only)**

After the change, `new SessionService(store).agentSessions` must be typed.
Verify via typecheck, not a unit test.

**Step 2: Modify `SessionService`**

Add import at top:
```typescript
import { AgentSessionManager } from "./agent-sessions.js";
```

Add as public field in the class:
```typescript
export class SessionService {
  public readonly agentSessions: AgentSessionManager;

  public constructor(private readonly store: SQLiteStore) {
    this.agentSessions = new AgentSessionManager(store);
  }
  // ... rest unchanged
}
```

**Step 3: Verify typecheck and tests**

```bash
npm run typecheck && npm test
```
Expected: all pass.

**Step 4: Commit**

```bash
git add internal/session/service.ts
git commit -m "feat(session): expose AgentSessionManager via SessionService.agentSessions"
```

---

### Task 5: Extend adapter contract

**Files:**
- Modify: `internal/adapters/adapter.ts`

**Purpose:** Add `AdapterCapabilities` interface, `capabilities` to `Adapter`, and `sessionHandle?` to `AgentInput`.

**Step 1: Modify `internal/adapters/adapter.ts`**

Add import:
```typescript
import type { SessionHandle } from "../session/agent-sessions.js";
```

Add after existing imports:
```typescript
export interface AdapterCapabilities {
  sessionResume: "native" | "none";
}
```

Extend `AgentInput`:
```typescript
export interface AgentInput {
  roomId: string;
  sessionId: string;
  requestId: string;
  messages: Message[];
  config: AdapterConfig;
  sessionHandle?: SessionHandle;  // optional: undefined = cold start
}
```

Extend `Adapter`:
```typescript
export interface Adapter {
  name: string;
  capabilities: AdapterCapabilities;
  send(input: AgentInput): AsyncGenerator<AdapterEvent>;
  cancel(requestId: string): Promise<void>;
  health(): Promise<AdapterStatus>;
}
```

**Step 2: Verify typecheck — expect errors on adapters missing `capabilities`**

```bash
npm run typecheck 2>&1 | grep "capabilities"
```
Expected: errors in `ClaudeAdapter` and `CodexAdapter` (missing field).

**Step 3: Add `capabilities` stubs to both adapters** (temporary, will be replaced in Tasks 6 and 7)

In `internal/adapters/claude/index.ts`, add to `ClaudeAdapter`:
```typescript
public readonly capabilities: AdapterCapabilities = { sessionResume: "native" };
```

In `internal/adapters/codex/index.ts`, add to `CodexAdapter`:
```typescript
public readonly capabilities: AdapterCapabilities = { sessionResume: "native" };
```

Import `AdapterCapabilities` in both files:
```typescript
import type { Adapter, AdapterCapabilities, AdapterStatus, AgentInput } from "../adapter.js";
```

**Step 4: Verify typecheck and tests pass**

```bash
npm run typecheck && npm test
```
Expected: all pass.

**Step 5: Commit**

```bash
git add internal/adapters/adapter.ts internal/adapters/claude/index.ts \
        internal/adapters/codex/index.ts
git commit -m "feat(adapters): add AdapterCapabilities and sessionHandle to adapter contract"
```

---

### Task 6: Claude adapter session resume

**Files:**
- Modify: `internal/adapters/claude/index.ts`
- Create: `tests/adapters/claude-resume.test.ts`

**Step 1: Write failing tests**

Create `tests/adapters/claude-resume.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClaudeSpawnArgs,
  parseClaudeChunk,
} from "../../internal/adapters/claude/index.js";

// ── spawn args ──────────────────────────────────────────────────────────────

test("buildClaudeSpawnArgs cold start: no --resume flag", () => {
  const args = buildClaudeSpawnArgs("hello", null);
  assert.ok(!args.includes("--resume"));
  assert.equal(args[0], "-p");
  assert.equal(args[1], "hello");
});

test("buildClaudeSpawnArgs resume: --resume <id> before -p", () => {
  const args = buildClaudeSpawnArgs("hello", "sid-123");
  assert.equal(args[0], "--resume");
  assert.equal(args[1], "sid-123");
  assert.equal(args[2], "-p");
  assert.equal(args[3], "hello");
});

// ── session_id extraction ────────────────────────────────────────────────────

test("parseClaudeChunk extracts session_id from result event", () => {
  const raw = JSON.stringify({
    type: "result",
    result: "hello",
    session_id: "sid-abc",
  });
  const parsed = parseClaudeChunk(raw);
  assert.equal(parsed.agentNativeSessionId, "sid-abc");
});

test("parseClaudeChunk returns null agentNativeSessionId when absent", () => {
  const raw = JSON.stringify({ type: "result", result: "hello" });
  const parsed = parseClaudeChunk(raw);
  assert.equal(parsed.agentNativeSessionId, null);
});

test("parseClaudeChunk does not overwrite session_id with null on delta events", () => {
  const resultLine = JSON.stringify({
    type: "result",
    result: "hello",
    session_id: "sid-abc",
  });
  const deltaLine = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "hi" }] },
  });
  const parsed = parseClaudeChunk(`${resultLine}\n${deltaLine}`);
  assert.equal(parsed.agentNativeSessionId, "sid-abc");
});
```

**Step 2: Run to verify failure**

```bash
npm test 2>&1 | grep -A3 "claude-resume"
```
Expected: `buildClaudeSpawnArgs` signature mismatch (wrong arity).

**Step 3: Implement resume in `internal/adapters/claude/index.ts`**

**3a. Update `buildClaudeSpawnArgs`:**

```typescript
export const buildClaudeSpawnArgs = (
  prompt: string,
  resumeSessionId: string | null,
): string[] => [
  ...(resumeSessionId ? ["--resume", resumeSessionId] : []),
  "-p",
  prompt,
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
];
```

**3b. Add `extractSessionId` helper** (inside the file, not exported):

```typescript
const extractSessionId = (event: Record<string, unknown>): string | null => {
  const id = event.session_id;
  return typeof id === "string" && id.length > 0 ? id : null;
};
```

**3c. Update `parseClaudeChunk`** to also return `agentNativeSessionId`:

Change the return type:
```typescript
export const parseClaudeChunk = (
  raw: string,
): { deltaParts: string[]; resultText: string | null; agentNativeSessionId: string | null } => {
```

Add `agentNativeSessionId` variable and extraction in the result event branch:
```typescript
  let agentNativeSessionId: string | null = null;
  // ... existing loop ...
  if (isClaudeResultEvent(maybeObject)) {
    const extracted = extractTextFromUnknown(
      (maybeObject as Record<string, unknown>).result,
    );
    const sid = extractSessionId(maybeObject as Record<string, unknown>);
    if (extracted) {
      resultText = extracted;
    }
    if (sid) {
      agentNativeSessionId = sid;
    }
    continue;
  }
  // ...
  return {
    deltaParts: parts,
    resultText,
    agentNativeSessionId,
  };
```

**3d. Update `send()` in `ClaudeAdapter`**

Replace the `spawn(...)` call:
```typescript
const sessionId = input.sessionHandle?.agentNativeSessionId ?? null;
const prompt = buildPromptForResume(input, sessionId);
const child = spawn("claude", buildClaudeSpawnArgs(prompt, sessionId), {
  stdio: ["ignore", "pipe", "pipe"],
  env: buildClaudeSpawnEnv(process.env),
  cwd: buildClaudeSpawnCwd(process.env),
});
```

Add `buildPromptForResume` helper (exported for tests):
```typescript
export const buildPromptForResume = (
  input: AgentInput,
  resumeSessionId: string | null,
): string => {
  if (resumeSessionId) {
    // Only send the latest user message; agent remembers the rest
    const lastUser = [...input.messages]
      .reverse()
      .find((m) => m.role === "user");
    return lastUser?.text ?? "";
  }
  return buildPrompt(input);
};
```

Update the chunk processing loop to capture `agentNativeSessionId`:
```typescript
  let agentNativeSessionId: string | null = null;

  for await (const chunk of child.stdout) {
    const parsedChunk = parseClaudeChunk(chunk.toString("utf8"));
    if (parsedChunk.resultText) {
      resultText = parsedChunk.resultText;
    }
    if (parsedChunk.agentNativeSessionId) {
      agentNativeSessionId = parsedChunk.agentNativeSessionId;
    }
    // ... rest unchanged
  }
```

Update `messageCompleted` yield to include session ID in metadata:
```typescript
  yield messageCompleted(baseArgs(input), {
    ...startedPayload,
    text: output.trim() || resultText?.trim() || "(no content)",
    metadata: {
      ...startedPayload.metadata,
      ...(agentNativeSessionId ? { agentNativeSessionId } : {}),
    },
  });
```

**3e. Add SESSION_EXPIRED detection**

Add helper:
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

Update the error branch (replace existing `exitCode !== 0` block):
```typescript
  } else if (exitCode !== 0) {
    if (
      input.sessionHandle?.agentNativeSessionId &&
      isSessionExpiredError(stderr)
    ) {
      yield messageError(
        baseArgs(input),
        "SESSION_EXPIRED",
        "claude session expired or not found",
        stderr,
      );
    } else {
      yield messageError(
        baseArgs(input),
        "PROCESS_CRASH",
        `claude process exited with code ${String(exitCode)}`,
        stderr,
      );
    }
  }
```

**Step 4: Update existing claude-cli.test.ts** — the `buildClaudeSpawnArgs` call now requires a second argument. Find its usages and add `null`:

```bash
grep -n "buildClaudeSpawnArgs" tests/adapters/claude-cli.test.ts
```

Update those calls to pass `null` as second argument.

**Step 5: Run all tests**

```bash
npm run typecheck && npm test
```
Expected: all pass including new claude-resume tests.

**Step 6: Commit**

```bash
git add internal/adapters/claude/index.ts tests/adapters/claude-resume.test.ts \
        tests/adapters/claude-cli.test.ts
git commit -m "feat(adapter/claude): add native session resume, session_id extraction, SESSION_EXPIRED"
```

---

### Task 7: Codex adapter session resume

> **Pre-flight:** Verify `codex exec resume` syntax before writing code (see top of plan).

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
} from "../../internal/adapters/codex/index.js";

test("buildCodexSpawnArgs cold start: exec --json prompt", () => {
  const args = buildCodexSpawnArgs("hello", null);
  assert.deepEqual(args, ["exec", "--json", "hello"]);
});

test("buildCodexSpawnArgs resume: exec resume <id> --json prompt", () => {
  const args = buildCodexSpawnArgs("hello", "sid-xyz");
  assert.deepEqual(args, ["exec", "resume", "sid-xyz", "--json", "hello"]);
});
```

> Note: If the verified codex CLI syntax differs from `exec resume <id>`, update these tests to match the actual syntax before implementing.

**Step 2: Implement `buildCodexSpawnArgs`** and resume logic in `internal/adapters/codex/index.ts`

Add exported function:
```typescript
export const buildCodexSpawnArgs = (
  prompt: string,
  resumeSessionId: string | null,
): string[] =>
  resumeSessionId
    ? ["exec", "resume", resumeSessionId, "--json", prompt]
    : ["exec", "--json", prompt];
```

Add `parseCodexSessionId` helper to extract session ID from Codex JSON output:
```typescript
const parseCodexSessionId = (raw: string): string | null => {
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const id = obj.session_id;
      if (typeof id === "string" && id.length > 0) return id;
    } catch {
      // not JSON
    }
  }
  return null;
};
```

Add SESSION_EXPIRED detection:
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

Update `send()` to use resume logic (symmetric with Claude):
```typescript
  const sessionId = input.sessionHandle?.agentNativeSessionId ?? null;
  const prompt = sessionId
    ? ([...input.messages].reverse().find((m) => m.role === "user")?.text ?? "")
    : buildPrompt(input);
  const child = spawn("codex", buildCodexSpawnArgs(prompt, sessionId), {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
```

Capture `agentNativeSessionId` from output and include in `messageCompleted` metadata (pattern identical to Claude adapter).

Add SESSION_EXPIRED detection in error branch:
```typescript
  } else if (exitCode !== 0) {
    if (input.sessionHandle?.agentNativeSessionId && isSessionExpiredError(stderr)) {
      yield messageError(baseArgs(input), "SESSION_EXPIRED", "codex session expired", stderr);
    } else {
      yield messageError(baseArgs(input), "PROCESS_CRASH", `codex process exited with code ${String(exitCode)}`, stderr);
    }
  }
```

**Step 3: Run all tests**

```bash
npm run typecheck && npm test
```
Expected: all pass.

**Step 4: Commit**

```bash
git add internal/adapters/codex/index.ts tests/adapters/codex-resume.test.ts
git commit -m "feat(adapter/codex): add symmetric native session resume and SESSION_EXPIRED"
```

---

### Task 8: ChatEngine integration

**Files:**
- Modify: `internal/engine/chat.ts`
- Create: `tests/engine/session-integration.test.ts`

**Step 1: Write failing integration test**

Create `tests/engine/session-integration.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../../internal/storage/sqlite.js";
import { SessionService } from "../../internal/session/service.js";
import { ChatEngine } from "../../internal/engine/chat.js";
import type { Adapter, AdapterCapabilities, AgentInput } from "../../internal/adapters/adapter.js";
import type { AdapterEvent } from "../../internal/adapters/adapter.js";
import type { SessionHandle } from "../../internal/session/agent-sessions.js";
import { messageCompleted, messageStarted } from "../../internal/adapters/event-factory.js";
import { createId } from "../../internal/session/ids.js";

// Adapter that records calls and simulates session IDs
function makeTrackingAdapter(name: string, responses: Array<{
  sessionId?: string;
  errorClass?: string;
  text?: string;
}>): Adapter & { calls: AgentInput[] } {
  let callIndex = 0;
  const calls: AgentInput[] = [];

  return {
    name,
    capabilities: { sessionResume: "native" as const },
    calls,
    async *send(input: AgentInput): AsyncGenerator<AdapterEvent> {
      calls.push(input);
      const resp = responses[callIndex % responses.length];
      callIndex++;

      const msgId = createId("msg");
      const base = {
        roomId: input.roomId,
        sessionId: input.sessionId,
        requestId: input.requestId,
        source: `adapter.${name}`,
      };
      const payload = {
        messageId: msgId,
        author: `agent.${name}`,
        role: "assistant" as const,
        text: resp.text ?? "ok",
        format: "plain" as const,
        metadata: {
          provider: "test",
          model: "test",
          requestId: input.requestId,
          ...(resp.sessionId ? { agentNativeSessionId: resp.sessionId } : {}),
        },
      };

      if (resp.errorClass === "SESSION_EXPIRED") {
        const { messageError } = await import("../../internal/adapters/event-factory.js");
        yield messageError(base, "SESSION_EXPIRED", "session expired", "");
        return;
      }

      yield messageStarted(base, payload);
      yield messageCompleted(base, payload);
    },
    async cancel() {},
    async health() { return "ready" as const; },
  };
}

function makeEngine(adapter: Adapter) {
  const store = new SQLiteStore(":memory:");
  store.init();
  const session = new SessionService(store);
  const engine = new ChatEngine(session, { [adapter.name]: adapter }, {
    roomName: "test-room",
    agents: [adapter.name],
    roomConfig: { mode: "manual", checkpointThreshold: 50, maxHistoryMessages: 100, maxContextTokens: 8000 },
    adapterMode: "cli",
    adapterTimeoutMs: 5000,
    adapterMaxTokens: 4000,
    agentSkills: {},
  });
  engine.init();
  return { engine, store };
}

test("cold start: no sessionHandle on first turn", async () => {
  const adapter = makeTrackingAdapter("claude", [{ text: "hello", sessionId: "sid-1" }]);
  const { engine } = makeEngine(adapter);

  await engine.processUserMessage("hi");

  assert.equal(adapter.calls.length, 1);
  assert.equal(adapter.calls[0].sessionHandle?.agentNativeSessionId ?? null, null);
});

test("resume: second turn uses saved session ID", async () => {
  const adapter = makeTrackingAdapter("claude", [
    { text: "first", sessionId: "sid-1" },
    { text: "second" },
  ]);
  const { engine } = makeEngine(adapter);

  await engine.processUserMessage("first");
  await engine.processUserMessage("second");

  assert.equal(adapter.calls.length, 2);
  assert.equal(adapter.calls[1].sessionHandle?.agentNativeSessionId, "sid-1");
});

test("resume: second turn messages contain only last user message", async () => {
  const adapter = makeTrackingAdapter("claude", [
    { text: "first", sessionId: "sid-1" },
    { text: "second" },
  ]);
  const { engine } = makeEngine(adapter);

  await engine.processUserMessage("first message");
  await engine.processUserMessage("second message");

  const secondCallMessages = adapter.calls[1].messages;
  assert.equal(secondCallMessages.length, 1);
  assert.equal(secondCallMessages[0].text, "second message");
});

test("SESSION_EXPIRED: engine closes binding and retries cold", async () => {
  const adapter = makeTrackingAdapter("claude", [
    { text: "first", sessionId: "sid-1" },
    { errorClass: "SESSION_EXPIRED" },   // turn 2: session expired
    { text: "recovered", sessionId: "sid-2" }, // turn 2 retry: cold start succeeds
  ]);
  const { engine, store } = makeEngine(adapter);

  await engine.processUserMessage("first");
  const result = await engine.processUserMessage("second");

  // Three adapter calls: turn1, expired-turn2, cold-retry-turn2
  assert.equal(adapter.calls.length, 3);
  // Cold retry has no session handle (it's a fresh start)
  assert.equal(adapter.calls[2].sessionHandle?.agentNativeSessionId ?? null, null);
  // Result reports success from cold retry
  assert.ok(result.some((r) => r.success));
});
```

**Step 2: Run to verify failure**

```bash
npm test 2>&1 | grep "session-integration"
```
Expected: test fails (session integration not yet wired).

**Step 3: Modify `ChatEngine.runDispatch()`**

In `internal/engine/chat.ts`, update `runDispatch`:

```typescript
private async runDispatch(dispatch: Dispatch, isRetry = false): Promise<DispatchResult> {
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

  // Get or create session binding for this agent
  const sessionHandle = this.session.agentSessions.getOrCreate(
    state.room.id,
    dispatch.targetAdapter,
    { kind: "chat" },
  );

  const adapterConfig = this.resolveAdapterConfig(dispatch.targetAdapter);

  // If resuming, send only the last user message; otherwise full context
  const messages =
    sessionHandle.agentNativeSessionId
      ? this.session.buildContextMessages(state.room, adapterConfig.systemPrompt).filter(
          (m) => m.role === "user",
        ).slice(-1)
      : this.session.buildContextMessages(state.room, adapterConfig.systemPrompt);

  let finalText = "";
  let failed: { errorClass: string; message: string } | undefined;
  let agentNativeSessionId: string | null = null;
  let lastEventId: string | null = null;

  for await (const event of adapter.send({
    roomId: state.room.id,
    sessionId: state.sessionId,
    requestId: dispatch.requestId,
    messages,
    config: adapterConfig,
    sessionHandle,
  })) {
    this.session.appendEvent(event);
    this.hooks.onAdapterEvent?.(dispatch.targetAdapter, event);
    lastEventId = event.eventId;

    if (event.type === "message.delta") {
      const payloadText = extractPayloadText(event.payload);
      if (payloadText) {
        finalText += payloadText;
      }
    }

    if (event.type === "message.completed") {
      const payloadText = extractPayloadText(event.payload);
      finalText = payloadText || finalText;
      // Capture session ID returned by adapter
      const meta = (event.payload as { metadata?: { agentNativeSessionId?: string } }).metadata;
      if (meta?.agentNativeSessionId) {
        agentNativeSessionId = meta.agentNativeSessionId;
      }
    }

    if (event.type === "message.error") {
      failed = extractErrorInfo(event.payload);
    }
  }

  // Post-turn: persist session state
  if (agentNativeSessionId) {
    this.session.agentSessions.saveNativeSessionId(sessionHandle.id, agentNativeSessionId);
  }
  if (lastEventId) {
    this.session.agentSessions.updateLastSeen(sessionHandle.id, lastEventId);
  }

  // Recovery: SESSION_EXPIRED → close binding + cold retry (once per turn)
  if (failed?.errorClass === "SESSION_EXPIRED" && !isRetry) {
    this.session.agentSessions.closeSession(sessionHandle.id);
    const coldDispatch: Dispatch = {
      ...dispatch,
      requestId: createId("req"),
    };
    return this.runDispatch(coldDispatch, true);
  }

  if (failed) {
    return {
      adapter: dispatch.targetAdapter,
      requestId: dispatch.requestId,
      success: false,
      text: finalText,
      error: `${failed.errorClass}: ${failed.message}`,
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

**Step 4: Run all tests**

```bash
npm run typecheck && npm test
```
Expected: all pass including session-integration tests.

**Step 5: Commit**

```bash
git add internal/engine/chat.ts tests/engine/session-integration.test.ts
git commit -m "feat(engine): integrate AgentSessionManager, session resume, SESSION_EXPIRED recovery"
```

---

### Task 9: CLI /session commands

**Files:**
- Modify: `cmd/agoryx/main.ts`
- Create: `tests/cmd/session-commands.test.ts`

**Step 1: Write failing tests**

Create `tests/cmd/session-commands.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Helper: run agoryx with piped commands, return stdout
function runCli(commands: string[], extra: string[] = []): string {
  const result = spawnSync(
    "tsx",
    ["cmd/agoryx/main.ts", "chat", "--adapter-mode", "stub", ...extra],
    {
      input: [...commands, "/quit"].join("\n") + "\n",
      encoding: "utf8",
      timeout: 10000,
      cwd: process.cwd(),
    },
  );
  return result.stdout ?? "";
}

test("/session list shows no active sessions initially", () => {
  const out = runCli(["/session list"]);
  assert.ok(out.includes("No active sessions") || out.includes("active session"));
});

test("/session list shows active session after interaction", () => {
  const out = runCli(["@claude hello", "/session list"]);
  assert.ok(out.includes("claude"));
});

test("/session close ends a session", () => {
  const out = runCli(["@claude hello", "/session close claude", "/session list"]);
  assert.ok(out.includes("closed") || out.includes("No active sessions"));
});

test("/session new forces a fresh session", () => {
  const out = runCli(["@claude hello", "/session new claude"]);
  assert.ok(out.includes("new session") || out.includes("reset"));
});
```

**Step 2: Implement `/session` commands in `cmd/agoryx/main.ts`**

Find the existing command dispatch (the `if (input.startsWith("/"))` block) and add a new case:

```typescript
if (input.startsWith("/session")) {
  const parts = input.split(/\s+/);
  const sub = parts[1]; // list | close | new
  const agentArg = parts[2]; // optional agent name

  if (sub === "list") {
    const sessions = engine.listAgentSessions();
    if (sessions.length === 0) {
      console.log("No active sessions.");
    } else {
      for (const s of sessions) {
        const sid = s.agentNativeSessionId ? `[${s.agentNativeSessionId.slice(0, 8)}...]` : "[cold]";
        console.log(`  ${s.agentName}  ${sid}  last active: ${new Date(s.lastActiveAt).toISOString()}`);
      }
    }
  } else if (sub === "close") {
    const closed = engine.closeAgentSession(agentArg ?? null);
    console.log(closed > 0 ? `Closed ${closed} session(s).` : "No matching session found.");
  } else if (sub === "new") {
    const reset = engine.resetAgentSession(agentArg ?? null);
    console.log(reset > 0 ? `Started new session for ${agentArg ?? "all agents"}.` : "No session to reset.");
  } else {
    console.log("Usage: /session list | /session close [agent] | /session new [agent]");
  }
  continue;
}
```

Add corresponding methods to `ChatEngine`:

```typescript
public listAgentSessions(): SessionHandle[] {
  return this.session.agentSessions.listActive(this.getState().room.id);
}

public closeAgentSession(agentName: string | null): number {
  const active = this.session.agentSessions.listActive(this.getState().room.id);
  const targets = agentName
    ? active.filter((s) => s.agentName === agentName)
    : active;
  for (const s of targets) {
    this.session.agentSessions.closeSession(s.id);
  }
  return targets.length;
}

public resetAgentSession(agentName: string | null): number {
  return this.closeAgentSession(agentName);
}
```

Add import for `SessionHandle` in `chat.ts`:
```typescript
import type { SessionHandle } from "../session/agent-sessions.js";
```

Also update `/help` text in `main.ts` to include:
```
  /session list            — show active agent sessions
  /session close [agent]   — close session (or all)
  /session new [agent]     — force fresh session
```

**Step 3: Run all tests**

```bash
npm run typecheck && npm test
```
Expected: all pass.

**Step 4: Commit**

```bash
git add cmd/agoryx/main.ts internal/engine/chat.ts tests/cmd/session-commands.test.ts
git commit -m "feat(cli): add /session list/close/new commands"
```

---

### Task 10: Update bridge files

**Files:**
- Modify: `bridge/SESSION.md`
- Append: `bridge/LOG.md`

**Step 1: Verify full test suite**

```bash
npm run typecheck && npm test
```
Expected: all tests pass (previous count + new tests for this feature).
Record the final count.

**Step 2: Update `bridge/SESSION.md`**

Update the "Active Goal" to v0.2 scope and add session manager to project structure.

**Step 3: Append to `bridge/LOG.md`**

Follow the LOG format from `CLAUDE.md`. Include:
- What was implemented (SessionManager, storage, adapters, engine, CLI)
- Test count before → after
- Known risks (codex exec resume syntax needs live verification)
- Next steps for Codex

**Step 4: Final commit**

```bash
git add bridge/SESSION.md bridge/LOG.md
git commit -m "docs(bridge): update session state after persistent sessions implementation"
```

---

## Quick reference

| Run tests | `npm test` |
|-----------|-----------|
| Typecheck | `npm run typecheck` |
| Both | `npm run typecheck && npm test` |
| CLI smoke | `echo "@claude hello\n/session list\n/quit" \| tsx cmd/agoryx/main.ts chat --adapter-mode stub` |

## Risks and notes

| Risk | Mitigation |
|------|-----------|
| `codex exec resume <id>` syntax unverified | Run pre-flight check; adjust `buildCodexSpawnArgs` if syntax differs |
| `session_id` field name in Claude stream-json unverified | Check output with `claude -p "hello" --output-format stream-json --verbose` and grep for `session` |
| ChatEngine `messages` filter for resume may be too narrow | If agents need broader context, adjust `buildContextMessages` slice logic in Task 8 |
| Unique index may fail if DB was initialized without migration | `init()` uses `CREATE TABLE IF NOT EXISTS` — tables created fresh on `:memory:`, migration strategy for existing DBs deferred to v0.2 release notes |
