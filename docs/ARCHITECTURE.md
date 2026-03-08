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
│      (policies: manual, round-robin, auto, team) │
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
  send(input: AgentInput): AsyncGenerator<AdapterEvent>;
  cancel(requestId: string): Promise<void>;
  health(): Promise<AdapterStatus>;
}

// PersistentAdapter extends Adapter for persistent/agentic modes
interface PersistentAdapter extends Adapter {
  sendTurn(input: SendTurnInput): AsyncGenerator<AdapterEvent>;
  destroy?(nativeSessionId: string): Promise<void>;
}

interface AgentInput {
  roomId: string;
  sessionId: string;
  requestId: string;
  messages: Message[];         // conversation history (already context-managed)
  config: AdapterConfig;       // mode, timeout, max tokens, systemPrompt, workspaceCwd
}

interface SendTurnInput {
  roomId: string;
  sessionId: string;
  requestId: string;
  nativeSessionId: string | null;
  prompt: string;
  config: AdapterConfig;
}

type AdapterStatus = "ready" | "busy" | "error" | "not_authenticated";
type AdapterMode = "stub" | "cli" | "persistent" | "agentic";
```

### Initial Adapters

**codex-adapter:** Wraps `codex exec --json` or the `@openai/codex-sdk` Node.js SDK. Parses JSON output events, maps them to internal event types. Handles Codex-specific authentication (ChatGPT plan login).

**claude-adapter:** Wraps `claude -p --output-format stream-json --verbose --include-partial-messages`. Parses streaming JSON events, maps them to internal event types. Uses subscription-based auth (Claude Code login); runs in an isolated working directory to avoid loading workspace instructions.

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
├── orchestrationPolicy: string     // "manual" | "round-robin" | "auto" | "team"
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

Local SQLite database (single file, zero config). Tables: `rooms`, `messages`, `checkpoints`, `pinned_context`, `events_log`, `agent_sessions`, `team_runs`, `team_steps`, `team_feedback_queue`, `team_checks`. The `events_log` table is append-only for debugging and replay.

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

**auto:** Select one best-fit agent per user message using deterministic routing heuristics (intent/keywords). Priority: `@mention` → skill keyword match → round-robin fallback. Goal: reduce noise and token cost versus broadcast while keeping useful autonomy. If no skill matches, the policy falls back to round-robin rotation (per-room, advances only on fallback).

**Out of scope for v0.1:** agent-to-agent autonomous chaining/debate loops. Cross-agent autonomous turns are deferred to a later version behind explicit guardrails (step limits, loop prevention, budget caps).

### v0.2 Team Policy

**team:** Autonomous multi-step runtime with one deterministic round-robin discussion loop toward a goal.

Behavior:

- One active team run per room.
- User messages during an active run are queued as feedback for the next step.
- Run completion is proposal-gated: status becomes `waiting_user_input` and requires explicit user approval.
- Resume after restart is manual (`/team resume`).
- Defaults are intentionally relaxed for enthusiast workflows; stricter guardrails are opt-in.

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
  "eventId": "evt_abc123",
  "roomId": "room_001",
  "sessionId": "sess_001",
  "timestamp": "2026-02-16T12:00:00Z",
  "source": "adapter.codex",
  "type": "message.delta",
  "requestId": "req_789",
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
| `session.bound` | Adapter bound a native CLI session ID (persistent/agentic modes) |

### Message Payload

```json
{
  "messageId": "msg_001",
  "author": "agent.codex",
  "role": "assistant",
  "text": "Here is my suggestion...",
  "format": "markdown",
  "metadata": {
    "provider": "openai",
    "model": "codex",
    "tokenUsage": { "input": 1200, "output": 450 },
    "latencyMs": 3200
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
| `SESSION_EXPIRED` | Native CLI session expired during persistent/agentic mode | One-shot cold retry; create new session |
| `UNKNOWN` | Unclassified failure | Log everything, emit error event |

### Handling Rules

Mark only the affected dispatch as failed. Emit `message.error` with typed class and raw stderr excerpt. Keep the room active — continue with remaining agents. Offer a retry command at the orchestration level (`/retry`).

---

## Configuration

### Config File

```json
{
  "defaultMode": "free",
  "agents": {
    "codex": {
      "mode": "cli",
      "systemPrompt": "You are a collaborative participant in a group discussion.",
      "skills": ["code", "debug", "test"]
    },
    "claude": {
      "mode": "cli",
      "systemPrompt": "You are a collaborative participant in a group discussion.",
      "skills": ["architecture", "review", "explain"]
    }
  },
  "context": {
    "maxHistoryMessages": 100,
    "checkpointThreshold": 50,
    "maxContextTokens": 30000
  },
  "session": {
    "dbPath": "/absolute/path/to/agoryx.db"
  },
  "team": {
    "maxSteps": 24,
    "maxNoProgressSteps": 8,
    "maxDurationMs": 3600000,
    "checksEnabledByDefault": false,
    "checkCommands": ["npm run typecheck", "npm test"],
    "strict": {
      "maxSteps": 8,
      "maxNoProgressSteps": 2,
      "maxDurationMs": 900000,
      "checksEnabledByDefault": true
    },
    "singleActive": true,
    "trigger": {
      "autoOnMessage": true,
      "commandStart": true
    }
  }
}
```

Resolution order:
1. CLI flags
2. Environment variables
3. Config file
4. Built-in defaults

Default config path: `$XDG_CONFIG_HOME/agoryx/config.json`
Legacy auto-detected path: `./agoryx.json`
Default DB path: `$XDG_STATE_HOME/agoryx/agoryx.db`

### CLI Commands

```bash
# Root metadata
agoryx --help
agoryx --version

# Start a chat session
agoryx                      # free mode (default)
agoryx --mode manual          # you pick who responds with @agent
agoryx --mode free            # open-ended multi-agent collaboration
agoryx --mode round-robin     # agents alternate
agoryx --mode auto            # smart routing
agoryx --mode team            # autonomous team runtime

# Adapter transport
agoryx --adapter-mode cli       # default
agoryx --adapter-mode agentic   # persistent + workspace-aware cwd

# Resume a previous session
agoryx --resume <session_id>

# Custom config file
agoryx --config ./my-config.json

# List past sessions
agoryx sessions list

# Export a session
agoryx sessions export <room_or_session_id> --format markdown --out ./export.md

# Config resolution diagnostics
agoryx config explain

# Shell completion script output
agoryx completion bash
agoryx completion zsh
agoryx completion fish

# Manual page output
agoryx man
```

### In-Chat Commands

```
@codex <message>                               # direct message to codex
@claude <message>                              # direct message to claude
@all <message>                                 # broadcast to all agents
/mode <manual|round-robin|auto|team|free>      # switch orchestration mode
/adapter <agent> <stub|cli|persistent|agentic> # switch adapter mode per agent
/team start <goal> [--strict] [--no-checks]   # start autonomous team run
/team status                                   # show active run status
/team log [limit]                              # show recent team steps/checks
/team resume                                   # resume latest team run
/team approve [run_id]                         # approve proposal and mark done
/team interrupt [feedback]                     # interrupt active team step and queue correction
/team stop                                     # stop active team run
/pin [label] <content>                         # pin persistent context
/unpin <id>                                    # remove pinned context
/pins                                          # list all pinned contexts
/summary                                       # create checkpoint summary
/checkpoint                                    # alias for /summary
/history                                       # show conversation history
/export [markdown|json] [--out file]           # export session
/retry                                         # retry last failed agent request
/help                                          # show available commands
/quit or /exit                                 # end session
Esc (TTY, team mode)                           # interrupt active team step
```

---

## Project Layout

```
agoryx/
├── cmd/
│   └── agoryx/              # CLI entrypoints
│       ├── main.ts          # chat + sessions commands
│       └── session-export.ts # export rendering helpers
├── internal/
│   ├── adapters/
│   │   ├── adapter.ts       # interface definition (Adapter, PersistentAdapter)
│   │   ├── codex/           # codex CLI adapter
│   │   ├── claude/          # claude CLI adapter
│   │   ├── event-factory.ts
│   │   ├── parse-output.ts
│   │   └── registry.ts
│   ├── config/
│   │   ├── index.ts         # loader, mergeConfig, toRuntimeConfig
│   │   └── default.ts       # ChatRuntimeConfig type and defaults
│   ├── engine/
│   │   ├── chat.ts          # public engine facade
│   │   ├── dispatch-engine.ts
│   │   ├── team-orchestrator.ts
│   │   ├── lifecycle.ts
│   │   ├── logger.ts
│   │   └── types.ts
│   ├── events/
│   │   └── types.ts         # event envelope, payload types
│   ├── orchestrator/
│   │   ├── index.ts         # Orchestrator class
│   │   ├── manual.ts
│   │   ├── round-robin.ts
│   │   ├── auto.ts
│   │   ├── team.ts
│   │   └── factory.ts
│   ├── session/
│   │   ├── context.ts       # context builder algorithm
│   │   ├── service.ts       # SessionService (room, messages, checkpoints, team)
│   │   └── ids.ts
│   └── storage/
│       └── sqlite.ts        # SQLite persistence (better-sqlite3)
├── docs/
│   ├── VISION.md
│   ├── ARCHITECTURE.md
│   ├── CONSENSUS.md
│   └── plans/              # design docs for past and in-progress features
├── tests/
│   ├── adapters/           # adapter contract tests, parser tests
│   ├── cmd/                # CLI integration tests
│   ├── config/             # config merge/load tests
│   ├── engine/             # chat engine and team runtime tests
│   ├── orchestrator/       # policy logic tests
│   ├── session/            # context builder, checkpoint, summary tests
│   └── storage/            # SQLite store tests
├── package.json
├── tsconfig.json
└── README.md
```

---

## Test Strategy

**Unit tests:** Event normalization for each adapter. Policy decisions for manual, round-robin, auto, and team. Session context builder and checkpoint selection. Error classification and handling.

**Contract tests:** Each adapter has a test suite that verifies: it produces valid internal events from sample CLI output; it handles error cases (timeout, crash, malformed output); it reports correct health status.

**Integration tests:** Mock adapter streams with partial responses, errors, and cancellation. End-to-end room lifecycle: create → chat → checkpoint → resume. Replay test that rebuilds room state from the event log.

---

## Evolution Path

Keep transport adapters replaceable — adding Gemini CLI or Ollama should require only a new adapter, no core changes. Add daemon mode only when CLI-first flow is stable. Keep API-sourced adapters (direct HTTP to provider APIs) optional and separate from subscription-backed CLI adapters. Consider MCP (Model Context Protocol) as a future transport option for richer agent interaction.

---

## Open Technical Questions for v0.3+

Whether to support shared file/tool context between agents. Strategy for multi-user rooms (collaborative sessions). Plugin system for community-contributed adapters and policies. Web UI architecture for daemon-backed sessions.
