# Design: Persistent Agent Sessions (v0.2)

**Date:** 2026-02-18
**Status:** Approved
**Scope:** v0.2

## Problem

In v0.1, every agent turn spawns a new process (`claude -p <full_history>` / `codex exec --json <full_history>`). Agoryx reconstructs the full conversation context from SQLite on each request and injects it as plain text. This is:

- **Inefficient**: grows linearly with conversation length
- **Lossy**: native agent state (reasoning, internal working memory) is lost between turns
- **Wrong model**: stateless RPC instead of a stateful agent runtime

## Goal

Move to a **SessionManager-first architecture** where Agoryx maintains persistent session bindings for each agent, and adapters use native CLI resume capabilities when available.

Target state: agents maintain their own context window between turns. Agoryx routes messages; it no longer reconstructs dialogue history.

---

## Design

### 1. Types

```typescript
// Session lifecycle policy
type SessionPolicy =
  | { kind: 'chat' }                       // sticky per-room
  | { kind: 'task'; taskId: string };      // isolated per-task

// Session binding stored in Agoryx
interface SessionHandle {
  id: string;                              // Agoryx-internal binding ID
  roomId: string;
  agentName: string;
  policy: SessionPolicy;
  agentNativeSessionId: string | null;     // null = cold (not yet obtained)
  lastSeenEventId: string | null;          // for delta injection fallback
  createdAt: number;
  lastActiveAt: number;
  closedAt?: number;
}

// Adapter capability declaration
interface AdapterCapabilities {
  sessionResume: 'native' | 'none';
  // 'native' = adapter passes --resume / exec resume natively
  // 'none'   = SessionManager handles delta injection (fallback for future providers)
}
```

`AgentInput` is extended with one optional field (backwards compatible):

```typescript
interface AgentInput {
  // ... existing fields unchanged ...
  sessionHandle?: SessionHandle;
}
```

### 2. AgentSessionManager

New file: `internal/session/agent-sessions.ts`

```typescript
interface AgentSessionManager {
  // Returns existing active session or creates a new one (transactional)
  getOrCreate(roomId: string, agentName: string, policy: SessionPolicy): Promise<SessionHandle>;

  // Saves native session ID returned by the agent after its first turn
  // Does NOT overwrite if nativeId is null/empty (provider may not return it every turn)
  saveNativeSessionId(handleId: string, nativeId: string): Promise<void>;

  // Updates lastSeenEventId after each turn
  updateLastSeen(handleId: string, eventId: string): Promise<void>;

  // Closes a session (manual, idle TTL, or post-expiry recovery)
  closeSession(handleId: string): Promise<void>;

  // Lists active session bindings for a room
  listActive(roomId: string): Promise<SessionHandle[]>;
}
```

`saveNativeSessionId` and `updateLastSeen` update `last_active_at` automatically.
`getOrCreate` is transactional (SELECT + INSERT in one `better-sqlite3` transaction).

### 3. Storage Schema

New table in `internal/storage/sqlite.ts`:

```sql
CREATE TABLE agent_sessions (
  id                      TEXT PRIMARY KEY,
  room_id                 TEXT NOT NULL,
  agent_name              TEXT NOT NULL,
  policy_kind             TEXT NOT NULL CHECK(policy_kind IN ('chat', 'task')),
  task_id                 TEXT CHECK(policy_kind != 'task' OR task_id IS NOT NULL),
  agent_native_session_id TEXT,
  last_seen_event_id      TEXT,
  created_at              INTEGER NOT NULL,
  last_active_at          INTEGER NOT NULL,
  closed_at               INTEGER
);

-- Enforce one active chat session per (room, agent)
CREATE UNIQUE INDEX uidx_agent_sessions_chat_active
  ON agent_sessions(room_id, agent_name)
  WHERE policy_kind = 'chat' AND closed_at IS NULL;

-- Enforce one active task session per (room, agent, task)
CREATE UNIQUE INDEX uidx_agent_sessions_task_active
  ON agent_sessions(room_id, agent_name, task_id)
  WHERE policy_kind = 'task' AND closed_at IS NULL;
```

### 4. Data Flow

Both Claude and Codex are symmetric: each supports native session resume.

```
User message
  → ChatEngine.dispatch(roomId, agentName, message)
      → sessionManager.getOrCreate(roomId, agentName, { kind: 'chat' })
          → [transactional] find active chat session OR create new handle

      → build AgentInput:
          sessionHandle.agentNativeSessionId?
            yes → messages = [lastUserMessage only]     ← agent remembers the rest
            no  → messages = buildContext()             ← full history (current behavior)

      → Adapter.send(input)
          agentNativeSessionId?
            yes → spawn("claude", ["--resume", id, "-p", lastMsg, ...])
                  spawn("codex", ["exec", "resume", id, lastMsg, "--json"])
            no  → spawn("claude", ["-p", fullHistory, ...])           ← cold start
                  spawn("codex", ["exec", "--json", fullHistory])      ← cold start

          on resume failure (exit code, stderr indicates "session not found/expired"):
            → yield messageError(..., "SESSION_EXPIRED", ...)

          extract session_id from result metadata → messageCompleted.metadata.agentNativeSessionId

      → ChatEngine: [single transaction]
          saveNativeSessionId(handleId, extractedId)  ← only if extracted (don't overwrite on null)
          updateLastSeen(handleId, lastEventId)
          write agent event to messages table

      → Recovery (SESSION_EXPIRED, retry guard = 1 per turn):
          closeSession(handleId)
          retry via cold start once
          if cold start also fails → propagate error
```

**Delta injection** (`sessionResume: 'none'`) is a fallback for future providers without native resume. Codex and Claude both use `'native'` in v0.2.

### 5. Error Codes

Adapters unify resume failure to a single error code:

```
SESSION_EXPIRED   — native session not found, expired, or rejected by provider
```

Recovery in ChatEngine:
1. `SESSION_EXPIRED` received → `closeSession(handleId)` → retry cold start once
2. Retry guard: max 1 cold retry per turn (prevent infinite loop)
3. Cold start success → new `agentNativeSessionId` stored for next turn

### 6. CLI Commands

New in-chat commands (`cmd/agoryx/main.ts`):

```
/session list               — show active session bindings for current room
/session close [agent]      — close session for agent (or all agents)
/session new [agent]        — force cold start for agent (close existing + no resume)
```

### 7. Files Changed

| File | Change |
|------|--------|
| `internal/session/agent-sessions.ts` | NEW: `AgentSessionManager`, `SessionHandle`, `SessionPolicy` |
| `internal/storage/sqlite.ts` | ADD: `agent_sessions` table + `getOrCreateSession`, `saveNativeSessionId`, `updateLastSeen`, `closeSession`, `listActiveSessions` |
| `internal/adapters/adapter.ts` | ADD: `AdapterCapabilities`; EXTEND: `AgentInput.sessionHandle?` |
| `internal/adapters/claude/index.ts` | ADD: resume spawn args, session_id extraction, `SESSION_EXPIRED` error |
| `internal/adapters/codex/index.ts` | ADD: symmetric resume logic |
| `internal/engine/chat.ts` | ADD: inject `SessionManager`, post-turn transaction, recovery branch |
| `cmd/agoryx/main.ts` | ADD: `/session list/close/new` command handlers |

### 8. Tests

| File | Coverage |
|------|----------|
| `tests/session/agent-sessions.test.ts` | getOrCreate (idempotent, task isolation), saveNativeSessionId (no overwrite on null), closeSession, unique index constraint |
| `tests/adapters/claude-resume.test.ts` | resume spawn args, session_id extraction, SESSION_EXPIRED error |
| `tests/adapters/codex-resume.test.ts` | symmetric resume logic |
| `tests/engine/session-integration.test.ts` | `cold → resume → restart → resume → expired → cold retry` |

### 9. Out of Scope (v0.2)

- Long-lived process management (v0.3+)
- Task-scoped sessions via CLI (`/session task start`) — architecture supports it, command deferred
- Idle TTL auto-close — architecture supports it via `closed_at`, deferred
- Codex `exec resume` CLI verification — may need spike before implementation

---

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Session resume model | Native CLI resume (both adapters) | Agents maintain own context window; no history reconstruction |
| Session policy for v0.2 | `chat` (per-room sticky) | Simplest useful policy; `task` architecture ready but CLI deferred |
| Cold start fallback | Always available | Backwards compatible; new rooms/agents cold-start naturally |
| Recovery strategy | SESSION_EXPIRED → closeSession → 1x cold retry | Prevents infinite loops; transparent to user |
| Delta injection | Fallback only (`sessionResume: 'none'`) | Future providers without native resume |
| Agoryx as truth | SQLite stores all messages regardless | Sessions are an optimization, not the source of truth |
