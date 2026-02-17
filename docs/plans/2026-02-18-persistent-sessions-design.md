# Persistent Agent Sessions — Design Document

## Date
2026-02-18

## Status
Approved (brainstormed and validated by Ivan + Claude)

## Problem

Agoryx v0.1 uses a fire-and-forget model: each adapter call spawns a new CLI process (`claude -p` / `codex exec`), rebuilds context from scratch (serialized messages truncated to 20k chars), and the process dies after one response. Agents have no memory between turns, no access to their own tools between messages, and no persistent conversation state.

## Goals

1. Agents maintain persistent sessions with memory across turns via native CLI resume.
2. Agents work in a shared workspace and keep tool access between messages.
3. True multi-turn dialogue: agents receive incremental deltas, not full history rebuilds.
4. Foundation for v0.2 agentic adapter mode and team pipeline.
5. Both Claude and Codex adapters use native `--resume` support.

## Non-Goals

1. Interactive stdin/stdout transport (deferred — future fast-path optimization).
2. Multi-process Agoryx runtime (v0.2 is single process; in-memory lock suffices).
3. SDK-based adapters (CLI-first remains default).
4. Shared provider session between agents (isolation required for role control).

## Key Insight

"Persistent session" does not equal "living process". A session can be persistent even with spawn-per-turn, if the CLI supports `--resume <session-id>`. Both CLIs support this natively:

- Self-hosting answers "where and how it runs"
- Persistent sessions answers "how agents live between turns"

These are complementary, not competing concerns.

## Validated CLI Capabilities

| CLI | New Session | Resume | Session ID Source |
|-----|-------------|--------|-------------------|
| `codex exec <prompt> --json` | `thread.started` event: `{"type":"thread.started","thread_id":"<uuid>"}` | `codex exec resume <thread_id> <prompt> --json` | First JSON line in output |
| `claude -p <prompt> --output-format stream-json --verbose` | Session ID in output (to be validated in spike) | `claude --resume <session-id> -p <prompt> ...` | Spike validation item |

Codex resume validated end-to-end: agent correctly recalls prior conversation after resume.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   ChatEngine                     │
│  processUserMessage() → orchestrate → dispatch   │
└──────────────┬──────────────────────┬────────────┘
               │                      │
┌──────────────▼──────────┐ ┌────────▼─────────────┐
│    Session Service       │ │   Orchestrator       │
│  - delta computation     │ │   - routing policy   │
│  - cursor management     │ │   - dispatch order   │
│  - prompt assembly       │ │                      │
│  - agent_sessions CRUD   │ │                      │
│  - concurrency lock      │ │                      │
│  - error recovery        │ │                      │
└──────────────┬──────────┘ └──────────────────────┘
               │
┌──────────────▼──────────────────────────────────┐
│           PersistentAdapter (thin)                │
│  sendTurn() → spawn CLI (cold or resume)         │
│  emit session.bound with nativeSessionId         │
│  destroy?() → optional cleanup                   │
└──────────────┬──────────────────────────────────┘
               │
        ┌──────▼──────┐
        │  CLI Process │
        │  (per turn)  │
        └─────────────┘
```

### Responsibility Split

- **Adapter**: knows only its provider's CLI protocol (how to spawn, how to parse session_id, how to resume). Thin transport layer.
- **Session Service**: knows business logic (delta computation, cursor management, prompt assembly, error recovery, concurrency lock).
- **Engine**: coordinates lifecycle, connects orchestrator decisions to session service and adapters.

## Adapter Contract

```typescript
type SessionErrorClass = 'SESSION_EXPIRED' | 'TRANSIENT' | 'FATAL';

interface SendTurnInput {
  roomId: string;
  sessionId: string;              // Agoryx internal session ID
  requestId: string;
  nativeSessionId: string | null; // null = cold start, string = resume
  prompt: string;                 // assembled by session service (delta + user message)
  config: AdapterConfig;
}

interface PersistentAdapter extends Adapter {
  // Cold start: nativeSessionId=null → new CLI session
  // Warm: nativeSessionId=<id> → resume existing session
  sendTurn(input: SendTurnInput): AsyncGenerator<AdapterEvent>;

  // Optional cleanup (no-op for CLI adapters)
  destroy?(nativeSessionId: string): Promise<void>;
}

// New event type emitted by adapter during stream
// Session Service extracts nativeSessionId from event stream
type SessionBoundPayload = { nativeSessionId: string };
// event.type = 'session.bound'
```

### Key Decisions

1. `createSession()` eliminated — `sendTurn()` handles both cold (null) and warm (string) via `nativeSessionId`.
2. `session.bound` event can arrive at any point in stream (not necessarily first — some CLIs emit session ID late).
3. `destroy()` is optional capability.
4. Existing `send()` remains for `stub` mode — backward compatible.
5. No stateful fields on adapter — all state flows through events.
6. `nativeSessionId` is `string | null`, not `string | undefined` — cold/warm are explicit.

## Storage Schema

```sql
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,                          -- agtsess_<uuid>
  room_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,                     -- 'claude' | 'codex'
  native_session_id TEXT,                       -- null until session.bound arrives
  transport_mode TEXT NOT NULL DEFAULT 'resume'
    CHECK(transport_mode IN ('resume', 'interactive')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active', 'expired', 'failed')),
  last_seen_seq INTEGER,                        -- monotonic cursor (event_seq)
  fail_count INTEGER NOT NULL DEFAULT 0
    CHECK(fail_count >= 0),
  created_at INTEGER NOT NULL,                  -- unix ms
  last_turn_at INTEGER                          -- unix ms
);

-- Partial unique: only one active session per agent per room
CREATE UNIQUE INDEX idx_agent_sessions_active
  ON agent_sessions(room_id, agent_name)
  WHERE status = 'active';

-- Performance indexes for delta queries
CREATE INDEX idx_messages_room_seq
  ON messages(room_id, event_seq);
CREATE INDEX idx_messages_room_author_seq
  ON messages(room_id, author, event_seq);
```

### Why This Schema

- `event_seq INTEGER` — monotonic, not UUID. Reliable cursor comparison.
- Partial unique index — `expired`/`failed` sessions don't block creating new `active` one.
- `status` + `fail_count` — enables error policy without deleting history.
- `transport_mode` — ready for future `interactive` transport.
- `INTEGER` timestamps — fast filtering and sorting.
- CHECK constraints — data integrity at DB level.

### Monotonic Sequence

The existing `messages` table uses `rowid` for ordering (`listMessagesAfter` already relies on it). Either:
- Use `rowid` directly as `event_seq` (simpler, already monotonic)
- Add explicit `event_seq INTEGER` column (more explicit, safer)

Decision: validate in implementation which approach is cleaner.

## Delta Injection Flow

```
1. User sends message
2. Engine → Orchestrator: route to agent(s)
3. For each dispatch:
   a. Acquire concurrency lock for (room_id, agent_name)
   b. Snapshot cutoff_seq = current MAX(event_seq) for room
   c. Load active agent_session for (room, agent)
   d. Compute delta:
      SELECT * FROM messages
      WHERE room_id = ?
        AND event_seq > last_seen_seq
        AND event_seq <= cutoff_seq
        AND author != 'agent.<name>'
      ORDER BY event_seq ASC
   e. Assemble prompt:
      ┌─────────────────────────────────┐
      │ [Team context since your last   │
      │  response]                      │
      │ - [codex][msg_184] said: "..."  │
      │ - [user][msg_185] said: "..."   │
      │                                 │
      │ [Current request]               │
      │ <user's latest message>         │
      └─────────────────────────────────┘
   f. Adapter.sendTurn({
        nativeSessionId: agent_session.native_session_id,
        prompt: assembled,
        ...
      })
   g. Adapter emits events: session.bound?, message.delta*, message.completed
   h. ATOMIC SQLite transaction:
      - save all adapter events
      - update last_seen_seq = MAX(last_seen_seq, cutoff_seq)
      - update last_turn_at
      - if session.bound received: save native_session_id
   i. Release concurrency lock
```

### Why cutoff_seq

If during generation a new event arrives (e.g., parallel agent response), it must NOT be included in the cursor update. It enters the next delta instead. `cutoff_seq` is snapshot **before** sendTurn, not "latest after turn".

### Cursor Update Semantics

`last_seen_seq = MAX(last_seen_seq, cutoff_seq)` — never rollback. Prevents regression on retry/race conditions.

## Error Recovery Policy

| Error Class | Action | Cursor | Session Status |
|---|---|---|---|
| `SESSION_EXPIRED` | `status='expired'`, `native_session_id=NULL`, auto-retry cold (1 attempt) | do not advance | `expired` → new `active` created |
| `TRANSIENT` | `fail_count++`, retry with backoff (up to 3 attempts) | do not advance | remains `active` |
| `FATAL` | `status='failed'`, notify user | do not advance | `failed` |

### session.bound Not Received

- **Warm turn** (has `native_session_id`): keep existing ID, consider turn successful if `message.completed` arrived.
- **Cold start** (no ID and no `session.bound`): turn = failed, mark `FATAL`.

### Concurrency Lock

- In-memory `Map<string, Promise>` keyed by `${room_id}:${agent_name}`.
- Next turn waits for previous turn to complete.
- Sufficient for single-process Agoryx (v0.2). Multi-process would need SQLite advisory lock.

## Adapter Implementation Notes

### Codex Adapter

- **Cold**: `codex exec <prompt> --json` → extract `thread_id` from `{"type":"thread.started","thread_id":"..."}` → emit `session.bound`
- **Warm**: `codex exec resume <thread_id> <prompt> --json` → emit `session.bound` from `thread.started`
- `destroy()`: not implemented

### Claude Adapter

- **Cold**: `claude -p <prompt> --output-format stream-json --verbose` → extract session ID from output → emit `session.bound`
- **Warm**: `claude --resume <session-id> -p <prompt> --output-format stream-json --verbose` → emit `session.bound`
- `destroy()`: not implemented
- **Spike risk**: Claude session ID extraction format needs validation (cannot test from within Claude Code)

## Backwards Compatibility

- Existing `Adapter.send()` remains for `stub` mode and one-shot `cli` mode.
- `PersistentAdapter` extends `Adapter` — no breaking changes.
- `ChatEngine` checks adapter mode and dispatches to `send()` or `sendTurn()` accordingly.
- New `AdapterMode`: `'stub' | 'cli' | 'persistent'`.
- All 136 existing tests must continue passing.

## Test Plan

### Unit Tests
1. Delta computation: correct seq range, author filtering, empty delta
2. Prompt assembly: delta block format, cold vs warm prompt
3. Cursor update: MAX semantics, rollback protection
4. Error classification: SESSION_EXPIRED / TRANSIENT / FATAL mapping
5. Concurrency lock: serialization of concurrent turns for same agent

### Integration Tests
6. Codex cold start → session.bound → nativeSessionId saved in agent_sessions
7. Codex resume → agent recalls prior conversation context
8. Claude cold start → session.bound → nativeSessionId saved (test outside Claude Code)
9. Claude resume → agent recalls prior context
10. Cross-agent delta: Claude sees Codex response through delta injection
11. Session expiry → auto-recovery with cold retry
12. Restart/resume: agent_sessions persist, resume works after restart

### Regression Tests
13. Existing v0.1 stub/cli mode works without changes
14. All 136 existing tests pass

## Delivery Order

1. Schema: `agent_sessions` table + indexes + migration + `event_seq` column
2. Session Service: cutoff/delta/cursor/error policy/concurrency lock
3. Adapters: Codex + Claude (cold/warm sendTurn + session.bound emission)
4. Engine integration + unit/integration/regression tests

## Open Risks

1. **Claude session ID extraction**: format unvalidated (cannot test from within Claude Code). Spike item.
2. **In-memory lock**: sufficient for single process only.
3. **CLI `--resume` stability**: behavior may change across provider versions.
4. **Delta prompt format**: may need tuning for optimal agent comprehension.
5. **event_seq monotonic source**: rowid vs explicit column — validate in implementation.
