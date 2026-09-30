import { randomUUID } from "node:crypto";
import { classifyFailure, lastLines, runJsonlProcess, spawnJsonlChild, type JsonlChild } from "./process.js";
import {
  fingerprintOf,
  shellQuote,
  truncate,
  type AgentRunner,
  type LiveProcess,
  type TurnCallbacks,
  type TurnRequest,
  type TurnResult,
} from "./types.js";
import type { Activity, ActivityKind, TurnUsage } from "../types.js";
import { BROWSER_SERVER, claudeMcpConfig, describeBrowserTool } from "../browsertools.js";
import { parseClaudeRateLimit } from "../limits.js";

type Json = Record<string, unknown>;

/** After its `result`, how long a Claude process gets to exit by itself before its group is taken down. */
const CLAUDE_EXIT_GRACE_MS = 1500;

const asObject = (value: unknown): Json | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * Claude Code runs as it does in the human's own terminal: their settings, their permission mode
 * (e.g. auto), no sandbox of Agoryx's own. Agoryx adds restrictions only when the human sets them
 * for the room: read-only access or network off put Claude in its sandbox (Bash auto-allowed
 * there), with edits accepted or denied. No permission bypass either way.
 *
 * The room's shim (table, diff, read, say) is allowed by name, so the room's own tools work in -p
 * mode whatever the permission mode (Claude Code otherwise refuses commands it cannot statically
 * analyse, e.g. an evidence note quoting `===`). With the shim the room also hands Claude its browser, the MCP server
 * `agoryx mcp` (`--mcp-config`), and allows its tools, so they run without a prompt.
 */
export const restrictedRoom = (settings: TurnRequest["settings"]): boolean => settings.access === "readonly" || !settings.network;

export const buildClaudeSettings = (request: Pick<TurnRequest, "settings"> & { env?: NodeJS.ProcessEnv }): Json => {
  const readonly = request.settings.access === "readonly";
  const shim = request.env?.AGORYX_CLI;
  const tools = ["agoryx", ...(shim ? [shim] : [])].flatMap((cli) => ["table", "diff", "read", "say"].map((verb) => `Bash(${cli} ${verb} *)`));
  return {
    ...(restrictedRoom(request.settings)
      ? {
          sandbox: {
            enabled: true,
            autoAllowBashIfSandboxed: true,
            allowUnsandboxedCommands: false,
            ...(request.settings.network ? { network: { allowedDomains: ["*"] } } : {}),
          },
        }
      : {}),
    permissions: {
      allow: [...tools, ...(shim ? [`mcp__${BROWSER_SERVER}__*`] : [])],
      ...(readonly ? { deny: ["Edit", "Write", "MultiEdit", "NotebookEdit"] } : {}),
    },
  };
};

export const buildClaudeArgs = (request: TurnRequest, sessionId: string, fresh: boolean): string[] => {
  const mcp = claudeMcpConfig(request.env);
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    ...(restrictedRoom(request.settings) ? ["--permission-mode", request.settings.access === "readonly" ? "default" : "acceptEdits"] : []),
    // --mcp-config takes several values: --settings right after it ends the list.
    ...(mcp ? ["--mcp-config", mcp] : []),
    "--settings",
    JSON.stringify(buildClaudeSettings(request)),
    "--allowedTools",
    "WebSearch",
    "WebFetch",
  ];
  if (request.model) args.push("--model", request.model);
  if (request.effort) args.push("--effort", request.effort);
  if (fresh) args.push("--session-id", sessionId, "--name", `agoryx · ${request.roomName}`);
  else args.push("--resume", sessionId);
  return args;
};

export const buildClaudeEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const next = { ...env };
  // A nested Claude Code refuses to start (or misbehaves) with these set.
  delete next.CLAUDECODE;
  delete next.CLAUDE_CODE_ENTRYPOINT;
  delete next.CLAUDE_CODE_SSE_PORT;
  return next;
};

const TOOL_KINDS: Record<string, ActivityKind> = {
  Bash: "command",
  BashOutput: "command",
  KillShell: "command",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Read: "read",
  Grep: "search",
  Glob: "search",
  LS: "search",
  WebFetch: "web",
  WebSearch: "web",
  TodoWrite: "note",
};

export const describeClaudeTool = (name: string, input: Json | undefined): { kind: ActivityKind; label: string; detail?: string; command?: string } => {
  // The room's browser: a value-free step, before the default case would keep the JSON input (typed text included).
  const browserPrefix = `mcp__${BROWSER_SERVER}__`;
  if (name.startsWith(browserPrefix)) return describeBrowserTool(name.slice(browserPrefix.length), input) ?? { kind: "tool", label: name };
  const kind = TOOL_KINDS[name] ?? "tool";
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = str(input?.[key]);
      if (value) return value;
    }
    return undefined;
  };
  switch (kind) {
    case "command": {
      const command = pick("command");
      return { kind, label: truncate(command ?? pick("bash_id", "shell_id") ?? name, 800), detail: pick("description"), ...(command ? { command } : {}) };
    }
    case "edit":
    case "read":
      return { kind, label: pick("file_path", "notebook_path", "path") ?? name };
    case "search":
      return { kind, label: `${name} ${truncate(pick("pattern", "path") ?? "", 120)}`.trim() };
    case "web":
      return { kind, label: truncate(pick("query", "url") ?? name, 160) };
    case "note": {
      const todos = Array.isArray(input?.todos) ? (input!.todos as Json[]) : [];
      const active = todos.find((todo) => todo.status === "in_progress");
      return { kind, label: active ? `plan: ${truncate(str(active.content) ?? "", 120)}` : `plan (${todos.length} items)` };
    }
    default: {
      const summary = input ? truncate(JSON.stringify(input), 140) : "";
      return { kind, label: name, ...(summary && summary !== "{}" ? { detail: summary } : {}) };
    }
  }
};

const toolResultText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (asObject(part)?.type === "text" ? str(asObject(part)?.text) ?? "" : ""))
      .join("\n");
  }
  return "";
};

/**
 * What Claude prints for one turn, folded into what the room needs. Shared by the process-per-turn run and
 * the live process, which sees the same events one turn after another on a single stream.
 */
class ClaudeTurn {
  finalText: string | undefined;
  lastAssistantText = "";
  resultError = false;
  resultSubtype = "";
  usage: TurnUsage | undefined;
  /** `total_cost_usd` of the result, cumulative for the process. */
  totalCost: number | undefined;
  finished = false;
  private readonly pendingTools = new Map<string, Activity>();

  constructor(
    private readonly callbacks: TurnCallbacks,
    public confirmedSession: string | null,
    /** Cost the process had already run up before this turn. */
    private readonly costBase = 0,
    /** Denials already shown (a live process may repeat earlier ones in a later result). */
    private readonly shownDenials?: Set<string>,
  ) {}

  handle(event: Json): void {
    const callbacks = this.callbacks;
    const type = str(event.type);
    const sid = str(event.session_id);
    if (sid && sid !== this.confirmedSession) {
      this.confirmedSession = sid;
      callbacks.onSession(sid);
    }
    if (type === "rate_limit_event") {
      const report = parseClaudeRateLimit(event);
      if (report) callbacks.onLimits?.(report, "claude-stream");
      return;
    }
    if (type === "stream_event") {
      const inner = asObject(event.event);
      if (inner?.type === "message_start") callbacks.onText("", true);
      const delta = asObject(inner?.delta);
      if (inner?.type === "content_block_delta" && delta?.type === "text_delta") {
        const text = str(delta.text);
        if (text) callbacks.onText(text);
      }
      return;
    }
    if (type === "assistant") {
      const message = asObject(event.message);
      const content = Array.isArray(message?.content) ? (message!.content as Json[]) : [];
      for (const block of content) {
        if (block.type === "tool_use") {
          const id = str(block.id) ?? randomUUID();
          const described = describeClaudeTool(str(block.name) ?? "tool", asObject(block.input));
          const activity: Activity = { id, ...described, status: "running" };
          this.pendingTools.set(id, activity);
          callbacks.onActivity(activity);
        } else if (block.type === "text") {
          const text = str(block.text);
          if (text?.trim()) this.lastAssistantText = text;
        }
      }
      return;
    }
    if (type === "user") {
      const message = asObject(event.message);
      const content = Array.isArray(message?.content) ? (message!.content as Json[]) : [];
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const id = str(block.tool_use_id);
        const pending = id ? this.pendingTools.get(id) : undefined;
        if (!pending) continue;
        const failed = block.is_error === true;
        const output = toolResultText(block.content);
        callbacks.onActivity({
          ...pending,
          status: failed ? "fail" : "ok",
          // A browser error can quote a URL's query or a script's exception: its step stays value-free.
          ...(failed && output && pending.kind !== "browser" ? { detail: truncate(output, 240) } : {}),
        });
        this.pendingTools.delete(id!);
      }
      return;
    }
    if (type === "result") {
      this.finished = true;
      this.resultSubtype = str(event.subtype) ?? "";
      this.resultError = event.is_error === true;
      const text = str(event.result);
      if (text !== undefined) this.finalText = text;
      const rawUsage = asObject(event.usage);
      if (rawUsage) {
        this.usage = {
          inputTokens:
            Number(rawUsage.input_tokens ?? 0) +
            Number(rawUsage.cache_creation_input_tokens ?? 0) +
            Number(rawUsage.cache_read_input_tokens ?? 0),
          outputTokens: Number(rawUsage.output_tokens ?? 0),
          cachedTokens: Number(rawUsage.cache_read_input_tokens ?? 0),
        };
      }
      if (typeof event.total_cost_usd === "number") {
        this.totalCost = event.total_cost_usd;
        this.usage = { ...this.usage, costUsd: Math.max(0, event.total_cost_usd - this.costBase) };
      }
      const denials = Array.isArray(event.permission_denials) ? (event.permission_denials as Json[]) : [];
      denials.forEach((denial, index) => {
        const described = describeClaudeTool(str(denial.tool_name) ?? "tool", asObject(denial.tool_input));
        const id = `denied-${index}-${str(denial.tool_use_id) ?? ""}`;
        const uid = str(denial.tool_use_id);
        if (this.shownDenials && uid) {
          if (this.shownDenials.has(uid)) return;
          this.shownDenials.add(uid);
        }
        callbacks.onActivity({
          id,
          kind: "denied",
          label: `${str(denial.tool_name) ?? "tool"}: ${described.label}`,
          status: "fail",
        });
      });
    }
  }
}

/** What an ended turn is, given how the process ended (the same rules for a turn of its own and a live one). */
const claudeOutcome = (
  turn: ClaudeTurn,
  fallbackSession: string,
  outcome: { stderr: string; code: number | null },
): TurnResult => {
  const { finalText, resultError } = turn;
  if (finalText !== undefined && !resultError) {
    return { status: "ok", text: finalText, sessionId: turn.confirmedSession ?? fallbackSession, ...(turn.usage ? { usage: turn.usage } : {}) };
  }
  const detail = [finalText, lastLines(outcome.stderr)].filter(Boolean).join("\n") || `exit ${outcome.code} ${turn.resultSubtype}`;
  const kind = classifyFailure(detail);
  return {
    status: "error",
    text: "",
    sessionId: kind === "session" ? null : turn.confirmedSession,
    error: { kind, message: truncate(detail, 600) },
    ...(turn.usage ? { usage: turn.usage } : {}),
  };
};

/** The flags of a live process: the same as a turn's, but the prompts arrive as user messages on stdin. */
const buildClaudeLiveArgs = (request: TurnRequest, sessionId: string, fresh: boolean): string[] => [
  ...buildClaudeArgs(request, sessionId, fresh),
  "--input-format",
  "stream-json",
  // The CLI echoes each user message when it starts on it: how a turn knows its events from a stray one's.
  "--replay-user-messages",
];

/**
 * One `claude -p --input-format stream-json` process that lives across the turns of one agent: each turn is
 * a user message on its stdin, and the `result` that follows the CLI's echo of that message ends it. Events
 * outside a turn (a background task waking the model) are ignored.
 */
class ClaudeLiveProcess implements LiveProcess {
  sessionId: string | null;
  private readonly child: JsonlChild;
  private current: {
    uuid: string;
    echoed: boolean;
    turn: ClaudeTurn;
    callbacks: TurnCallbacks;
    aborted: boolean;
    timedOut: boolean;
    timeoutMinutes: number;
    finish: (result: TurnResult) => void;
  } | null = null;
  private totalCost = 0;
  private readonly denials = new Set<string>();
  private closed = false;

  constructor(
    bin: string,
    request: TurnRequest,
    readonly fingerprint: string,
  ) {
    const fresh = !request.sessionId;
    const sid = request.sessionId ?? randomUUID();
    this.sessionId = fresh ? null : sid;
    this.child = spawnJsonlChild({
      bin,
      args: buildClaudeLiveArgs(request, sid, fresh),
      cwd: request.cwd,
      env: buildClaudeEnv(request.env),
      onJson: (event) => this.onEvent(event),
    });
    void this.child.whenExited.then((exit) => this.onExit(exit));
  }

  get alive(): boolean {
    return !this.closed && !this.child.exited;
  }

  private onEvent(event: Json): void {
    const cur = this.current;
    if (!cur) return;
    // Limits are the subscription's, not the turn's: whenever they come.
    if (event.type === "rate_limit_event") {
      cur.turn.handle(event);
      return;
    }
    if (!cur.echoed) {
      const sid = str(event.session_id);
      if (sid && sid !== this.sessionId) {
        this.sessionId = sid;
        cur.turn.confirmedSession = sid;
        cur.callbacks.onSession(sid);
      }
      if (event.type === "user" && event.uuid === cur.uuid) cur.echoed = true;
      return;
    }
    cur.turn.handle(event);
    this.sessionId = cur.turn.confirmedSession ?? this.sessionId;
    if (event.type === "result") {
      if (cur.turn.totalCost !== undefined) this.totalCost = cur.turn.totalCost;
      cur.finish(claudeOutcome(cur.turn, this.sessionId ?? "", { stderr: this.child.stderr(), code: null }));
    }
  }

  private onExit(exit: { code: number | null; spawnError?: Error }): void {
    this.closed = true;
    const cur = this.current;
    if (!cur) return;
    const { turn } = cur;
    if (cur.aborted) {
      cur.finish({ status: "interrupted", text: turn.lastAssistantText, sessionId: this.sessionId });
      return;
    }
    if (exit.spawnError) {
      cur.finish({
        status: "error",
        text: "",
        sessionId: null,
        error: { kind: "spawn", message: `could not start claude: ${exit.spawnError.message}` },
        liveUnavailable: true,
      });
      return;
    }
    if (cur.timedOut) {
      cur.finish({
        status: "error",
        text: turn.lastAssistantText,
        sessionId: this.sessionId,
        error: { kind: "timeout", message: `turn exceeded ${cur.timeoutMinutes} min` },
      });
      return;
    }
    const failed = claudeOutcome(turn, this.sessionId ?? "", { stderr: this.child.stderr(), code: exit.code });
    // Dead before it took the message: nothing ran, so the turn can be run again without this process.
    // (A session the CLI could not find is a real answer: the engine rejoins with a fresh one.)
    const unstarted = !cur.echoed && failed.error?.kind !== "session";
    cur.finish(failed.status === "ok" ? failed : { ...failed, ...(unstarted ? { liveUnavailable: true } : {}) });
  }

  runTurn(request: TurnRequest, callbacks: TurnCallbacks): Promise<TurnResult> {
    return new Promise<TurnResult>((resolvePromise) => {
      if (!this.alive) {
        resolvePromise({
          status: "error",
          text: "",
          sessionId: this.sessionId,
          error: { kind: "unknown", message: "the live claude process is not running" },
          liveUnavailable: true,
        });
        return;
      }
      let timer: NodeJS.Timeout | undefined;
      const onAbort = () => {
        if (this.current) this.current.aborted = true;
        this.child.terminate();
      };
      const uuid = randomUUID();
      const cur = {
        uuid,
        echoed: false,
        turn: new ClaudeTurn(callbacks, this.sessionId, this.totalCost, this.denials),
        callbacks,
        aborted: false,
        timedOut: false,
        timeoutMinutes: Math.round(request.settings.turnTimeoutMs / 60000),
        finish: (result: TurnResult) => {
          if (this.current !== cur) return;
          this.current = null;
          if (timer) clearTimeout(timer);
          request.signal.removeEventListener("abort", onAbort);
          resolvePromise(result);
        },
      };
      this.current = cur;
      if (request.settings.turnTimeoutMs > 0) {
        timer = setTimeout(() => {
          cur.timedOut = true;
          this.child.terminate();
        }, Math.min(request.settings.turnTimeoutMs, 2 ** 31 - 1));
        timer.unref();
      }
      request.signal.addEventListener("abort", onAbort, { once: true });
      if (request.signal.aborted) {
        onAbort();
        return;
      }
      this.child.send({ type: "user", uuid, message: { role: "user", content: request.prompt } });
    });
  }

  close(): void {
    this.closed = true;
    this.child.terminate();
  }
}

export const createClaudeRunner = (bin = process.env.AGORYX_CLAUDE_BIN || "claude"): AgentRunner => ({
  kind: "claude",

  resumeCommand(sessionId: string, cwd: string, model?: string, effort?: string): string {
    return `cd ${shellQuote(cwd)} && ${shellQuote(bin)} --resume ${shellQuote(sessionId)}${model ? ` --model ${shellQuote(model)}` : ""}${effort ? ` --effort ${shellQuote(effort)}` : ""}`;
  },

  liveFingerprint(request: TurnRequest): string {
    // The session is not part of it (the engine compares that); everything else the process is started with is.
    return fingerprintOf({ bin, args: buildClaudeLiveArgs(request, "-", false), cwd: request.cwd, env: buildClaudeEnv(request.env) });
  },

  openLive(request: TurnRequest): LiveProcess {
    return new ClaudeLiveProcess(bin, request, this.liveFingerprint!(request));
  },

  async run(request: TurnRequest, callbacks: TurnCallbacks): Promise<TurnResult> {
    const attempt = async (sessionId: string, fresh: boolean): Promise<TurnResult> => {
      // A fresh session is bound only once Claude reports it (below): if the CLI never starts, the room
      // must not keep an id that names no session.
      const turn = new ClaudeTurn(callbacks, fresh ? null : sessionId);
      const outcome = await runJsonlProcess({
        bin,
        args: buildClaudeArgs(request, sessionId, fresh),
        cwd: request.cwd,
        env: buildClaudeEnv(request.env),
        stdin: request.prompt,
        signal: request.signal,
        timeoutMs: request.settings.turnTimeoutMs,
        onJson: (event) => turn.handle(event),
        // `result` is the answer; Claude exits within a moment by itself, and is not waited on for long.
        readyWhen: (event) => event.type === "result",
        readyGraceMs: CLAUDE_EXIT_GRACE_MS,
      });

      if (outcome.aborted) {
        return { status: "interrupted", text: turn.lastAssistantText, sessionId: turn.confirmedSession, ...(turn.usage ? { usage: turn.usage } : {}) };
      }
      if (outcome.spawnError) {
        return {
          status: "error",
          text: "",
          sessionId: null,
          error: { kind: "spawn", message: `could not start '${bin}': ${outcome.spawnError.message}` },
        };
      }
      if (outcome.timedOut) {
        return {
          status: "error",
          text: turn.lastAssistantText,
          sessionId: turn.confirmedSession,
          error: { kind: "timeout", message: `turn exceeded ${Math.round(request.settings.turnTimeoutMs / 60000)} min` },
        };
      }
      return claudeOutcome(turn, sessionId, outcome);
    };

    return request.sessionId ? attempt(request.sessionId, false) : attempt(randomUUID(), true);
  },
});
