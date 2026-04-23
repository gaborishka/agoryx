# Tool Approval Proxy — Design Spec

**Date:** 2026-03-31
**Status:** Draft
**Author:** Claude (Anthropic)

## Problem

When Agoryx agents (Claude Code, Codex CLI) attempt to use tools that require user permission (running shell commands, writing files, network access), the permission requests are lost. In native CLI mode, these tools show interactive prompts. Inside Agoryx, the user sees either an error ("This command requires approval") or a silent denial.

Users need to grant/deny permissions from within Agoryx, just as they would in the native CLI.

## Constraints

- Agoryx only **proxies** permission requests — all "remember", "always allow", and policy logic stays on the CLI side.
- Only **agentic** adapter mode supports this (stdin is connected).
- When multiple agents request approval concurrently, requests are queued (FIFO, one at a time).
- Must work for any future adapter, not just Claude/Codex.

## Protocol Differences

| | Codex (app-server) | Claude Code (stream-json) |
|---|---|---|
| Interactive approval protocol | **Yes** — JSON-RPC server→client requests | **No** — auto-approve or auto-deny based on `--permission-mode` |
| Approval method | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval` | N/A |
| Response mechanism | JSON-RPC response with `decision` field | N/A |
| Fallback strategy | N/A | Detect `permission_denials` in result, retry turn with `--allowedTools` |

This means two distinct flows unified behind one interface:
1. **Codex: Pause-and-wait** — CLI blocks waiting for a JSON-RPC response. Agoryx shows the prompt, user decides, Agoryx sends the response. Instant, no rework.
2. **Claude: Detect-and-retry** — CLI auto-denies, turn completes with `permission_denials`. Agoryx shows what was denied, user approves, Agoryx restarts the turn with `--allowedTools` including the approved tools. Claude redoes its work.

## Concurrency Model

Both flows use **callbacks** (`onApprovalRequest`) that fire from Node.js stream data handlers — NOT from the `sendTurn()` AsyncGenerator.

**Why this works:** The engine's `for await` loop over the generator is an async function that **suspends** between iterations, yielding control to the Node event loop. When the Codex process blocks on an approval request, it stops emitting stdout data, so the generator has nothing to yield. The event loop is free to:
1. Process the approval callback (which was called synchronously from the stdout handler)
2. Re-render the Ink UI with the approval prompt
3. Handle user keyboard input
4. Write the approval response back to the adapter's stdin
5. Codex resumes → generator yields more events → `for await` resumes

For Claude, the turn completes normally (generator exhausts). The engine's post-dispatch phase checks for permission denials, shows approvals to the user, and retries if tools were approved.

**Idle timeout during approval:** When an approval request is emitted, the adapter pauses its idle timeout. When the approval is resolved (or on process crash), the timeout resumes. This prevents the turn from being killed while the user deliberates.

**Process crash cleanup:** If the CLI process crashes while approvals are pending, `handleFatal()` cancels all pending approvals via the queue's `rejectAll()`, clearing the UI.

## 1. Event Types

Add to `EventType` in `internal/events/types.ts`:

```typescript
| "tool.approval.requested"
| "tool.approval.responded"
```

New payload interfaces:

```typescript
export interface ToolApprovalRequestedPayload {
  approvalId: string;              // unique ID for correlation
  agent: string;                   // "codex" | "claude" | ...
  kind: "command" | "file" | "permissions";
  toolName: string;                // "Bash", "Write", etc.
  description: string;             // human-readable summary
  command?: string;                // shell command (if kind=command)
  filePath?: string;               // affected file (if kind=file)
  availableDecisions: string[];    // ["accept", "acceptForSession", "decline"]
  raw: unknown;                    // original CLI payload for passthrough
}

export interface ToolApprovalRespondedPayload {
  approvalId: string;
  decision: string;                // "accept" | "acceptForSession" | "decline" | "cancel"
}
```

## 2. Adapter Interface Changes

In `internal/adapters/adapter.ts`, extend `PersistentAdapter`:

```typescript
export interface ApprovalRequest {
  approvalId: string;
  agent: string;
  kind: "command" | "file" | "permissions";
  toolName: string;
  description: string;
  command?: string;
  filePath?: string;
  availableDecisions: string[];
  raw: unknown;
}

export type ApprovalCallback = (request: ApprovalRequest) => void;
export type ApprovalResponseFn = (approvalId: string, decision: string) => void;

export interface PersistentAdapter extends Adapter {
  sendTurn(input: SendTurnInput): AsyncGenerator<AdapterEvent>;
  destroy?(nativeSessionId: string): Promise<void>;

  // New: approval support
  onApprovalRequest?: ApprovalCallback;
  respondToApproval?: ApprovalResponseFn;
}
```

Adapters that support approval set `onApprovalRequest`. The engine calls `respondToApproval()` with the user's decision.

## 3. Codex Adapter: Interactive Approval

### Current bug in `consumeLine()`

Line 840-843 routes ALL messages with a numeric `id` to `resolvePending()`. But JSON-RPC server→client **requests** also have `id` AND `method`. These must be distinguished:

```typescript
// Before (broken for server requests):
if (typeof parsed.id === "number") {
  this.resolvePending(parsed.id, parsed);
  return;
}

// After:
if (typeof parsed.id === "number" && typeof parsed.method === "string") {
  this.handleServerRequest(parsed.id, parsed.method, parsed.params);
  return;
}
if (typeof parsed.id === "number") {
  this.resolvePending(parsed.id, parsed);
  return;
}
```

### New: `handleServerRequest()`

Handles three approval methods:

```typescript
private handleServerRequest(id: number, method: string, params: unknown): void {
  if (method === "item/commandExecution/requestApproval") {
    this.emitApprovalRequest(id, "command", params);
    return;
  }
  if (method === "item/fileChange/requestApproval") {
    this.emitApprovalRequest(id, "file", params);
    return;
  }
  if (method === "item/permissions/requestApproval") {
    this.emitApprovalRequest(id, "permissions", params);
    return;
  }
  // Unknown server request — send error response
  this.respondToServerRequest(id, { error: { code: -32601, message: "Method not found" } });
}
```

### `emitApprovalRequest()` and `respondToApproval()`

- `emitApprovalRequest()` creates an `ApprovalRequest`, stores the pending JSON-RPC `id`, and calls `this.onApprovalRequest(request)`.
- `respondToApproval(approvalId, decision)` maps the decision to the correct JSON-RPC response format and writes it to stdin.

Pending approvals are stored in a `Map<string, { rpcId: number; method: string }>` to correlate `approvalId` → JSON-RPC response.

The decision mapping for `item/commandExecution/requestApproval`:
- `"accept"` → `{ decision: "accept" }`
- `"acceptForSession"` → `{ decision: "acceptForSession" }`
- `"decline"` → `{ decision: "decline" }`
- `"cancel"` → `{ decision: "cancel" }`

For `item/fileChange/requestApproval` and `item/permissions/requestApproval`: same decision values.

## 4. Claude Adapter: Permission Retry Flow

### Detect `permission_denials`

In the Claude interactive runner's `consumeLine()`, when we receive a `result` event:

```typescript
if (parsed.type === "result") {
  const denials = parsed.permission_denials;
  if (Array.isArray(denials) && denials.length > 0) {
    for (const denial of denials) {
      this.emitApprovalRequest(denial);
    }
  }
  // ... existing result handling
}
```

Each denial becomes an `ApprovalRequest` with `kind` inferred from tool name (Bash → "command", Write/Edit → "file", etc.).

### `respondToApproval()` for Claude

Unlike Codex (which responds inline to a blocked RPC), Claude's flow is:
1. The turn already completed (with denials).
2. User approves tools.
3. Agoryx needs to **retry the turn** with those tools allowed.

`respondToApproval()` in the Claude adapter stores approved tool names in a `Set<string>`. The engine, after collecting all approval responses for a turn, calls a new method:

```typescript
retryWithAllowedTools?(tools: string[]): void;
```

This method adds the tools to the `--allowedTools` list for the next spawn/turn of this adapter. The engine then triggers a retry dispatch.

### Spawn args change

`buildClaudeInteractiveSpawnArgs()` accepts an optional `allowedTools: string[]` parameter:

```typescript
if (allowedTools.length > 0) {
  args.push("--allowedTools", ...allowedTools);
}
```

## 5. Engine: Approval Queue

New class `ApprovalQueue` in `internal/engine/approval-queue.ts`:

```typescript
export class ApprovalQueue {
  private queue: ApprovalQueueItem[] = [];
  private activeItem: ApprovalQueueItem | null = null;
  private onPresent?: (item: ApprovalQueueItem) => void;
  private onClear?: () => void;

  enqueue(request: ApprovalRequest, respond: (decision: string) => void): void;
  respondToActive(decision: string): void;
  setCallbacks(onPresent, onClear): void;
}
```

Flow:
1. Adapter calls `onApprovalRequest` → engine enqueues.
2. If no active item, immediately present to UI via `onPresent`.
3. User responds → engine calls `respond(decision)` on the active item.
4. Dequeue next item and present, or call `onClear` if queue is empty.

### Integration with `DispatchEngine`

`DispatchEngine` gets an `ApprovalQueue` instance. When processing adapter events in `runPersistentDispatch()`, if the adapter has `onApprovalRequest` set, approval requests flow through the queue.

For Claude's retry flow: after all denials from a turn are resolved (user approved some tools), the engine automatically retries the dispatch with `retryWithAllowedTools`.

## 6. UI: Approval Prompt Component

New React component `ApprovalPrompt` in `cmd/agoryx/ink-chat.tsx` (or extracted to its own file):

```
┌─ codex wants to run a command ────────────────────────┐
│                                                        │
│  /bin/zsh -lc 'gh repo view gaborishka/agoryx'        │
│                                                        │
│  [Enter] Accept  [s] Accept for session  [Esc] Deny   │
└────────────────────────────────────────────────────────┘
```

When an approval request is active:
- Normal chat input is disabled.
- The prompt box shows the tool details and available keybindings.
- Pressing Enter → "accept", s → "acceptForSession", Esc → "decline".
- After responding, the prompt disappears and the next queued request shows (or input returns to normal).

For Claude's retry flow, the UI shows:

```
┌─ claude was denied permission ────────────────────────┐
│                                                        │
│  Tool: Write  File: /tmp/test.txt                      │
│  Allow and retry?                                      │
│                                                        │
│  [Enter] Allow & retry  [Esc] Skip                     │
└────────────────────────────────────────────────────────┘
```

## 7. Configuration

In `agoryx.yaml`, per-agent config:

```yaml
agents:
  claude:
    mode: agentic
    permissionMode: default     # passed as --permission-mode
    allowedTools:               # passed as --allowedTools
      - Read
      - Glob
      - Grep
  codex:
    mode: agentic
    approvalPolicy: on-request  # already exists, passed to app-server
```

This lets users pre-approve certain tools without interactive prompts.

## 8. Testing Strategy

| Test | Scope |
|------|-------|
| `tests/engine/approval-queue.test.ts` | Queue FIFO, concurrent enqueue, respond flow |
| `tests/adapters/codex-approval.test.ts` | JSON-RPC server request parsing, response formatting, decision mapping |
| `tests/adapters/claude-approval.test.ts` | permission_denials detection, allowedTools accumulation, retry trigger |
| `tests/engine/approval-integration.test.ts` | End-to-end: adapter emits request → engine queues → respond → adapter receives decision |

## 9. Files Changed

| File | Change |
|------|--------|
| `internal/events/types.ts` | Add event types and payload interfaces |
| `internal/adapters/adapter.ts` | Add `ApprovalRequest`, callbacks to `PersistentAdapter` |
| `internal/adapters/event-factory.ts` | Add `toolApprovalRequested`, `toolApprovalResponded` factories |
| `internal/adapters/codex/index.ts` | Handle server requests, emit approval events, respond via stdin |
| `internal/adapters/claude/index.ts` | Detect permission_denials, support allowedTools, retry mechanism |
| `internal/engine/approval-queue.ts` | **New file** — approval queue |
| `internal/engine/dispatch-engine.ts` | Wire approval queue, handle retry-with-permissions for Claude |
| `cmd/agoryx/ink-chat.tsx` | Add ApprovalPrompt component, wire to engine |
| `internal/config/index.ts` | Add `permissionMode`, `allowedTools` to agent config |
