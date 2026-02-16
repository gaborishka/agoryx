# Agoryx — Architecture

## Design Goal

Provide one shared multi-agent conversation using existing local LLM CLIs, with strict separation between transport, session/context, and orchestration. Every design decision in v0.1 must be reversible or extensible without rewriting core logic.

## Runtime Strategy

**v0.1:** Single foreground CLI process (`agoryx chat ...`). No separate daemon, no background services. The process owns the room, the adapters, and the UI loop. This minimizes lifecycle complexity while preserving a clear upgrade path.

**v0.2+:** Optional long-lived local daemon (`agoryxd`) with CLI and Web clients connecting over a local socket or HTTP. The daemon reuses the same session and orchestration layers — only the entry point changes.

## System Layers

```
┌─────────────────────────────────────────────────┐
│                   CLI / Web UI                   │
├─────────────────────────────────────────────────┤
│              Orchestration Layer                 │
│         (policies: manual, round-robin, auto)    │
├─────────────────────────────────────────────────┤
│                Session Layer                     │
│      (rooms, messages, context, summaries)       │
├─────────────────────────────────────────────────┤
│              Transport Layer                     │
│         (adapters: codex, claude, ...)           │
└─────────────────────────────────────────────────┘
```

---

## Transport Layer

**Responsibility:** Communicate with external systems (initially local CLI tools). Translate provider-specific formats into normalized internal events. Never leak raw provider output above this layer.

### Adapter Contract

Every adapter implements the following interface:

```typescript
interface Adapter {
  name: string;                           // e.g. "codex", "claude"
  send(input: AgentInput): AsyncStream<Event>;
  cancel(requestId: string): Promise<void>;
  health(): Promise<AdapterStatus>;
}

interface AgentInput {
  requestId: string;
  messages: Message[];         // conversation history (already context-managed)
  systemPrompt?: string;       // role/persona instructions
  config: AdapterConfig;       // timeout, max tokens, etc.
}

type AdapterStatus = "ready" | "busy" | "error" | "not_authenticated";
```

### Initial Adapters

**codex-adapter:** Wraps `codex exec --json` or the `@openai/codex-sdk` Node.js SDK. Parses JSON output events, maps them to internal event types. Handles Codex-specific authentication (ChatGPT plan login).

**claude-adapter:** Wraps `claude -p --output-format stream-json`. Parses streaming JSON events, maps them to internal event types. Detects whether `ANTHROPIC_API_KEY` is set (API billing) vs. subscription-based auth (Claude Code login).

### Adapter Rules

Parse provider output into normalized internal events. Classify errors into typed categories (see Error Model). If the adapter process crashes, emit `message.error` and report status via `health()`. Never buffer entire responses in memory — stream events as they arrive.

---

## Session Layer

**Responsibility:** Room state, message persistence, context preparation for each agent call, and session replay.

### Core Entities

```
Room
├── id: string
├── name: string
├── participants: Participant[]     // user + agents
├── orchestrationPolicy: string     // "manual" | "round-robin" | "auto"
├── config: RoomConfig
└── createdAt: timestamp

Message
├── id: string
├── roomId: string
├── author: string                  // "user" | "agent.codex" | "agent.claude"
├── role: "user" | "assistant"
├── text: string
├── format: "markdown" | "plain"
├── parentId?: string               // for threaded replies (future)
├── metadata: MessageMetadata
└── timestamp: timestamp

Checkpoint
├── id: string
├── roomId: string
├── summaryText: string
├── coversMessageRange: [fromId, toId]
└── createdAt: timestamp

PinnedContext
├── id: string
├── roomId: string
├── label: string
├── content: string
└── pinnedBy: string
```

### Storage

Local SQLite database (single file, zero config). Tables: `rooms`, `messages`, `checkpoints`, `pinned_context`, `events_log`. The `events_log` table is append-only for debugging and replay.

### Context Building

When an agent needs to respond, the session layer builds its input:

```
1. Start with system prompt (agent role/persona if configured)
2. Add all pinned context blocks for this room
3. If message count > threshold:
   a. Find latest checkpoint summary
   b. Include summary + messages after that checkpoint
4. Else: include full message history
5. Append the triggering user message
6. Trim to fit adapter's context budget (configurable per adapter)
```

This ensures every agent sees: its role, persistent context the user pinned, a summary of older conversation, and recent messages verbatim.

---

## Orchestration Layer

**Responsibility:** Decide who responds and when. The orchestrator receives events from the session layer and dispatches requests to adapters via the transport layer.

### Policy Interface

```typescript
interface OrchestrationPolicy {
  name: string;
  onUserMessage(room: Room, message: Message): Dispatch[];
  onAgentMessage(room: Room, message: Message): Dispatch[];
}

interface Dispatch {
  targetAdapter: string;        // "codex" | "claude"
  priority: number;             // for ordering when multiple dispatches
  requestId: string;
}
```

### v0.1 Policies

**manual:** Respond only when explicitly targeted via `@agent` mention. If no mention, prompt the user to specify. This is the safest default — the user has full control.

**round-robin:** Alternate responders on each user turn. After user speaks, the next agent in rotation responds. The user can override by using `@mention`.

**auto:** Both agents respond to every user message. Responses are displayed sequentially. Simple but token-expensive — useful for comparison and brainstorming.

### Message Flow — Manual Mode

```
User types: "@codex propose a file layout"
        │
        ▼
   [CLI Input Parser]
        │ detects @codex mention
        ▼
   [Orchestrator: manual policy]
        │ creates Dispatch → codex-adapter
        ▼
   [Session Layer]
        │ builds context (history + pinned + system prompt)
        ▼
   [Transport: codex-adapter]
        │ spawns: codex exec --json
        │ streams events back
        ▼
   [Session Layer]
        │ stores message, updates room state
        ▼
   [CLI Output]
        │ renders streamed response with "codex:" prefix
        ▼
   User sees response, types: "@claude critique this"
        │
        ▼
   [Orchestrator: manual policy]
        │ creates Dispatch → claude-adapter
        │ context now includes codex's response
        ▼
   ... same flow, claude sees full history including codex's answer
```

### Message Flow — Round-Robin Mode

```
User types: "What's the best approach for error handling?"
        │
        ▼
   [Orchestrator: round-robin policy]
        │ rotation state: next = codex
        │ creates Dispatch → codex-adapter
        ▼
   [codex responds, stored in session]
        │
        ▼
   User types: "Interesting. What about retry strategies?"
        │
        ▼
   [Orchestrator: round-robin policy]
        │ rotation state: next = claude
        │ creates Dispatch → claude-adapter
        │ context includes codex's previous response
        ▼
   [claude responds, stored in session]
```

---

## Internal Event Contract

### Event Envelope

```json
{
  "event_id": "evt_abc123",
  "room_id": "room_001",
  "session_id": "sess_001",
  "timestamp": "2026-02-16T12:00:00Z",
  "source": "adapter.codex",
  "type": "message.delta",
  "request_id": "req_789",
  "payload": {}
}
```

### Event Types

| Type | Description |
|------|-------------|
| `message.started` | Agent began generating a response |
| `message.delta` | Incremental text chunk (for streaming display) |
| `message.completed` | Agent finished responding (includes full text + token usage) |
| `message.error` | Agent failed (includes error class and detail) |
| `tool.call.started` | Agent invoked a tool (future: for agents with tool access) |
| `tool.call.completed` | Tool returned result |
| `agent.status` | Health/availability change |
| `session.checkpoint` | Summary checkpoint was created |

### Message Payload

```json
{
  "message_id": "msg_001",
  "author": "agent.codex",
  "role": "assistant",
  "text": "Here is my suggestion...",
  "format": "markdown",
  "metadata": {
    "provider": "openai",
    "model": "codex",
    "token_usage": { "input": 1200, "output": 450 },
    "latency_ms": 3200
  }
}
```

---

## Error Model

### Error Classes

| Class | Description | Default Behavior |
|-------|-------------|-----------------|
| `AUTH_ERROR` | CLI not authenticated or token expired | Show error, suggest re-login |
| `RATE_LIMIT` | Provider rate limit hit | Backoff, notify user, skip turn |
| `TIMEOUT` | Response exceeded configured timeout | Cancel, notify, offer retry |
| `PROCESS_CRASH` | CLI subprocess exited unexpectedly | Restart adapter, notify user |
| `PROTOCOL_ERROR` | Unexpected output format from CLI | Log raw output, emit error event |
| `UNKNOWN` | Unclassified failure | Log everything, emit error event |

### Handling Rules

Mark only the affected dispatch as failed. Emit `message.error` with typed class and raw stderr excerpt. Keep the room active — continue with remaining agents. Offer a retry command at the orchestration level (`/retry @codex`).

---

## Configuration

### Room Config File (agoryx.yaml)

```yaml
version: "0.1"
default_mode: manual
agents:
  codex:
    adapter: codex
    timeout_seconds: 120
    system_prompt: "You are a collaborative participant in a group discussion."
  claude:
    adapter: claude
    timeout_seconds: 120
    system_prompt: "You are a collaborative participant in a group discussion."
context:
  max_history_messages: 100
  checkpoint_threshold: 50    # create summary after this many messages
  max_context_tokens: 30000   # per-agent context budget
session:
  db_path: "./agoryx.db"
  auto_save: true
```

### CLI Commands (v0.1)

```bash
# Start a new chat room
agoryx chat --agents codex,claude --mode manual

# Resume a previous session
agoryx chat --resume <session_id>

# List past sessions
agoryx sessions list

# Export a session
agoryx sessions export <session_id> --format markdown

# Check adapter health
agoryx status
```

### In-Chat Commands

```
@codex <message>         # direct message to codex
@claude <message>        # direct message to claude
@all <message>           # broadcast to all agents
/mode round-robin        # switch orchestration mode
/mode manual
/pin <text>              # add to pinned context
/unpin <id>              # remove pinned context
/summary                 # generate checkpoint summary
/retry @codex            # retry last failed request
/export markdown         # export session
/status                  # show adapter health
/quit                    # end session
```

---

## Suggested Project Layout

```
agoryx/
├── cmd/
│   └── agoryx/          # CLI entrypoint
│       └── main.go      # (or main.ts — language TBD)
├── internal/
│   ├── adapters/
│   │   ├── adapter.go   # interface definition
│   │   ├── codex/       # codex CLI adapter
│   │   └── claude/      # claude CLI adapter
│   ├── orchestrator/
│   │   ├── policy.go    # policy interface
│   │   ├── manual.go
│   │   ├── roundrobin.go
│   │   └── auto.go
│   ├── session/
│   │   ├── room.go
│   │   ├── context.go   # context builder
│   │   └── checkpoint.go
│   ├── events/
│   │   └── types.go     # event envelope, payload types
│   └── storage/
│       └── sqlite.go    # SQLite persistence
├── config/
│   └── default.yaml
├── docs/
│   ├── VISION.md
│   ├── ARCHITECTURE.md
│   └── CONSENSUS.md
├── tests/
│   ├── adapters/        # contract tests per adapter
│   ├── orchestrator/    # policy logic tests
│   └── integration/     # end-to-end with mock adapters
├── go.mod               # (or package.json — language TBD)
└── README.md
```

---

## Test Strategy

**Unit tests:** Event normalization for each adapter. Policy decisions for manual, round-robin, and auto. Session context builder and checkpoint selection. Error classification and handling.

**Contract tests:** Each adapter has a test suite that verifies: it produces valid internal events from sample CLI output; it handles error cases (timeout, crash, malformed output); it reports correct health status.

**Integration tests:** Mock adapter streams with partial responses, errors, and cancellation. End-to-end room lifecycle: create → chat → checkpoint → resume. Replay test that rebuilds room state from the event log.

---

## Evolution Path

Keep transport adapters replaceable — adding Gemini CLI or Ollama should require only a new adapter, no core changes. Add daemon mode only when CLI-first flow is stable. Keep API-sourced adapters (direct HTTP to provider APIs) optional and separate from subscription-backed CLI adapters. Consider MCP (Model Context Protocol) as a future transport option for richer agent interaction.

---

## Open Technical Questions for v0.2+

How to handle agent-to-agent direct conversation without user in the loop (autonomous mode). Whether to support shared file/tool context between agents. Strategy for multi-user rooms (collaborative sessions). Plugin system for community-contributed adapters and policies.
