import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { classifyFailure, lastLines, runJsonlProcess, spawnJsonlChild, stripLoneSurrogates, type JsonlChild } from "./process.js";
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
import type { Activity, TurnUsage } from "../types.js";
import { BROWSER_SERVER, codexMcpArgs, describeBrowserTool } from "../browsertools.js";
import { parseCodexRateLimits } from "../limits.js";
import { limitText } from "../duration.js";
import { readCodexSessionLimits } from "../limits-store.js";
import { locateCodexRollout } from "../native.js";

type Json = Record<string, unknown>;

const asObject = (value: unknown): Json | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * Codex runs inside its own sandbox: workspace-write (read-only when the room is), never with
 * approvals/sandbox bypass. Nobody is at a prompt in a room, so in an unrestricted room a request
 * to leave the sandbox goes to Codex's own automatic review (what `--approve-for-me` does) instead
 * of being refused unseen; when the human turns the network off or makes the room read-only, it is
 * refused as before.
 *
 * With the shim the room also hands Codex its browser, the MCP server `agoryx mcp` (`-c mcp_servers.agoryx_browser.*`).
 */
export const buildCodexArgs = (request: TurnRequest): string[] => {
  const sandbox = request.settings.access === "readonly" ? "read-only" : "workspace-write";
  const common = ["--json", "--skip-git-repo-check"];
  if (request.model) common.push("-m", request.model);
  if (request.effort) common.push("-c", `model_reasoning_effort="${request.effort}"`);
  // The project's context folders are writable beside the workspace (Codex reads anywhere already).
  if (request.addDirs?.length) common.push("-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(request.addDirs)}`);
  if (request.settings.network && sandbox === "workspace-write") {
    common.push("-c", "sandbox_workspace_write.network_access=true");
    common.push("-c", 'approval_policy="on-request"', "-c", 'approvals_reviewer="auto_review"');
  }
  common.push(...codexMcpArgs(request.env));
  if (request.sessionId) {
    return ["exec", "resume", request.sessionId, ...common, "-c", `sandbox_mode="${sandbox}"`, "-"];
  }
  return ["exec", ...common, "-C", request.cwd, "-s", sandbox, "-"];
};

/** "/bin/zsh -lc 'ls -a'" → "ls -a" */
export const unwrapShellCommand = (command: string): string => {
  const match = /^(?:\/\S+\/)?(?:ba|z)?sh\s+-l?c\s+'([\s\S]*)'$/.exec(command.trim());
  if (!match) {
    const dq = /^(?:\/\S+\/)?(?:ba|z)?sh\s+-l?c\s+"([\s\S]*)"$/.exec(command.trim());
    return dq ? dq[1]!.replace(/\\"/g, '"') : command;
  }
  return match[1]!.replace(/'\\''/g, "'");
};

export const describeCodexItem = (item: Json): Omit<Activity, "id"> | null => {
  switch (item.type) {
    case "command_execution": {
      const status = str(item.status);
      const exitCode = typeof item.exit_code === "number" ? item.exit_code : null;
      const failed = status === "failed" || (exitCode !== null && exitCode !== 0);
      const output = str(item.aggregated_output) ?? "";
      const command = unwrapShellCommand(str(item.command) ?? "");
      return {
        kind: "command",
        label: truncate(command, 800),
        command,
        ...(typeof item.cwd === "string" && item.cwd ? { cwd: item.cwd } : {}),
        status: status === "in_progress" ? "running" : failed ? "fail" : "ok",
        ...(failed && output ? { detail: truncate(output, 240) } : {}),
        // What it printed, its end, failed or not: the engine reads it (the pull request gh opened, a force-push before a
        // later step failed), never keeps it.
        ...(status !== "in_progress" ? { output: output.slice(-2000), ...(output.length > 2000 ? { outputCut: true as const } : {}) } : {}),
      };
    }
    case "file_change": {
      const changes = Array.isArray(item.changes) ? (item.changes as Json[]) : [];
      const paths = changes.map((change) => `${str(change.kind) === "add" ? "+" : str(change.kind) === "delete" ? "−" : "~"}${str(change.path) ?? "?"}`);
      return {
        kind: "edit",
        label: truncate(paths.join(" "), 800) || "files",
        status: str(item.status) === "failed" ? "fail" : "ok",
      };
    }
    case "mcp_tool_call": {
      const status = str(item.status) === "in_progress" ? "running" : str(item.status) === "failed" ? "fail" : "ok";
      // The room's browser: a value-free step; the arguments are read for it, never kept.
      const browser = item.server === BROWSER_SERVER ? describeBrowserTool(str(item.tool) ?? "", item.arguments) : null;
      if (browser) return { ...browser, status };
      return { kind: "tool", label: `${str(item.server) ?? "mcp"}.${str(item.tool) ?? "tool"}`, status };
    }
    case "web_search":
      return { kind: "web", label: truncate(str(item.query) ?? "web search", 160), status: "ok" };
    case "todo_list": {
      const items = Array.isArray(item.items) ? (item.items as Json[]) : [];
      const open = items.find((entry) => entry.completed !== true);
      return { kind: "note", label: open ? `plan: ${truncate(str(open.text) ?? "", 120)}` : `plan (${items.length} items)`, status: "ok" };
    }
    case "reasoning": {
      const text = str(item.text) ?? "";
      return text.trim() ? { kind: "thinking", label: truncate(text.replace(/\*\*/g, ""), 200), status: "ok" } : null;
    }
    case "error":
      return { kind: "error", label: truncate(str(item.message) ?? "error", 240), status: "fail" };
    default:
      return null;
  }
};

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

/**
 * Codex's built-in image_gen saves into $CODEX_HOME/generated_images/<thread>/ and
 * `exec --json` does not report it: the final answer may be just "🌕". Listing the folder
 * before and after a turn tells which images the turn made, so the room can show them.
 */
export const listGeneratedImages = (codexHome: string, threadId: string | null): Map<string, number> => {
  const found = new Map<string, number>();
  if (!threadId || !/^[\w-]+$/.test(threadId)) return found;
  const dir = join(codexHome, "generated_images", threadId);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return found;
  }
  for (const name of names) {
    if (!IMAGE_EXTS.has(extname(name).toLowerCase())) continue;
    try {
      const stat = statSync(join(dir, name));
      if (stat.isFile()) found.set(join(dir, name), stat.mtimeMs);
    } catch {
      // Gone between readdir and stat.
    }
  }
  return found;
};

/** Images that are new, or rewritten, since `before`, oldest first. */
export const newImages = (before: Map<string, number>, after: Map<string, number>): string[] =>
  [...after].filter(([path, at]) => before.get(path) !== at).sort((a, b) => a[1] - b[1]).map(([path]) => path);

// ---------------------------------------------------------------------------
// Live process: `codex app-server` (JSON-RPC over stdio), one thread, many turns
// ---------------------------------------------------------------------------

/** The thread's fixed settings, as app-server takes them: the same sandbox, model and network as `codex exec`. */
export const buildCodexThreadParams = (request: TurnRequest): Json => {
  const sandbox = request.settings.access === "readonly" ? "read-only" : "workspace-write";
  const config: Json = {};
  if (request.effort) config.model_reasoning_effort = request.effort;
  const writable: Json = {
    ...(request.addDirs?.length ? { writable_roots: request.addDirs } : {}),
    ...(request.settings.network && sandbox === "workspace-write" ? { network_access: true } : {}),
  };
  if (Object.keys(writable).length) config.sandbox_workspace_write = writable;
  // As `codex exec` (buildCodexArgs): in an unrestricted room a request to leave the sandbox goes to Codex's
  // own automatic review; with the network off or read-only access, what the sandbox refuses stays refused.
  const unrestricted = request.settings.network && sandbox === "workspace-write";
  return {
    cwd: request.cwd,
    sandbox,
    ...(unrestricted ? { approvalPolicy: "on-request", approvalsReviewer: "auto_review" } : { approvalPolicy: "never" }),
    ...(request.model ? { model: request.model } : {}),
    ...(Object.keys(config).length ? { config } : {}),
  };
};

/** app-server's camelCase item as the `exec --json` item `describeCodexItem` reads. */
export const execShapedItem = (item: Json): Json | null => {
  const status = (value: unknown): string => (value === "inProgress" ? "in_progress" : value === "declined" ? "failed" : (str(value) ?? "completed"));
  switch (item.type) {
    case "commandExecution":
      return {
        type: "command_execution",
        command: item.command,
        ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}),
        status: status(item.status),
        aggregated_output: item.aggregatedOutput,
        exit_code: item.exitCode,
      };
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? (item.changes as Json[]) : [];
      return {
        type: "file_change",
        status: status(item.status),
        changes: changes.map((change) => ({ path: change.path, kind: str(asObject(change.kind)?.type) ?? str(change.kind) })),
      };
    }
    case "mcpToolCall":
      return { type: "mcp_tool_call", server: item.server, tool: item.tool, arguments: item.arguments, status: status(item.status) };
    case "webSearch":
      return { type: "web_search", query: item.query };
    case "plan":
      return { type: "todo_list", items: [{ text: str(item.text) ?? "", completed: false }] };
    case "reasoning": {
      const parts = [...(Array.isArray(item.summary) ? (item.summary as unknown[]) : []), ...(Array.isArray(item.content) ? (item.content as unknown[]) : [])];
      return { type: "reasoning", text: parts.filter((part): part is string => typeof part === "string").join(" ") };
    }
    default:
      return null;
  }
};

const rpcMessage = (error: unknown): string => {
  const message = str(asObject(error)?.message) ?? (typeof error === "string" ? error : "");
  return message || JSON.stringify(error);
};

class CodexLiveProcess implements LiveProcess {
  sessionId: string | null;
  private readonly child: JsonlChild;
  private readonly codexHome: string;
  private readonly handshake: Promise<void>;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: Json) => void; reject: (error: unknown) => void }>();
  private announced = false;
  private closed = false;
  private current: {
    callbacks: TurnCallbacks;
    turnId: string | null;
    lastMessage: string | undefined;
    streaming: boolean;
    usage: TurnUsage | undefined;
    failure: string | undefined;
    aborted: boolean;
    timedOut: boolean;
    limit: string;
    imagesBefore: Map<string, number>;
    finish: (result: TurnResult) => void;
  } | null = null;

  constructor(
    bin: string,
    private readonly request: TurnRequest,
    readonly fingerprint: string,
  ) {
    this.sessionId = request.sessionId;
    this.codexHome = request.env.CODEX_HOME || process.env.CODEX_HOME || join(homedir(), ".codex");
    this.child = spawnJsonlChild({
      bin,
      // The room's browser, as `codex exec` gets it; the fingerprint has request.env, which these come from.
      args: ["app-server", ...codexMcpArgs(request.env)],
      cwd: request.cwd,
      env: request.env,
      onJson: (message) => this.onMessage(message),
    });
    void this.child.whenExited.then((exit) => this.onExit(exit));
    // Started at once, so the handshake overlaps whatever the caller still has to do before its first turn.
    this.handshake = this.start();
    this.handshake.catch(() => {});
  }

  get alive(): boolean {
    return !this.closed && !this.child.exited;
  }

  private rpc(method: string, params: Json): Promise<Json> {
    return new Promise((resolvePromise, reject) => {
      if (this.child.exited) return reject(new Error("the codex app-server is not running"));
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.child.send({ id, method, params });
    });
  }

  private async start(): Promise<void> {
    await this.rpc("initialize", { clientInfo: { name: "agoryx", title: null, version: "1" }, capabilities: null });
    this.child.send({ method: "initialized" });
    const params = buildCodexThreadParams(this.request);
    const started = this.request.sessionId
      ? await this.rpc("thread/resume", { threadId: this.request.sessionId, ...params })
      : await this.rpc("thread/start", params);
    const id = str(asObject(started.thread)?.id);
    if (!id) throw new Error("app-server did not report a thread id");
    this.sessionId = id;
  }

  private onMessage(message: Json): void {
    const method = str(message.method);
    if (message.id !== undefined && method) {
      // A request from the server (an approval, a question for the user): nobody answers those in an unattended turn.
      this.child.send({ id: message.id, error: { code: -32601, message: "agoryx does not answer requests from the agent runtime" } });
      return;
    }
    if (message.id !== undefined && typeof message.id === "number") {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) waiter.reject(message.error);
      else waiter.resolve(asObject(message.result) ?? {});
      return;
    }
    if (method) this.onNotification(method, asObject(message.params) ?? {});
  }

  private onNotification(method: string, params: Json): void {
    const cur = this.current;
    // The account's, not the thread's (it carries no threadId): whenever a turn is there to hear it.
    if (method === "account/rateLimits/updated") {
      const report = parseCodexRateLimits(params.rateLimits, undefined, { sparse: true });
      if (cur && report) cur.callbacks.onLimits?.(report, "codex-app-server");
      return;
    }
    if (!cur || (params.threadId && params.threadId !== this.sessionId)) return;
    const turnId = str(params.turnId) ?? str(asObject(params.turn)?.id);
    if (method === "turn/started") {
      cur.turnId ??= turnId ?? null;
      return;
    }
    // Events of another turn (one that was interrupted before) are not this turn's.
    if (turnId && cur.turnId && turnId !== cur.turnId) return;
    switch (method) {
      case "item/started":
      case "item/completed": {
        const item = asObject(params.item);
        if (!item) return;
        if (item.type === "agentMessage") {
          if (method === "item/started") {
            cur.streaming = true;
            cur.callbacks.onText("", true);
            return;
          }
          const text = str(item.text) ?? "";
          if (cur.lastMessage !== undefined) {
            // An earlier message in the same turn was commentary; keep it in the trace.
            cur.callbacks.onActivity({ id: `msg-${str(item.id) ?? Math.random()}`, kind: "note", label: truncate(cur.lastMessage, 200), status: "ok" });
          }
          cur.lastMessage = text;
          if (!cur.streaming) cur.callbacks.onText(text, true);
          cur.streaming = false;
          return;
        }
        const shaped = execShapedItem(item);
        const described = shaped ? describeCodexItem(shaped) : null;
        if (described) cur.callbacks.onActivity({ id: str(item.id) ?? `item-${Math.random()}`, ...described });
        return;
      }
      case "item/agentMessage/delta": {
        const delta = str(params.delta);
        if (delta) cur.callbacks.onText(delta);
        return;
      }
      case "thread/tokenUsage/updated": {
        // `last` is the model call that just ended; a turn is the sum of its calls.
        const last = asObject(asObject(params.tokenUsage)?.last);
        if (!last) return;
        cur.usage = {
          inputTokens: (cur.usage?.inputTokens ?? 0) + Number(last.inputTokens ?? 0),
          outputTokens: (cur.usage?.outputTokens ?? 0) + Number(last.outputTokens ?? 0),
          cachedTokens: (cur.usage?.cachedTokens ?? 0) + Number(last.cachedInputTokens ?? 0),
        };
        return;
      }
      case "error":
        if (params.willRetry !== true) cur.failure = rpcMessage(params.error);
        return;
      case "turn/completed": {
        const turn = asObject(params.turn);
        const status = str(turn?.status);
        const failed = status === "failed" || cur.failure !== undefined;
        if (status === "interrupted") {
          cur.finish({ status: "interrupted", text: cur.lastMessage ?? "", sessionId: this.sessionId, ...(cur.usage ? { usage: cur.usage } : {}) });
        } else if (!failed) {
          const images = newImages(cur.imagesBefore, listGeneratedImages(this.codexHome, this.sessionId));
          cur.finish({
            status: "ok",
            text: cur.lastMessage ?? "",
            sessionId: this.sessionId,
            ...(cur.usage ? { usage: cur.usage } : {}),
            ...(images.length ? { images } : {}),
          });
        } else {
          const detail = cur.failure ?? (turn?.error ? rpcMessage(turn.error) : "turn failed");
          const kind = classifyFailure(detail);
          cur.finish({
            status: "error",
            text: "",
            sessionId: kind === "session" ? null : this.sessionId,
            error: { kind, message: truncate(detail, 600) },
            ...(cur.usage ? { usage: cur.usage } : {}),
          });
        }
        return;
      }
      default:
    }
  }

  private onExit(exit: { code: number | null; spawnError?: Error }): void {
    this.closed = true;
    const dead = new Error(exit.spawnError?.message ?? `the codex app-server exited (${exit.code})`);
    for (const waiter of this.pending.values()) waiter.reject(dead);
    this.pending.clear();
    const cur = this.current;
    if (!cur) return;
    if (cur.aborted) {
      cur.finish({ status: "interrupted", text: cur.lastMessage ?? "", sessionId: this.sessionId, ...(cur.usage ? { usage: cur.usage } : {}) });
    } else if (cur.timedOut) {
      cur.finish({
        status: "error",
        text: cur.lastMessage ?? "",
        sessionId: this.sessionId,
        error: { kind: "timeout", message: `turn exceeded ${cur.limit}` },
      });
    } else if (cur.turnId === null && exit.spawnError) {
      cur.finish({ status: "error", text: "", sessionId: null, error: { kind: "spawn", message: dead.message }, liveUnavailable: true });
    } else {
      const detail = cur.failure ?? (lastLines(this.child.stderr().split("\n").filter((line) => !/mcp|oauth|sentry|hyper3d/i.test(line)).join("\n")) || dead.message);
      const kind = classifyFailure(detail);
      cur.finish({
        status: "error",
        text: "",
        sessionId: kind === "session" ? null : this.sessionId,
        error: { kind, message: truncate(detail, 600) },
        ...(cur.turnId === null && kind !== "session" ? { liveUnavailable: true } : {}),
      });
    }
  }

  runTurn(request: TurnRequest, callbacks: TurnCallbacks): Promise<TurnResult> {
    return new Promise<TurnResult>((resolvePromise) => {
      if (!this.alive) {
        resolvePromise({
          status: "error",
          text: "",
          sessionId: this.sessionId,
          error: { kind: "unknown", message: "the live codex process is not running" },
          liveUnavailable: true,
        });
        return;
      }
      let timer: NodeJS.Timeout | undefined;
      const onAbort = () => {
        if (this.current) this.current.aborted = true;
        this.child.terminate();
      };
      const cur = {
        callbacks,
        turnId: null as string | null,
        lastMessage: undefined as string | undefined,
        streaming: false,
        usage: undefined as TurnUsage | undefined,
        failure: undefined as string | undefined,
        aborted: false,
        timedOut: false,
        limit: limitText(request.settings.turnTimeoutMs),
        imagesBefore: listGeneratedImages(this.codexHome, this.sessionId),
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
      void this.handshake
        .then(() => {
          if (!this.announced && this.sessionId) {
            this.announced = true;
            callbacks.onSession(this.sessionId);
          }
          cur.imagesBefore = listGeneratedImages(this.codexHome, this.sessionId);
          return this.rpc("turn/start", {
            threadId: this.sessionId,
            input: [{ type: "text", text: stripLoneSurrogates(request.prompt), text_elements: [] }],
          });
        })
        .then((started) => {
          cur.turnId ??= str(asObject(started.turn)?.id) ?? null;
        })
        .catch((error: unknown) => {
          if (this.current !== cur) return;
          const message = rpcMessage(error);
          const kind = classifyFailure(message);
          // Nothing of this turn ran: it can be run some other way, unless the session itself is what failed.
          cur.finish({
            status: "error",
            text: "",
            sessionId: kind === "session" ? null : this.sessionId,
            error: { kind, message: truncate(message, 600) },
            ...(kind === "session" ? {} : { liveUnavailable: true }),
          });
          this.close();
        });
    });
  }

  close(): void {
    this.closed = true;
    this.child.terminate();
  }
}

export const createCodexRunner = (bin = process.env.AGORYX_CODEX_BIN || "codex"): AgentRunner => ({
  kind: "codex",

  resumeCommand(sessionId: string, cwd: string, model?: string, effort?: string): string {
    const reasoning = effort ? ` -c ${shellQuote(`model_reasoning_effort="${effort}"`)}` : "";
    return `cd ${shellQuote(cwd)} && ${shellQuote(bin)} resume ${shellQuote(sessionId)}${model ? ` -m ${shellQuote(model)}` : ""}${reasoning}`;
  },

  liveFingerprint(request: TurnRequest): string {
    // The thread (session) is not part of it; the engine compares that. Everything else it is started with is.
    return fingerprintOf({ bin, thread: buildCodexThreadParams(request), env: request.env });
  },

  openLive(request: TurnRequest): LiveProcess {
    return new CodexLiveProcess(bin, request, this.liveFingerprint!(request));
  },

  async run(request: TurnRequest, callbacks: TurnCallbacks): Promise<TurnResult> {
    let threadId: string | null = request.sessionId;
    let lastMessage: string | undefined;
    let usage: TurnUsage | undefined;
    let failure: string | undefined;
    let completed = false;
    const codexHome = request.env.CODEX_HOME || process.env.CODEX_HOME || join(homedir(), ".codex");
    const imagesBefore = listGeneratedImages(codexHome, request.sessionId);

    const outcome = await runJsonlProcess({
      bin,
      args: buildCodexArgs(request),
      cwd: request.cwd,
      env: request.env,
      stdin: request.prompt,
      signal: request.signal,
      timeoutMs: request.settings.turnTimeoutMs,
      // `turn.completed` is the answer; the process takes seconds more to exit, and nothing after it is the turn's.
      readyWhen: (event) => event.type === "turn.completed",
      onJson: (event) => {
        switch (event.type) {
          case "thread.started": {
            const id = str(event.thread_id);
            if (id) {
              threadId = id;
              callbacks.onSession(id);
            }
            return;
          }
          case "item.started":
          case "item.updated":
          case "item.completed": {
            const item = asObject(event.item);
            if (!item) return;
            if (item.type === "agent_message") {
              if (event.type !== "item.completed") return;
              const text = str(item.text) ?? "";
              if (lastMessage !== undefined) {
                // An earlier message in the same turn was commentary; keep it in the trace.
                callbacks.onActivity({ id: `msg-${str(item.id) ?? Math.random()}`, kind: "note", label: truncate(lastMessage, 200), status: "ok" });
              }
              lastMessage = text;
              callbacks.onText(text, true);
              return;
            }
            const described = describeCodexItem(item);
            if (described) callbacks.onActivity({ id: str(item.id) ?? `item-${Math.random()}`, ...described });
            return;
          }
          case "turn.completed": {
            completed = true;
            const raw = asObject(event.usage);
            if (raw) {
              usage = {
                inputTokens: Number(raw.input_tokens ?? 0),
                outputTokens: Number(raw.output_tokens ?? 0),
                cachedTokens: Number(raw.cached_input_tokens ?? 0),
              };
            }
            return;
          }
          case "turn.failed": {
            const error = asObject(event.error);
            failure = str(error?.message) ?? "turn failed";
            return;
          }
          case "error":
            failure = str(event.message) ?? "error";
            return;
          default:
            return;
        }
      },
    });

    if (outcome.aborted) {
      return { status: "interrupted", text: lastMessage ?? "", sessionId: threadId, ...(usage ? { usage } : {}) };
    }
    if (outcome.spawnError) {
      return { status: "error", text: "", sessionId: null, error: { kind: "spawn", message: `could not start '${bin}': ${outcome.spawnError.message}` } };
    }
    // `codex exec --json` prints no limits; its session file has them on its token counts.
    if (callbacks.onLimits && threadId) {
      const file = locateCodexRollout(threadId, request.env);
      const report = file ? readCodexSessionLimits(file) : null;
      if (report) callbacks.onLimits(report, "codex-session");
    }
    if (outcome.timedOut) {
      return {
        status: "error",
        text: lastMessage ?? "",
        sessionId: threadId,
        error: { kind: "timeout", message: `turn exceeded ${limitText(request.settings.turnTimeoutMs)}` },
      };
    }
    if (completed && !failure) {
      const images = newImages(threadId === request.sessionId ? imagesBefore : new Map(), listGeneratedImages(codexHome, threadId));
      return { status: "ok", text: lastMessage ?? "", sessionId: threadId, ...(usage ? { usage } : {}), ...(images.length ? { images } : {}) };
    }
    // Codex prints MCP/OAuth noise on stderr; only use it when nothing better exists.
    const detail = failure ?? (lastLines(outcome.stderr.split("\n").filter((line) => !/mcp|oauth|sentry|hyper3d/i.test(line)).join("\n")) || `exit ${outcome.code}`);
    const kind = classifyFailure(detail);
    return {
      status: "error",
      text: "",
      sessionId: kind === "session" ? null : threadId,
      error: { kind, message: truncate(detail, 600) },
      ...(usage ? { usage } : {}),
    };
  },
});
