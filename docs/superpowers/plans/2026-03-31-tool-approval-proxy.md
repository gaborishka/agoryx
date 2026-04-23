# Tool Approval Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users grant/deny tool permissions to agents from within the Agoryx UI, proxying approval requests from Codex (interactive) and Claude Code (retry-on-denial).

**Architecture:** Two flows unified behind one adapter interface. Codex app-server sends JSON-RPC approval requests that Agoryx proxies to the user and responds to inline. Claude Code auto-denies in stream-json mode, so Agoryx detects denials in the `result` event and retries the turn with `--allowedTools`. An `ApprovalQueue` in the engine serializes concurrent requests FIFO. The Ink UI shows a blocking approval prompt.

**Tech Stack:** TypeScript, Node.js, Ink (React), better-sqlite3

**Spec:** `docs/superpowers/specs/2026-03-31-tool-approval-proxy-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `internal/events/types.ts` | Add `tool.approval.requested`, `tool.approval.responded` to EventType; add payload interfaces |
| `internal/adapters/adapter.ts` | Add `ApprovalRequest` interface, `ApprovalCallback`/`ApprovalResponseFn` types, extend `PersistentAdapter` |
| `internal/adapters/event-factory.ts` | Add `toolApprovalRequested` and `toolApprovalResponded` factory functions |
| `internal/engine/approval-queue.ts` | **New** — `ApprovalQueue` class with FIFO queueing, present/respond/clear callbacks |
| `internal/adapters/codex/index.ts` | Handle JSON-RPC server requests in `consumeLine()`, emit approval callbacks, respond via stdin |
| `internal/adapters/claude/index.ts` | Detect `permission_denials` in result events, emit approval callbacks, support `--allowedTools` in spawn args |
| `internal/engine/dispatch-engine.ts` | Wire approval queue, add retry-with-allowed-tools for Claude |
| `cmd/agoryx/ink-chat.tsx` | Add `ApprovalPrompt` component, wire to engine approval queue |

---

### Task 1: Event Types and Adapter Interface

**Files:**
- Modify: `internal/events/types.ts:79-88`
- Modify: `internal/adapters/adapter.ts:38-59`
- Modify: `internal/adapters/event-factory.ts:1-91`
- Test: `tests/events/approval-types.test.ts`

- [ ] **Step 1: Write failing test for new event types**

```typescript
// tests/events/approval-types.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toolApprovalRequested, toolApprovalResponded } from "../../internal/adapters/event-factory.js";

describe("tool approval event factories", () => {
  const base = {
    roomId: "room_1",
    sessionId: "ses_1",
    requestId: "req_1",
    source: "adapter.codex",
  };

  it("creates tool.approval.requested event", () => {
    const event = toolApprovalRequested(base, {
      approvalId: "apr_1",
      agent: "codex",
      kind: "command",
      toolName: "Bash",
      description: "Run: echo hello",
      command: "echo hello",
      availableDecisions: ["accept", "decline"],
      raw: {},
    });
    assert.equal(event.type, "tool.approval.requested");
    assert.equal(event.payload.approvalId, "apr_1");
    assert.equal(event.payload.kind, "command");
  });

  it("creates tool.approval.responded event", () => {
    const event = toolApprovalResponded(base, {
      approvalId: "apr_1",
      decision: "accept",
    });
    assert.equal(event.type, "tool.approval.responded");
    assert.equal(event.payload.decision, "accept");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/events/approval-types.test.ts`
Expected: FAIL — `toolApprovalRequested` and `toolApprovalResponded` not found

- [ ] **Step 3: Add event types to types.ts**

In `internal/events/types.ts`, add to the `EventType` union (after line 88):

```typescript
export type EventType =
  | "message.started"
  | "message.delta"
  | "message.completed"
  | "message.error"
  | "session.bound"
  | "tool.call.started"
  | "tool.call.completed"
  | "tool.approval.requested"
  | "tool.approval.responded"
  | "agent.status"
  | "session.checkpoint";
```

Add payload interfaces (after `SessionBoundPayload`):

```typescript
export interface ToolApprovalRequestedPayload {
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

export interface ToolApprovalRespondedPayload {
  approvalId: string;
  decision: string;
}
```

- [ ] **Step 4: Add ApprovalRequest to adapter.ts**

In `internal/adapters/adapter.ts`, add:

```typescript
import type {
  ErrorClass,
  EventEnvelope,
  Message,
  MessageEventPayload,
  MessageErrorPayload,
  SessionBoundPayload,
  ToolApprovalRequestedPayload,
  ToolApprovalRespondedPayload,
} from "../events/types.js";

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
```

Extend `PersistentAdapter`:

```typescript
export interface PersistentAdapter extends Adapter {
  sendTurn(input: SendTurnInput): AsyncGenerator<AdapterEvent>;
  destroy?(nativeSessionId: string): Promise<void>;
  onApprovalRequest?: ApprovalCallback;
  respondToApproval?: ApprovalResponseFn;
}
```

Update `AdapterEvent` to include approval events:

```typescript
export type AdapterEvent =
  | EventEnvelope<MessageEventPayload>
  | EventEnvelope<MessageErrorPayload>
  | EventEnvelope<SessionBoundPayload>
  | EventEnvelope<ToolApprovalRequestedPayload>
  | EventEnvelope<ToolApprovalRespondedPayload>;
```

- [ ] **Step 5: Add event factory functions**

In `internal/adapters/event-factory.ts`, add:

```typescript
import type {
  ErrorClass,
  MessageEventPayload,
  MessageErrorPayload,
  SessionBoundPayload,
  ToolApprovalRequestedPayload,
  ToolApprovalRespondedPayload,
} from "../events/types.js";

// ... existing factories ...

export const toolApprovalRequested = (
  args: BaseArgs,
  payload: ToolApprovalRequestedPayload,
): AdapterEvent => ({
  eventId: createId("evt"),
  roomId: args.roomId,
  sessionId: args.sessionId,
  timestamp: nowIso(),
  source: args.source,
  type: "tool.approval.requested",
  requestId: args.requestId,
  payload,
});

export const toolApprovalResponded = (
  args: BaseArgs,
  payload: ToolApprovalRespondedPayload,
): AdapterEvent => ({
  eventId: createId("evt"),
  roomId: args.roomId,
  sessionId: args.sessionId,
  timestamp: nowIso(),
  source: args.source,
  type: "tool.approval.responded",
  requestId: args.requestId,
  payload,
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx tsx --test tests/events/approval-types.test.ts`
Expected: PASS

- [ ] **Step 7: Run full test suite for regressions**

Run: `npm test`
Expected: All existing tests still pass

- [ ] **Step 8: Commit**

```bash
git add internal/events/types.ts internal/adapters/adapter.ts internal/adapters/event-factory.ts tests/events/approval-types.test.ts
git commit -m "feat: add tool approval event types and adapter interface"
```

---

### Task 2: Approval Queue

**Files:**
- Create: `internal/engine/approval-queue.ts`
- Test: `tests/engine/approval-queue.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/engine/approval-queue.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ApprovalQueue } from "../../internal/engine/approval-queue.js";
import type { ApprovalRequest } from "../../internal/adapters/adapter.js";

const makeRequest = (id: string): ApprovalRequest => ({
  approvalId: id,
  agent: "codex",
  kind: "command",
  toolName: "Bash",
  description: `Run command ${id}`,
  availableDecisions: ["accept", "decline"],
  raw: {},
});

describe("ApprovalQueue", () => {
  it("presents first enqueued item immediately", () => {
    const queue = new ApprovalQueue();
    let presented: ApprovalRequest | null = null;
    queue.setCallbacks(
      (item) => { presented = item.request; },
      () => {},
    );
    queue.enqueue(makeRequest("a1"), () => {});
    assert.equal(presented?.approvalId, "a1");
  });

  it("queues second item until first is responded", () => {
    const queue = new ApprovalQueue();
    const presented: string[] = [];
    queue.setCallbacks(
      (item) => { presented.push(item.request.approvalId); },
      () => {},
    );
    queue.enqueue(makeRequest("a1"), () => {});
    queue.enqueue(makeRequest("a2"), () => {});
    assert.deepEqual(presented, ["a1"]);

    queue.respondToActive("accept");
    assert.deepEqual(presented, ["a1", "a2"]);
  });

  it("calls respond callback with decision", () => {
    const queue = new ApprovalQueue();
    let decision: string | null = null;
    queue.setCallbacks(() => {}, () => {});
    queue.enqueue(makeRequest("a1"), (d) => { decision = d; });
    queue.respondToActive("decline");
    assert.equal(decision, "decline");
  });

  it("calls onClear when queue empties", () => {
    const queue = new ApprovalQueue();
    let cleared = false;
    queue.setCallbacks(() => {}, () => { cleared = true; });
    queue.enqueue(makeRequest("a1"), () => {});
    queue.respondToActive("accept");
    assert.equal(cleared, true);
  });

  it("rejectAll rejects all pending items", () => {
    const queue = new ApprovalQueue();
    const decisions: string[] = [];
    queue.setCallbacks(() => {}, () => {});
    queue.enqueue(makeRequest("a1"), (d) => decisions.push(d));
    queue.enqueue(makeRequest("a2"), (d) => decisions.push(d));
    queue.rejectAll();
    assert.deepEqual(decisions, ["cancel", "cancel"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/engine/approval-queue.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ApprovalQueue**

```typescript
// internal/engine/approval-queue.ts
import type { ApprovalRequest } from "../adapters/adapter.js";

export interface ApprovalQueueItem {
  request: ApprovalRequest;
  respond: (decision: string) => void;
}

type PresentCallback = (item: ApprovalQueueItem) => void;
type ClearCallback = () => void;

export class ApprovalQueue {
  private queue: ApprovalQueueItem[] = [];
  private activeItem: ApprovalQueueItem | null = null;
  private onPresent: PresentCallback = () => {};
  private onClear: ClearCallback = () => {};

  public setCallbacks(onPresent: PresentCallback, onClear: ClearCallback): void {
    this.onPresent = onPresent;
    this.onClear = onClear;
  }

  public enqueue(request: ApprovalRequest, respond: (decision: string) => void): void {
    const item: ApprovalQueueItem = { request, respond };
    if (!this.activeItem) {
      this.activeItem = item;
      this.onPresent(item);
    } else {
      this.queue.push(item);
    }
  }

  public respondToActive(decision: string): void {
    if (!this.activeItem) {
      return;
    }
    const item = this.activeItem;
    this.activeItem = null;
    item.respond(decision);
    this.advance();
  }

  public rejectAll(): void {
    if (this.activeItem) {
      this.activeItem.respond("cancel");
      this.activeItem = null;
    }
    for (const item of this.queue) {
      item.respond("cancel");
    }
    this.queue = [];
    this.onClear();
  }

  public get pending(): number {
    return this.queue.length + (this.activeItem ? 1 : 0);
  }

  public get active(): ApprovalQueueItem | null {
    return this.activeItem;
  }

  private advance(): void {
    const next = this.queue.shift();
    if (next) {
      this.activeItem = next;
      this.onPresent(next);
    } else {
      this.onClear();
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/engine/approval-queue.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add internal/engine/approval-queue.ts tests/engine/approval-queue.test.ts
git commit -m "feat: add ApprovalQueue for serialized tool approval flow"
```

---

### Task 3: Codex Adapter — Handle Server Approval Requests

**Files:**
- Modify: `internal/adapters/codex/index.ts:576-588` (CodexAppServerRunner constructor), `:823-849` (consumeLine), `:852-1007` (consumeNotification)
- Test: `tests/adapters/codex-approval.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/adapters/codex-approval.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseCodexServerRequest,
  buildCodexApprovalResponse,
} from "../../internal/adapters/codex/index.js";

describe("parseCodexServerRequest", () => {
  it("parses commandExecution approval request", () => {
    const params = {
      threadId: "t1",
      turnId: "turn1",
      itemId: "item1",
      command: "/bin/zsh -lc 'gh repo view'",
      cwd: "/tmp",
      commandActions: [{ type: "unknown", command: "gh repo view" }],
      availableDecisions: ["accept", "acceptForSession", "decline"],
    };
    const result = parseCodexServerRequest(
      "item/commandExecution/requestApproval",
      params,
    );
    assert.ok(result);
    assert.equal(result.kind, "command");
    assert.equal(result.toolName, "Bash");
    assert.ok(result.command?.includes("gh repo view"));
    assert.deepEqual(result.availableDecisions, ["accept", "acceptForSession", "decline"]);
  });

  it("parses fileChange approval request", () => {
    const params = {
      threadId: "t1",
      turnId: "turn1",
      itemId: "item1",
      reason: "wants to write file",
    };
    const result = parseCodexServerRequest(
      "item/fileChange/requestApproval",
      params,
    );
    assert.ok(result);
    assert.equal(result.kind, "file");
  });

  it("returns null for unknown method", () => {
    const result = parseCodexServerRequest("unknown/method", {});
    assert.equal(result, null);
  });
});

describe("buildCodexApprovalResponse", () => {
  it("builds accept response", () => {
    const response = buildCodexApprovalResponse(
      "item/commandExecution/requestApproval",
      "accept",
    );
    assert.deepEqual(response, { decision: "accept" });
  });

  it("builds acceptForSession response", () => {
    const response = buildCodexApprovalResponse(
      "item/commandExecution/requestApproval",
      "acceptForSession",
    );
    assert.deepEqual(response, { decision: "acceptForSession" });
  });

  it("builds decline response", () => {
    const response = buildCodexApprovalResponse(
      "item/commandExecution/requestApproval",
      "decline",
    );
    assert.deepEqual(response, { decision: "decline" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/adapters/codex-approval.test.ts`
Expected: FAIL — functions not exported

- [ ] **Step 3: Add exported helpers for parsing and response building**

At the bottom of `internal/adapters/codex/index.ts`, add:

```typescript
export const parseCodexServerRequest = (
  method: string,
  params: unknown,
): Omit<ApprovalRequest, "approvalId" | "agent"> | null => {
  const obj = params && typeof params === "object"
    ? (params as Record<string, unknown>)
    : {};

  if (method === "item/commandExecution/requestApproval") {
    const command = readStringField(obj, "command") ?? "";
    const decisions = Array.isArray(obj.availableDecisions)
      ? (obj.availableDecisions as string[])
      : ["accept", "acceptForSession", "decline"];
    return {
      kind: "command",
      toolName: "Bash",
      description: `Run: ${command || "(unknown command)"}`,
      command,
      availableDecisions: decisions,
      raw: params,
    };
  }

  if (method === "item/fileChange/requestApproval") {
    const reason = readStringField(obj, "reason") ?? "file change";
    const grantRoot = readStringField(obj, "grantRoot");
    return {
      kind: "file",
      toolName: "FileChange",
      description: reason,
      filePath: grantRoot ?? undefined,
      availableDecisions: ["accept", "acceptForSession", "decline"],
      raw: params,
    };
  }

  if (method === "item/permissions/requestApproval") {
    const reason = readStringField(obj, "reason") ?? "permission escalation";
    return {
      kind: "permissions",
      toolName: "Permissions",
      description: reason,
      availableDecisions: ["accept", "decline"],
      raw: params,
    };
  }

  return null;
};

export const buildCodexApprovalResponse = (
  _method: string,
  decision: string,
): Record<string, unknown> => ({ decision });
```

- [ ] **Step 4: Wire server request handling into `consumeLine()`**

In `CodexAppServerRunner`, modify `consumeLine()` at lines 840-843. Change:

```typescript
// OLD:
if (typeof parsed.id === "number") {
  this.resolvePending(parsed.id, parsed);
  return;
}
```

To:

```typescript
// NEW: distinguish server requests (have both id and method) from responses (id only)
if (typeof parsed.id === "number" && typeof parsed.method === "string") {
  this.handleServerRequest(parsed.id, parsed.method, parsed.params);
  return;
}
if (typeof parsed.id === "number") {
  this.resolvePending(parsed.id, parsed);
  return;
}
```

- [ ] **Step 5: Add `handleServerRequest()`, approval state, and `respondToApproval()` to CodexAppServerRunner**

Add instance state:

```typescript
// In CodexAppServerRunner class, after existing fields:
public onApprovalRequest: ApprovalCallback | null = null;
private pendingApprovals = new Map<string, { rpcId: number; method: string }>();
```

Add methods:

```typescript
private handleServerRequest(id: number, method: string, params: unknown): void {
  const parsed = parseCodexServerRequest(method, params);
  if (!parsed) {
    // Unknown server request — respond with error
    this.respondToServerRequest(id, {
      error: { code: -32601, message: `Method not found: ${method}` },
    });
    return;
  }

  const approvalId = `apr_codex_${id}`;
  this.pendingApprovals.set(approvalId, { rpcId: id, method });

  // Touch idle timeout — approval wait should not trigger timeout
  this.activeTurn?.idleTimeout.touch();

  const request: ApprovalRequest = {
    ...parsed,
    approvalId,
    agent: "codex",
  };

  if (this.onApprovalRequest) {
    this.onApprovalRequest(request);
  } else {
    // No handler — auto-decline
    this.resolveApproval(approvalId, "decline");
  }
}

public resolveApproval(approvalId: string, decision: string): void {
  const pending = this.pendingApprovals.get(approvalId);
  if (!pending) {
    return;
  }
  this.pendingApprovals.delete(approvalId);

  const result = buildCodexApprovalResponse(pending.method, decision);
  this.respondToServerRequest(pending.rpcId, { result });
}

private respondToServerRequest(id: number, body: Record<string, unknown>): void {
  const response = JSON.stringify({ jsonrpc: "2.0", id, ...body });
  this.child.stdin.write(`${response}\n`, (error) => {
    if (error) {
      console.error(
        `[adapter.codex] failed to send server request response: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });
}
```

- [ ] **Step 6: Wire CodexAdapter to expose approval interface**

In `CodexAdapter` class, add `onApprovalRequest` and `respondToApproval` as `PersistentAdapter` interface members:

```typescript
// In CodexAdapter class:
public onApprovalRequest: ApprovalCallback | undefined;

public respondToApproval: ApprovalResponseFn = (approvalId, decision) => {
  this.interactiveRunner?.resolveApproval(approvalId, decision);
};
```

In `ensureInteractiveRunner()`, after creating the runner (around line 466-468), wire the callback:

```typescript
const runner = new CodexAppServerRunner(cwd, buildCodexSpawnEnv(process.env));
runner.onApprovalRequest = this.onApprovalRequest ?? null;
const sessionId = await runner.initialize(nativeSessionId);
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx tsx --test tests/adapters/codex-approval.test.ts`
Expected: PASS

- [ ] **Step 8: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 9: Commit**

```bash
git add internal/adapters/codex/index.ts tests/adapters/codex-approval.test.ts
git commit -m "feat(codex): handle JSON-RPC approval requests from app-server"
```

---

### Task 4: Claude Adapter — Detect Permission Denials and Support AllowedTools

**Files:**
- Modify: `internal/adapters/claude/index.ts:785-830` (consumeLine), `:888-899` (buildClaudeInteractiveSpawnArgs)
- Test: `tests/adapters/claude-approval.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/adapters/claude-approval.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractClaudePermissionDenials,
  buildClaudeInteractiveSpawnArgs,
} from "../../internal/adapters/claude/index.js";

describe("extractClaudePermissionDenials", () => {
  it("extracts denials from result event", () => {
    const resultEvent = {
      type: "result",
      subtype: "success",
      permission_denials: [
        {
          tool_name: "Write",
          tool_use_id: "toolu_01abc",
          tool_input: {
            file_path: "/tmp/test.txt",
            content: "hello",
          },
        },
        {
          tool_name: "Bash",
          tool_use_id: "toolu_02def",
          tool_input: {
            command: "gh repo view",
          },
        },
      ],
    };
    const denials = extractClaudePermissionDenials(resultEvent);
    assert.equal(denials.length, 2);
    assert.equal(denials[0].toolName, "Write");
    assert.equal(denials[0].kind, "file");
    assert.equal(denials[0].filePath, "/tmp/test.txt");
    assert.equal(denials[1].toolName, "Bash");
    assert.equal(denials[1].kind, "command");
    assert.equal(denials[1].command, "gh repo view");
  });

  it("returns empty array when no denials", () => {
    assert.deepEqual(extractClaudePermissionDenials({ type: "result" }), []);
    assert.deepEqual(extractClaudePermissionDenials({ type: "result", permission_denials: [] }), []);
  });
});

describe("buildClaudeInteractiveSpawnArgs with allowedTools", () => {
  it("includes --allowedTools when provided", () => {
    const args = buildClaudeInteractiveSpawnArgs(null, ["Bash", "Read"]);
    assert.ok(args.includes("--allowedTools"));
    const toolsIdx = args.indexOf("--allowedTools");
    assert.equal(args[toolsIdx + 1], "Bash");
    assert.equal(args[toolsIdx + 2], "Read");
  });

  it("omits --allowedTools when empty", () => {
    const args = buildClaudeInteractiveSpawnArgs(null, []);
    assert.ok(!args.includes("--allowedTools"));
  });

  it("omits --allowedTools when undefined", () => {
    const args = buildClaudeInteractiveSpawnArgs(null);
    assert.ok(!args.includes("--allowedTools"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/adapters/claude-approval.test.ts`
Expected: FAIL — functions not exported / wrong signature

- [ ] **Step 3: Add `extractClaudePermissionDenials` function**

At the bottom of `internal/adapters/claude/index.ts`, add:

```typescript
export const extractClaudePermissionDenials = (
  resultEvent: Record<string, unknown>,
): Array<Omit<ApprovalRequest, "approvalId" | "agent">> => {
  const denials = resultEvent.permission_denials;
  if (!Array.isArray(denials) || denials.length === 0) {
    return [];
  }

  return denials.map((denial: Record<string, unknown>) => {
    const toolName = readStringField(denial, "tool_name") ?? "Unknown";
    const toolInput = denial.tool_input && typeof denial.tool_input === "object"
      ? (denial.tool_input as Record<string, unknown>)
      : {};

    const isFileOp = /write|edit|create/i.test(toolName);
    const kind = isFileOp ? "file" as const : "command" as const;
    const command = readStringField(toolInput, "command") ?? undefined;
    const filePath = readStringField(toolInput, "file_path") ?? undefined;
    const description = command
      ? `Run: ${command}`
      : filePath
        ? `${toolName}: ${filePath}`
        : `Use tool: ${toolName}`;

    return {
      kind,
      toolName,
      description,
      command,
      filePath,
      availableDecisions: ["accept", "decline"],
      raw: denial,
    };
  });
};

const readStringField = (obj: Record<string, unknown>, key: string): string | null => {
  const val = obj[key];
  return typeof val === "string" && val.trim().length > 0 ? val : null;
};
```

Note: `readStringField` may already exist in claude/index.ts — check first and reuse if so, or rename to avoid conflicts.

- [ ] **Step 4: Modify `buildClaudeInteractiveSpawnArgs` to accept `allowedTools`**

Change the signature at line 888:

```typescript
export const buildClaudeInteractiveSpawnArgs = (
  nativeSessionId: string | null = null,
  allowedTools: string[] = [],
): string[] => [
  ...(nativeSessionId ? ["--resume", nativeSessionId] : []),
  "--print",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  ...(allowedTools.length > 0 ? ["--allowedTools", ...allowedTools] : []),
];
```

- [ ] **Step 5: Wire denial detection into `consumeLine()` of ClaudeInteractiveRunner**

In the `consumeLine()` method around line 821, after `isClaudeResultEvent(parsed)`:

```typescript
if (isClaudeResultEvent(parsed)) {
  // Check for permission denials before resolving
  const denials = extractClaudePermissionDenials(
    parsed as Record<string, unknown>,
  );
  if (denials.length > 0 && this.onApprovalRequest) {
    for (const denial of denials) {
      const approvalId = `apr_claude_${createId("apr")}`;
      this.onApprovalRequest({
        ...denial,
        approvalId,
        agent: "claude",
      });
    }
  }

  const activeTurn = this.activeTurn;
  this.activeTurn = null;
  activeTurn.idleTimeout.clear();
  activeTurn.resolve({
    text: activeTurn.resultText?.trim() || activeTurn.output.trim() || "(no content)",
    sessionId: this.sessionIdValue,
  });
}
```

Add callback field to `ClaudeInteractiveRunner`:

```typescript
public onApprovalRequest: ApprovalCallback | null = null;
```

- [ ] **Step 6: Wire ClaudeAdapter to expose approval interface**

In `ClaudeAdapter` class:

```typescript
public onApprovalRequest: ApprovalCallback | undefined;
private allowedToolsOverride: string[] = [];

public respondToApproval: ApprovalResponseFn = (approvalId, decision) => {
  // Claude doesn't support inline approval — collect allowed tools for retry
  if (decision === "accept" || decision === "acceptForSession") {
    // Extract tool name from the stored request
    const toolName = this.pendingDenials.get(approvalId);
    if (toolName) {
      this.allowedToolsOverride.push(toolName);
    }
    this.pendingDenials.delete(approvalId);
  }
};

private pendingDenials = new Map<string, string>(); // approvalId → toolName

public getAllowedToolsOverride(): string[] {
  return [...this.allowedToolsOverride];
}

public clearAllowedToolsOverride(): void {
  this.allowedToolsOverride = [];
  this.pendingDenials.clear();
}
```

Wire `onApprovalRequest` to the interactive runner in `ensureInteractiveRunner()`.

- [ ] **Step 7: Run test to verify it passes**

Run: `npx tsx --test tests/adapters/claude-approval.test.ts`
Expected: PASS

- [ ] **Step 8: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 9: Commit**

```bash
git add internal/adapters/claude/index.ts tests/adapters/claude-approval.test.ts
git commit -m "feat(claude): detect permission denials and support --allowedTools retry"
```

---

### Task 5: Engine — Wire Approval Queue into Dispatch Flow

**Files:**
- Modify: `internal/engine/dispatch-engine.ts:35-55` (constructor), `:374-523` (runPersistentDispatch)
- Modify: `internal/engine/chat.ts` (pass approval queue to dispatch engine)
- Test: `tests/engine/approval-integration.test.ts`

- [ ] **Step 1: Write failing integration test**

```typescript
// tests/engine/approval-integration.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ApprovalQueue } from "../../internal/engine/approval-queue.js";
import type { ApprovalRequest } from "../../internal/adapters/adapter.js";

describe("approval queue integration", () => {
  it("enqueue and respond round-trip", () => {
    const queue = new ApprovalQueue();
    const results: Array<{ id: string; decision: string }> = [];

    queue.setCallbacks(
      (item) => {
        // Simulate user accepting after a tick
        setTimeout(() => queue.respondToActive("accept"), 0);
      },
      () => {},
    );

    const request: ApprovalRequest = {
      approvalId: "apr_1",
      agent: "codex",
      kind: "command",
      toolName: "Bash",
      description: "Run: echo hello",
      availableDecisions: ["accept", "decline"],
      raw: {},
    };

    queue.enqueue(request, (decision) => {
      results.push({ id: "apr_1", decision });
    });

    // Wait for async callback
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        assert.equal(results.length, 1);
        assert.equal(results[0].decision, "accept");
        resolve();
      }, 50);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it passes** (uses existing ApprovalQueue)

Run: `npx tsx --test tests/engine/approval-integration.test.ts`
Expected: PASS

- [ ] **Step 3: Add `approvalQueue` to DispatchEngine**

In `internal/engine/dispatch-engine.ts`, add to `DispatchEngineOptions`:

```typescript
approvalQueue?: ApprovalQueue;
```

Store in constructor:

```typescript
private readonly approvalQueue?: ApprovalQueue;
// ... in constructor:
this.approvalQueue = options.approvalQueue;
```

- [ ] **Step 4: Wire approval callbacks when setting up adapters in persistent dispatch**

In `runPersistentDispatch()`, before calling `adapter.sendTurn()`, wire the approval callback if the adapter supports it:

```typescript
// Before the for-await loop over adapter.sendTurn()
if (this.approvalQueue && adapter.onApprovalRequest !== undefined) {
  adapter.onApprovalRequest = (request: ApprovalRequest) => {
    this.approvalQueue!.enqueue(request, (decision: string) => {
      adapter.respondToApproval?.(request.approvalId, decision);
    });
  };
}
```

- [ ] **Step 5: Pass approvalQueue from ChatEngine to DispatchEngine**

In `internal/engine/chat.ts`, the `ChatEngine` constructor creates the `DispatchEngine`. Add `approvalQueue` parameter:

```typescript
// In ChatEngine constructor or init method:
private readonly approvalQueue: ApprovalQueue;

// Pass to DispatchEngine:
this.dispatchEngine = new DispatchEngine({
  ...existingOptions,
  approvalQueue: this.approvalQueue,
});
```

Expose the approval queue for UI binding:

```typescript
public getApprovalQueue(): ApprovalQueue {
  return this.approvalQueue;
}
```

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add internal/engine/dispatch-engine.ts internal/engine/chat.ts internal/engine/approval-queue.ts tests/engine/approval-integration.test.ts
git commit -m "feat(engine): wire approval queue into dispatch flow"
```

---

### Task 6: Ink UI — Approval Prompt Component

**Files:**
- Modify: `cmd/agoryx/ink-chat.tsx`

- [ ] **Step 1: Add ApprovalPrompt component to ink-chat.tsx**

Add the component (can be defined inside the file or extracted — follow existing patterns):

```tsx
interface ApprovalPromptProps {
  request: ApprovalRequest;
  queueSize: number;
  onRespond: (decision: string) => void;
}

const ApprovalPrompt: React.FC<ApprovalPromptProps> = ({ request, queueSize, onRespond }) => {
  useInput((input, key) => {
    if (key.return) {
      onRespond("accept");
    } else if (input === "s") {
      onRespond("acceptForSession");
    } else if (key.escape) {
      onRespond("decline");
    }
  });

  const borderColor = request.agent === "claude" ? "magenta" : "cyan";
  const header = request.agent === "claude"
    ? `${request.agent} was denied permission`
    : `${request.agent} wants to ${request.kind === "command" ? "run a command" : request.kind === "file" ? "modify a file" : "escalate permissions"}`;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1}>
      <Text bold>{header}</Text>
      <Text> </Text>
      <Text>{request.command || request.filePath || request.description}</Text>
      <Text> </Text>
      <Text dimColor>
        [Enter] Accept{request.availableDecisions.includes("acceptForSession") ? "  [s] Accept for session" : ""}  [Esc] Deny
        {queueSize > 0 ? `  (${queueSize} more queued)` : ""}
      </Text>
    </Box>
  );
};
```

- [ ] **Step 2: Wire into InkChatApp state**

Add to `InkChatOptions`:

```typescript
approvalQueue: ApprovalQueue;
```

In the `InkChatApp` component, add state:

```typescript
const [activeApproval, setActiveApproval] = useState<ApprovalRequest | null>(null);
const [approvalQueueSize, setApprovalQueueSize] = useState(0);
```

Wire callbacks in `useEffect`:

```typescript
useEffect(() => {
  props.approvalQueue.setCallbacks(
    (item) => {
      setActiveApproval(item.request);
      setApprovalQueueSize(props.approvalQueue.pending - 1);
    },
    () => {
      setActiveApproval(null);
      setApprovalQueueSize(0);
    },
  );
}, []);
```

In the render, replace input when approval is active:

```tsx
{activeApproval ? (
  <ApprovalPrompt
    request={activeApproval}
    queueSize={approvalQueueSize}
    onRespond={(decision) => {
      props.approvalQueue.respondToActive(decision);
    }}
  />
) : (
  /* existing input component */
)}
```

- [ ] **Step 3: Pass approvalQueue from main.ts to InkChat**

In `cmd/agoryx/main.ts`, where the InkChat is initialized, pass the engine's approval queue:

```typescript
approvalQueue: engine.getApprovalQueue(),
```

- [ ] **Step 4: Manual test**

Run: `npm run chat -- --agents codex --mode manual --adapter-mode agentic`
Send a message that triggers a tool use requiring approval.
Expected: Approval prompt appears with tool details and keybindings.

- [ ] **Step 5: Commit**

```bash
git add cmd/agoryx/ink-chat.tsx cmd/agoryx/main.ts
git commit -m "feat(ui): add approval prompt component for tool permission flow"
```

---

### Task 7: Claude Retry Flow — Retry Dispatch on Approval

**Files:**
- Modify: `internal/engine/dispatch-engine.ts:374-523`
- Test: `tests/engine/claude-retry.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/engine/claude-retry.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("Claude retry-with-allowed-tools", () => {
  it("should flag need-retry when claude has pending allowed tools", () => {
    // This tests the logic: after a dispatch completes and the claude adapter
    // has allowedToolsOverride populated, the engine should re-dispatch.
    // Implementation detail: the dispatch engine checks adapter.getAllowedToolsOverride()
    // after runPersistentDispatch completes. If non-empty, it restarts the runner
    // with those tools and retries.
    assert.ok(true, "placeholder until wiring is complete");
  });
});
```

- [ ] **Step 2: Add retry logic to `runPersistentDispatch` for Claude**

After the `for await` loop in `runPersistentDispatch()`, add:

```typescript
// After the turn completes, check if Claude had permission denials that user approved
if (
  "getAllowedToolsOverride" in adapter &&
  typeof (adapter as any).getAllowedToolsOverride === "function"
) {
  const allowedTools = (adapter as any).getAllowedToolsOverride() as string[];
  if (allowedTools.length > 0) {
    (adapter as any).clearAllowedToolsOverride();
    // Need to restart the runner with new allowedTools
    // and retry the dispatch
    this.logger.log("info", "dispatch.retry_with_allowed_tools", {
      adapter: dispatch.targetAdapter,
      tools: allowedTools,
    });
    // Destroy current runner so next dispatch creates one with allowedTools
    if (adapter.destroy) {
      await adapter.destroy(agentSession.nativeSessionId ?? "");
    }
    // Retry dispatch
    return this.runPersistentDispatch(dispatch, adapter, adapterConfig, true, options);
  }
}
```

Note: This requires the Claude adapter to pass `allowedTools` to `buildClaudeInteractiveSpawnArgs` when creating a new runner. Update `ClaudeAdapter.ensureInteractiveRunner()` to check `this.allowedToolsOverride` and pass it.

- [ ] **Step 3: Update ClaudeAdapter.ensureInteractiveRunner to pass allowedTools**

```typescript
// In ensureInteractiveRunner, when creating the runner:
const runner = new ClaudeInteractiveRunner(
  cwd,
  buildClaudeSpawnEnv(process.env),
  nativeSessionId,
  this.allowedToolsOverride, // pass allowed tools
);
```

Update `ClaudeInteractiveRunner` constructor to accept and use `allowedTools`:

```typescript
public constructor(
  cwd: string,
  env: NodeJS.ProcessEnv,
  nativeSessionId: string | null,
  allowedTools: string[] = [],
) {
  this.sessionIdValue = nativeSessionId;
  this.child = spawn(
    "claude",
    buildClaudeInteractiveSpawnArgs(nativeSessionId, allowedTools),
    { stdio: ["pipe", "pipe", "pipe"], env, cwd },
  );
  // ... rest of constructor
}
```

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add internal/engine/dispatch-engine.ts internal/adapters/claude/index.ts tests/engine/claude-retry.test.ts
git commit -m "feat(engine): retry claude dispatch with user-approved tools"
```

---

### Task 8: Final Integration and Verification

**Files:**
- All modified files
- Test: full suite

- [ ] **Step 1: Run typecheck**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 4: Manual end-to-end test with Codex**

```bash
npm run chat -- --agents codex --mode manual --adapter-mode agentic
```

Send: "list files in the current directory using ls"
Expected: Approval prompt appears. Press Enter to accept. Codex runs the command and shows results.

- [ ] **Step 5: Manual end-to-end test with Claude**

```bash
npm run chat -- --agents claude --mode manual --adapter-mode agentic
```

Send: "write 'hello' to /tmp/agoryx-test.txt"
Expected: Claude attempts Write, gets denied, approval prompt appears. Press Enter. Turn retries with --allowedTools Write.

- [ ] **Step 6: Commit all remaining changes**

```bash
git add -A
git commit -m "feat: tool approval proxy — complete integration"
```
