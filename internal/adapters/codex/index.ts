import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { setTimeout as wait } from "node:timers/promises";
import type {
  AdapterStatus,
  AgentInput,
  PersistentAdapter,
  SendTurnInput,
} from "../adapter.js";
import {
  messageCompleted,
  messageDelta,
  messageError,
  messageStarted,
  sessionBound,
} from "../event-factory.js";
import { extractTextFromJsonLine } from "../parse-output.js";
import { createId } from "../../session/ids.js";
import { AsyncQueue } from "../async-queue.js";
import type { ErrorClass } from "../../events/types.js";
import { createIdleTimeoutController } from "../idle-timeout.js";

const SOURCE = "adapter.codex";
const STDERR_BUFFER_MAX = 16_000;
const STDERR_SNAPSHOT_SIZE = 8_000;
type OneShotProcess = ChildProcessByStdio<null, Readable, Readable>;
type InteractiveProcess = ChildProcessByStdio<Writable, Readable, Readable>;

interface CodexInteractiveTurnResult {
  text: string;
  sessionId: string | null;
}

interface CodexInteractiveStreamItem {
  type: "delta" | "session.bound";
  text?: string;
  sessionId?: string;
}

interface CodexAppServerPending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface CodexAppServerTurn {
  requestId: string;
  output: string;
  deltaSource: CodexDeltaSource | null;
  onDelta: (text: string) => void;
  resolve: (result: CodexInteractiveTurnResult) => void;
  reject: (error: Error) => void;
  idleTimeout: ReturnType<typeof createIdleTimeoutController>;
}

type CodexDeltaSource = "envelope" | "legacy";

export class CodexAdapter implements PersistentAdapter {
  public readonly name = "codex";
  private readonly running = new Map<string, OneShotProcess>();
  private readonly interactiveRequestIds = new Set<string>();
  private status: AdapterStatus = "ready";
  private activeRequests = 0;
  private interactiveRunner: CodexAppServerRunner | null = null;
  private interactiveSessionId: string | null = null;
  private interactiveCwd: string | null = null;

  public async *send(input: AgentInput) {
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

    yield messageStarted(baseArgs(input), startedPayload);

    if (input.config.mode === "stub") {
      const stubText = this.stubText(input);
      await wait(120);
      yield messageDelta(baseArgs(input), { ...startedPayload, text: stubText });
      yield messageCompleted(baseArgs(input), { ...startedPayload, text: stubText });
      return;
    }

    const prompt = buildPrompt(input);
    const child = spawn("codex", buildCodexSpawnArgs(prompt, null), {
      stdio: ["ignore", "pipe", "pipe"],
      env: buildCodexSpawnEnv(process.env),
      cwd: buildCodexSpawnCwd(input.config.workspaceCwd),
    });
    let spawnFailureMessage: string | null = null;
    let resolveSpawnFailure!: (message: string) => void;
    const onSpawnError = (error: unknown): void => {
      const message = error instanceof Error ? error.message : String(error);
      spawnFailureMessage = message;
      resolveSpawnFailure(message);
    };
    const spawnFailurePromise = new Promise<string>((resolve) => {
      resolveSpawnFailure = resolve;
      child.once("error", onSpawnError);
    });
    const exitPromise = new Promise<number | null>((resolve) => {
      child.once("close", resolve);
    });
    this.markRequestStart();
    this.running.set(input.requestId, child);

    let stderr = "";
    let output = "";
    let timedOut = false;
    const idleTimeout = createIdleTimeoutController(input.config.timeoutMs, () => {
      timedOut = true;
      child.kill("SIGTERM");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > STDERR_BUFFER_MAX) {
        stderr = stderr.slice(-STDERR_SNAPSHOT_SIZE);
      }
      idleTimeout.touch();
    });

    try {
      for await (const chunk of child.stdout) {
        idleTimeout.touch();
        const text = parseChunkToText(chunk.toString("utf8"));
        if (!text) {
          continue;
        }
        output += text;
        yield messageDelta(baseArgs(input), {
          ...startedPayload,
          text,
        });
      }

      const processResult = await Promise.race([
        exitPromise.then((exitCode) => ({ type: "close" as const, exitCode })),
        spawnFailurePromise.then((message) => ({ type: "error" as const, message })),
      ]);

      if (timedOut) {
        yield messageError(
          baseArgs(input),
          "TIMEOUT",
          "codex request timed out",
          stderr,
        );
      } else if (processResult.type === "error") {
        yield messageError(
          baseArgs(input),
          "PROCESS_CRASH",
          `codex process failed to start: ${processResult.message}`,
          stderr,
        );
      } else if (processResult.exitCode !== 0) {
        yield messageError(
          baseArgs(input),
          classifyCodexProcessError(stderr),
          `codex process exited with code ${String(processResult.exitCode)}`,
          stderr,
        );
      } else {
        yield messageCompleted(baseArgs(input), {
          ...startedPayload,
          text: output.trim() || "(no content)",
        });
      }
    } catch (error) {
      yield messageError(
        baseArgs(input),
        spawnFailureMessage ? "PROCESS_CRASH" : "UNKNOWN",
        spawnFailureMessage
          ? `codex process failed to start: ${spawnFailureMessage}`
          : error instanceof Error
          ? error.message
          : "unknown codex adapter failure",
        stderr,
      );
    } finally {
      idleTimeout.clear();
      child.off("error", onSpawnError);
      this.running.delete(input.requestId);
      this.markRequestEnd();
    }
  }

  public async *sendTurn(input: SendTurnInput) {
    if (input.config.mode === "agentic") {
      yield* this.sendTurnInteractive(input);
      return;
    }

    yield* this.sendTurnResume(input);
  }

  private async *sendTurnResume(input: SendTurnInput) {
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

    yield messageStarted(baseArgs(input), startedPayload);

    const child = spawn(
      "codex",
      buildCodexSpawnArgs(input.prompt, input.nativeSessionId),
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: buildCodexSpawnEnv(process.env),
        cwd: buildCodexSpawnCwd(input.config.workspaceCwd),
      },
    );
    let spawnFailureMessage: string | null = null;
    let resolveSpawnFailure!: (message: string) => void;
    const onSpawnError = (error: unknown): void => {
      const message = error instanceof Error ? error.message : String(error);
      spawnFailureMessage = message;
      resolveSpawnFailure(message);
    };
    const spawnFailurePromise = new Promise<string>((resolve) => {
      resolveSpawnFailure = resolve;
      child.once("error", onSpawnError);
    });
    const exitPromise = new Promise<number | null>((resolve) => {
      child.once("close", resolve);
    });
    this.markRequestStart();
    this.running.set(input.requestId, child);

    let stderr = "";
    let output = "";
    let timedOut = false;
    let emittedThreadId: string | null = null;
    const idleTimeout = createIdleTimeoutController(input.config.timeoutMs, () => {
      timedOut = true;
      child.kill("SIGTERM");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > STDERR_BUFFER_MAX) {
        stderr = stderr.slice(-STDERR_SNAPSHOT_SIZE);
      }
      idleTimeout.touch();
    });

    try {
      for await (const chunk of child.stdout) {
        idleTimeout.touch();
        const lines = chunk.toString("utf8").split(/\r?\n/);
        for (const line of lines) {
          const threadId = extractCodexThreadId(line);
          if (threadId && threadId !== emittedThreadId) {
            emittedThreadId = threadId;
            yield sessionBound(baseArgs(input), threadId);
          }

          const text = extractTextFromJsonLine(line);
          if (!text) {
            continue;
          }

          output += text;
          yield messageDelta(baseArgs(input), {
            ...startedPayload,
            text,
          });
        }
      }

      const processResult = await Promise.race([
        exitPromise.then((exitCode) => ({ type: "close" as const, exitCode })),
        spawnFailurePromise.then((message) => ({ type: "error" as const, message })),
      ]);

      if (timedOut) {
        yield messageError(
          baseArgs(input),
          "TIMEOUT",
          "codex request timed out",
          stderr,
        );
      } else if (processResult.type === "error") {
        yield messageError(
          baseArgs(input),
          "PROCESS_CRASH",
          `codex process failed to start: ${processResult.message}`,
          stderr,
        );
      } else if (processResult.exitCode !== 0) {
        yield messageError(
          baseArgs(input),
          classifyCodexProcessError(stderr),
          `codex process exited with code ${String(processResult.exitCode)}`,
          stderr,
        );
      } else {
        yield messageCompleted(baseArgs(input), {
          ...startedPayload,
          text: output.trim() || "(no content)",
        });
      }
    } catch (error) {
      yield messageError(
        baseArgs(input),
        spawnFailureMessage ? "PROCESS_CRASH" : "UNKNOWN",
        spawnFailureMessage
          ? `codex process failed to start: ${spawnFailureMessage}`
          : error instanceof Error
          ? error.message
          : "unknown codex adapter failure",
        stderr,
      );
    } finally {
      idleTimeout.clear();
      child.off("error", onSpawnError);
      this.running.delete(input.requestId);
      this.markRequestEnd();
    }
  }

  private async *sendTurnInteractive(input: SendTurnInput) {
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

    yield messageStarted(baseArgs(input), startedPayload);
    this.markRequestStart();

    let output = "";
    try {
      const runner = await this.ensureInteractiveRunner(
        input.nativeSessionId,
        input.config.workspaceCwd,
      );

      const preBoundSessionId = runner.sessionId();
      if (preBoundSessionId && preBoundSessionId !== input.nativeSessionId) {
        yield sessionBound(baseArgs(input), preBoundSessionId);
      }

      const queue = new AsyncQueue<CodexInteractiveStreamItem>();
      this.interactiveRequestIds.add(input.requestId);

      const turnPromise = runner
        .sendTurn({
          prompt: input.prompt,
          requestId: input.requestId,
          timeoutMs: input.config.timeoutMs,
          onDelta: (text) => {
            queue.push({ type: "delta", text });
          },
        })
        .then((result) => {
          if (
            result.sessionId &&
            result.sessionId !== input.nativeSessionId &&
            result.sessionId !== preBoundSessionId
          ) {
            queue.push({
              type: "session.bound",
              sessionId: result.sessionId,
            });
          }
          return { ok: true as const, result };
        })
        .catch((error) => {
          return {
            ok: false as const,
            error: error instanceof Error ? error : new Error(String(error)),
          };
        })
        .finally(() => {
          queue.close();
        });

      for await (const item of queue) {
        if (item.type === "session.bound" && item.sessionId) {
          this.interactiveSessionId = item.sessionId;
          yield sessionBound(baseArgs(input), item.sessionId);
          continue;
        }

        if (item.type === "delta" && item.text) {
          output += item.text;
          yield messageDelta(baseArgs(input), {
            ...startedPayload,
            text: item.text,
          });
        }
      }

      const turnOutcome = await turnPromise;
      if (!turnOutcome.ok) {
        yield messageError(
          baseArgs(input),
          classifyCodexInteractiveError(turnOutcome.error.message),
          turnOutcome.error.message,
          runner.stderrSnapshot(),
        );
        return;
      }

      const resolvedText = turnOutcome.result.text.trim() || output.trim() || "(no content)";
      yield messageCompleted(baseArgs(input), {
        ...startedPayload,
        text: resolvedText,
      });
    } catch (error) {
      yield messageError(
        baseArgs(input),
        "UNKNOWN",
        error instanceof Error ? error.message : "unknown codex interactive failure",
      );
    } finally {
      this.interactiveRequestIds.delete(input.requestId);
      this.markRequestEnd();
    }
  }

  private async ensureInteractiveRunner(
    nativeSessionId: string | null,
    workspaceCwd?: string,
  ): Promise<CodexAppServerRunner> {
    const cwd = buildCodexSpawnCwd(workspaceCwd);
    const needsRestart = shouldRestartCodexInteractiveRunner(
      this.interactiveRunner !== null,
      this.interactiveRunner?.isClosed() ?? false,
      this.interactiveCwd,
      cwd,
      this.interactiveSessionId,
      nativeSessionId,
    );

    if (needsRestart) {
      await this.disposeInteractiveRunner();
      const runner = new CodexAppServerRunner(cwd, buildCodexSpawnEnv(process.env));
      const sessionId = await runner.initialize(nativeSessionId);
      this.interactiveRunner = runner;
      this.interactiveSessionId = sessionId;
      this.interactiveCwd = cwd;
      return runner;
    }

    if (!this.interactiveRunner) {
      throw new Error("interactive codex runner is not available");
    }
    return this.interactiveRunner;
  }

  private async disposeInteractiveRunner(): Promise<void> {
    if (!this.interactiveRunner) {
      return;
    }
    await this.interactiveRunner.shutdown();
    this.interactiveRunner = null;
    this.interactiveSessionId = null;
    this.interactiveCwd = null;
  }

  public async cancel(requestId: string): Promise<void> {
    const proc = this.running.get(requestId);
    if (proc) {
      proc.kill("SIGTERM");
      await this.waitForRequestCleanup(requestId);
      return;
    }

    if (this.interactiveRequestIds.has(requestId) && this.interactiveRunner) {
      await this.interactiveRunner.cancelActiveTurn(
        "codex interactive turn cancelled",
      );
      await this.waitForRequestCleanup(requestId);
    }
  }

  public async destroy(nativeSessionId: string): Promise<void> {
    if (!this.interactiveRunner) {
      return;
    }
    if (!nativeSessionId || this.interactiveSessionId === nativeSessionId) {
      await this.disposeInteractiveRunner();
    }
  }

  public async health(): Promise<AdapterStatus> {
    if (this.interactiveRunner?.isClosed()) {
      this.interactiveRunner = null;
      this.interactiveSessionId = null;
      this.interactiveCwd = null;
    }
    if (
      this.activeRequests > 0 ||
      this.running.size > 0 ||
      this.interactiveRequestIds.size > 0
    ) {
      return "busy";
    }
    return this.status;
  }

  private markRequestStart(): void {
    this.activeRequests += 1;
    this.status = "busy";
  }

  private markRequestEnd(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    if (this.activeRequests === 0) {
      this.status = "ready";
    }
  }

  private async waitForRequestCleanup(
    requestId: string,
    timeoutMs = 2_000,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (
        !this.running.has(requestId) &&
        !this.interactiveRequestIds.has(requestId)
      ) {
        return true;
      }
      await wait(20);
    }
    console.error(
      `[adapter.codex] waitForRequestCleanup timed out after ${timeoutMs}ms for request ${requestId}`,
    );
    return false;
  }

  private stubText(input: AgentInput): string {
    const lastUserMessage = [...input.messages]
      .reverse()
      .find((message) => message.role === "user");
    const prompt = lastUserMessage?.text ?? "(empty prompt)";
    return [
      "[stub/codex] I received your message.",
      `Prompt preview: ${prompt.slice(0, 180)}`,
      "Integration mode is currently STUB. Switch adapter mode to CLI to run codex directly.",
    ].join("\n");
  }
}

class CodexAppServerRunner {
  private readonly child: InteractiveProcess;
  private readonly pending = new Map<number, CodexAppServerPending>();
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private nextId = 1;
  private initialized = false;
  private closed = false;
  private sessionIdValue: string | null = null;
  private listenerSubscriptionId: string | null = null;
  private activeTurn: CodexAppServerTurn | null = null;

  public constructor(cwd: string, env: NodeJS.ProcessEnv) {
    this.cwd = cwd;
    this.env = env;
    this.child = spawn("codex", buildCodexAppServerArgs(), {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.env,
      cwd: this.cwd,
    });

    this.child.stdout.on("data", (chunk: Buffer) => {
      this.consumeStdout(chunk.toString("utf8"));
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBuffer += chunk.toString("utf8");
      if (this.stderrBuffer.length > STDERR_BUFFER_MAX) {
        this.stderrBuffer = this.stderrBuffer.slice(-STDERR_SNAPSHOT_SIZE);
      }
      const activeTurn = this.activeTurn;
      if (activeTurn) {
        activeTurn.idleTimeout.touch();
      }
    });
    this.child.once("close", (code) => {
      this.handleClose(code);
    });
    this.child.once("error", (error) => {
      this.handleFatal(error instanceof Error ? error : new Error(String(error)));
    });
  }

  public async initialize(nativeSessionId: string | null): Promise<string> {
    if (!this.initialized) {
      await this.request(
        "initialize",
        {
          clientInfo: {
            name: "agoryx",
            version: "0.1.0",
          },
          capabilities: null,
        },
        15_000,
      );
      this.initialized = true;
    }

    if (nativeSessionId) {
      const resumed = (await this.request(
        "resumeConversation",
        {
          path: null,
          conversationId: nativeSessionId,
          history: null,
          overrides: buildCodexNewConversationParams(this.cwd),
        },
        20_000,
      )) as Record<string, unknown>;

      const sessionId =
        readStringField(resumed, "conversationId") ?? nativeSessionId;
      this.sessionIdValue = sessionId;
      await this.attachConversationListener(sessionId);
      return sessionId;
    }

    const created = (await this.request(
      "newConversation",
      buildCodexNewConversationParams(this.cwd),
      20_000,
    )) as Record<string, unknown>;

    const sessionId = readStringField(created, "conversationId");
    if (!sessionId) {
      throw new Error("PROTOCOL_ERROR: codex app-server did not return conversationId");
    }
    this.sessionIdValue = sessionId;
    await this.attachConversationListener(sessionId);
    return sessionId;
  }

  public sessionId(): string | null {
    return this.sessionIdValue;
  }

  public async sendTurn(input: {
    prompt: string;
    requestId: string;
    timeoutMs: number;
    onDelta: (text: string) => void;
  }): Promise<CodexInteractiveTurnResult> {
    if (!this.sessionIdValue) {
      throw new Error("SESSION_EXPIRED: interactive codex session is not initialized");
    }
    if (this.activeTurn) {
      throw new Error("PROTOCOL_ERROR: codex interactive turn overlap is not supported");
    }

    const timeoutMs = Math.max(1_000, input.timeoutMs);
    const turnIdleTimeout = createIdleTimeoutController(timeoutMs, () => {
      void this.cancelActiveTurn("TIMEOUT: codex interactive request timed out");
    });

    const resultPromise = new Promise<CodexInteractiveTurnResult>((resolve, reject) => {
      const activeTurn: CodexAppServerTurn = {
        requestId: input.requestId,
        output: "",
        deltaSource: null,
        onDelta: input.onDelta,
        resolve,
        reject,
        idleTimeout: turnIdleTimeout,
      };
      this.activeTurn = activeTurn;
    });

    try {
      await this.request(
        "sendUserMessage",
        {
          conversationId: this.sessionIdValue,
          items: [
            {
              type: "text",
              data: {
                text: input.prompt,
                text_elements: [],
              },
            },
          ],
        },
        10_000,
      );
      turnIdleTimeout.touch();
    } catch (error) {
      this.rejectActiveTurn(
        error instanceof Error
          ? error
          : new Error("PROTOCOL_ERROR: failed to send codex turn"),
      );
      throw error;
    }

    return resultPromise;
  }

  public async cancelActiveTurn(reason: string): Promise<void> {
    const activeTurn = this.activeTurn;
    if (!activeTurn) {
      return;
    }

    this.activeTurn = null;
    activeTurn.idleTimeout.clear();

    try {
      if (this.sessionIdValue) {
        await this.request(
          "interruptConversation",
          {
            conversationId: this.sessionIdValue,
          },
          5_000,
        );
      }
    } catch (error: unknown) {
      this.closed = true;
      console.error(
        `[adapter.codex] interrupt failed, marking runner closed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    activeTurn.reject(new Error(reason));
  }

  public stderrSnapshot(): string {
    return this.stderrBuffer.slice(-STDERR_SNAPSHOT_SIZE);
  }

  public isClosed(): boolean {
    return this.closed;
  }

  public async shutdown(): Promise<void> {
    if (this.closed) {
      return;
    }

    await this.removeConversationListener();
    this.closed = true;

    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const item of pending) {
      clearTimeout(item.timer);
      item.reject(new Error("PROCESS_CRASH: codex app-server was shut down"));
    }

    if (this.activeTurn) {
      this.activeTurn.idleTimeout.clear();
      this.activeTurn.reject(
        new Error("PROCESS_CRASH: codex app-server was shut down"),
      );
      this.activeTurn = null;
    }

    this.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, 1_500);
      this.child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let index = this.stdoutBuffer.indexOf("\n");
    while (index !== -1) {
      const line = this.stdoutBuffer.slice(0, index).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (line) {
        this.consumeLine(line);
      }
      index = this.stdoutBuffer.indexOf("\n");
    }
  }

  private consumeLine(line: string): void {
    this.activeTurn?.idleTimeout.touch();

    let parsed: Record<string, unknown>;
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== "object") {
        return;
      }
      parsed = value as Record<string, unknown>;
    } catch (error: unknown) {
      if (looksLikeJsonPayload(line)) {
        logCodexJsonParseWarning("app-server line", line, error);
      }
      return;
    }

    if (typeof parsed.id === "number") {
      this.resolvePending(parsed.id, parsed);
      return;
    }

    if (typeof parsed.method !== "string") {
      return;
    }

    this.consumeNotification(parsed.method, parsed.params);
  }

  private consumeNotification(method: string, params: unknown): void {
    const obj = params && typeof params === "object"
      ? (params as Record<string, unknown>)
      : null;

    if (method === "thread/started") {
      const thread = obj?.thread;
      if (thread && typeof thread === "object") {
        const id = readStringField(thread as Record<string, unknown>, "id");
        if (id) {
          this.sessionIdValue = id;
        }
      }
      return;
    }

    if (method.startsWith("codex/event/")) {
      const envelopeMsg = obj?.msg;
      const event = envelopeMsg && typeof envelopeMsg === "object"
        ? (envelopeMsg as Record<string, unknown>)
        : null;
      if (!event) {
        return;
      }
      const eventType = readStringField(event, "type");
      if (!eventType) {
        return;
      }

      if (eventType === "session_configured") {
        const sessionId = readStringField(event, "session_id");
        if (sessionId) {
          this.sessionIdValue = sessionId;
        }
        return;
      }

      if (!this.activeTurn) {
        return;
      }

      if (eventType === "agent_message_delta") {
        const delta = readStringField(event, "delta");
        if (delta && shouldConsumeCodexDelta(this.activeTurn.deltaSource, "envelope")) {
          this.activeTurn.deltaSource = "envelope";
          this.activeTurn.output += delta;
          this.activeTurn.onDelta(delta);
        }
        return;
      }

      if (eventType === "agent_message") {
        const message = readStringField(event, "message");
        if (
          message &&
          this.activeTurn.output.trim().length === 0 &&
          shouldConsumeCodexDelta(this.activeTurn.deltaSource, "envelope")
        ) {
          this.activeTurn.deltaSource = "envelope";
          this.activeTurn.output = message;
          this.activeTurn.onDelta(message);
        }
        return;
      }

      if (eventType === "task_complete") {
        const lastMessage = readStringField(event, "last_agent_message");
        const finalText = lastMessage ?? this.activeTurn.output;
        const activeTurn = this.activeTurn;
        this.activeTurn = null;
        activeTurn.idleTimeout.clear();
        activeTurn.resolve({
          text: finalText,
          sessionId: this.sessionIdValue,
        });
        return;
      }

      if (eventType === "turn_aborted") {
        const reason = readStringField(event, "reason") ?? "aborted";
        this.rejectActiveTurn(new Error(`PROCESS_CRASH: ${reason}`));
        return;
      }

      if (eventType === "error") {
        const message = readStringField(event, "message") ?? "codex interactive error";
        this.rejectActiveTurn(new Error(`PROCESS_CRASH: ${message}`));
      }
      return;
    }

    if (!this.activeTurn || !obj) {
      return;
    }

    if (method === "item/agentMessage/delta") {
      const threadId = readStringField(obj, "threadId");
      const delta = readStringField(obj, "delta");
      if (
        delta &&
        shouldConsumeCodexDelta(this.activeTurn.deltaSource, "legacy") &&
        (!this.sessionIdValue || !threadId || threadId === this.sessionIdValue)
      ) {
        this.activeTurn.deltaSource = "legacy";
        this.activeTurn.output += delta;
        this.activeTurn.onDelta(delta);
      }
      return;
    }

    if (method === "turn/completed") {
      const threadId = readStringField(obj, "threadId");
      if (this.sessionIdValue && threadId && threadId !== this.sessionIdValue) {
        return;
      }

      const turn = obj.turn && typeof obj.turn === "object"
        ? (obj.turn as Record<string, unknown>)
        : null;
      const status = turn ? readStringField(turn, "status") : null;
      if (status === "failed") {
        const turnError = turn?.error && typeof turn.error === "object"
          ? (turn.error as Record<string, unknown>)
          : null;
        const message =
          readStringField(turnError ?? {}, "message") ||
          "codex interactive turn failed";
        this.rejectActiveTurn(new Error(`PROCESS_CRASH: ${message}`));
        return;
      }

      const text = this.activeTurn.output;
      const activeTurn = this.activeTurn;
      this.activeTurn = null;
      activeTurn.idleTimeout.clear();
      activeTurn.resolve({
        text,
        sessionId: this.sessionIdValue,
      });
      return;
    }

    if (method === "error") {
      const threadId = readStringField(obj, "threadId");
      if (this.sessionIdValue && threadId && threadId !== this.sessionIdValue) {
        return;
      }
      const errorObj = obj.error && typeof obj.error === "object"
        ? (obj.error as Record<string, unknown>)
        : null;
      const message =
        readStringField(errorObj ?? {}, "message") ||
        "codex interactive error";
      this.rejectActiveTurn(new Error(`PROCESS_CRASH: ${message}`));
    }
  }

  private resolvePending(id: number, payload: Record<string, unknown>): void {
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);

    if (payload.error && typeof payload.error === "object") {
      const errorObj = payload.error as Record<string, unknown>;
      const message = readStringField(errorObj, "message") || "codex app-server request failed";
      pending.reject(new Error(`PROCESS_CRASH: ${message}`));
      return;
    }

    pending.resolve(payload.result);
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(
        new Error("PROCESS_CRASH: codex app-server is closed"),
      );
    }

    const id = this.nextId++;
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`TIMEOUT: codex app-server request timed out (${method})`));
      }, Math.max(1_000, timeoutMs));

      this.pending.set(id, {
        resolve,
        reject,
        timer,
      });

      this.child.stdin.write(`${request}\n`, (error) => {
        if (!error) {
          return;
        }
        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(
          error instanceof Error
            ? error
            : new Error("PROCESS_CRASH: failed to write codex app-server request"),
        );
      });
    });
  }

  private rejectActiveTurn(error: Error): void {
    if (!this.activeTurn) {
      return;
    }
    const activeTurn = this.activeTurn;
    this.activeTurn = null;
    activeTurn.idleTimeout.clear();
    activeTurn.reject(error);
  }

  private handleClose(code: number | null): void {
    this.closed = true;
    const suffix = code === null ? "" : ` (exit ${code})`;
    this.handleFatal(new Error(`PROCESS_CRASH: codex app-server closed${suffix}`));
  }

  private handleFatal(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const item of pending) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.rejectActiveTurn(error);
  }

  private async attachConversationListener(conversationId: string): Promise<void> {
    await this.removeConversationListener();
    let response: unknown;
    try {
      response = await this.request(
        "addConversationListener",
        {
          conversationId,
          experimentalRawEvents: false,
        },
        10_000,
      );
    } catch (firstError: unknown) {
      const message = firstError instanceof Error ? firstError.message : String(firstError);
      if (/invalid|unknown.*param|not supported|unrecognized/i.test(message)) {
        console.error(
          `[adapter.codex] addConversationListener with experimentalRawEvents not supported, retrying without: ${message}`,
        );
        response = await this.request(
          "addConversationListener",
          { conversationId },
          10_000,
        );
      } else {
        throw firstError;
      }
    }
    const responseObj =
      response && typeof response === "object"
        ? (response as Record<string, unknown>)
        : {};
    this.listenerSubscriptionId = readStringField(responseObj, "subscriptionId");
  }

  private async removeConversationListener(): Promise<void> {
    if (!this.listenerSubscriptionId) {
      this.listenerSubscriptionId = null;
      return;
    }
    const subscriptionId = this.listenerSubscriptionId;
    this.listenerSubscriptionId = null;
    try {
      await this.request(
        "removeConversationListener",
        { subscriptionId },
        5_000,
      );
    } catch (error: unknown) {
      console.error(
        `[adapter.codex] failed to remove conversation listener: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

const baseArgs = (input: { roomId: string; sessionId: string; requestId: string }) => ({
  roomId: input.roomId,
  sessionId: input.sessionId,
  requestId: input.requestId,
  source: SOURCE,
});

export const buildCodexSpawnArgs = (
  prompt: string,
  nativeSessionId: string | null,
): string[] =>
  nativeSessionId
    ? ["exec", "resume", nativeSessionId, "--json", prompt]
    : ["exec", "--json", prompt];

export const buildCodexAppServerArgs = (): string[] => ["app-server"];

export const buildCodexSpawnEnv = (
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  const sanitized = { ...env };
  delete sanitized.CLAUDECODE;
  return sanitized;
};

const buildCodexNewConversationParams = (cwd: string): Record<string, unknown> => ({
  model: null,
  modelProvider: null,
  profile: null,
  cwd,
  approvalPolicy: "on-request",
  sandbox: "workspace-write",
  config: null,
  baseInstructions: null,
  developerInstructions: null,
  compactPrompt: null,
  includeApplyPatchTool: false,
});

const buildCodexSpawnCwd = (workspaceCwd?: string): string =>
  workspaceCwd?.trim() || process.cwd();

const looksLikeJsonPayload = (line: string): boolean => {
  const trimmed = line.trim();
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
};

const logCodexJsonParseWarning = (
  context: string,
  line: string,
  error: unknown,
): void => {
  const detail = error instanceof Error ? error.message : String(error);
  const preview = line.length > 180 ? `${line.slice(0, 180)}...` : line;
  console.error(
    `[adapter.codex] Failed to parse JSON (${context}): ${detail}; line='${preview}'`,
  );
};

export const extractCodexThreadId = (line: string): string | null => {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (
      parsed.type === "thread.started" &&
      typeof parsed.thread_id === "string" &&
      parsed.thread_id.length > 0
    ) {
      return parsed.thread_id;
    }
  } catch (error: unknown) {
    if (looksLikeJsonPayload(trimmed)) {
      logCodexJsonParseWarning("thread id extraction", trimmed, error);
    }
    return null;
  }

  return null;
};

export const shouldRestartCodexInteractiveRunner = (
  hasRunner: boolean,
  runnerClosed: boolean,
  currentCwd: string | null,
  requestedCwd: string,
  currentSessionId: string | null,
  requestedSessionId: string | null,
): boolean => {
  if (!hasRunner) {
    return true;
  }
  if (runnerClosed) {
    return true;
  }
  if (currentCwd !== requestedCwd) {
    return true;
  }
  if (requestedSessionId === null) {
    return currentSessionId !== null;
  }
  return currentSessionId !== requestedSessionId;
};

export const shouldConsumeCodexDelta = (
  currentSource: CodexDeltaSource | null,
  incomingSource: CodexDeltaSource,
): boolean => currentSource === null || currentSource === incomingSource;

const buildPrompt = (input: AgentInput): string =>
  input.messages
    .map((message) => `[${message.author}] ${message.text}`)
    .join("\n\n")
    .slice(-20000);

const parseChunkToText = (raw: string): string => {
  const lines = raw.split(/\r?\n/);
  const parts: string[] = [];
  for (const line of lines) {
    const text = extractTextFromJsonLine(line);
    if (text) {
      parts.push(text);
    }
  }
  return parts.join("\n");
};

const classifyCodexProcessError = (stderr: string): "SESSION_EXPIRED" | "PROCESS_CRASH" => {
  const normalized = stderr.toLowerCase();
  if (
    /session|thread|resume/.test(normalized) &&
    /(expired|not found|unknown|invalid|missing)/.test(normalized)
  ) {
    return "SESSION_EXPIRED";
  }
  return "PROCESS_CRASH";
};

const classifyCodexInteractiveError = (message: string): ErrorClass => {
  const normalized = message.toLowerCase();
  if (normalized.includes("timeout")) {
    return "TIMEOUT";
  }
  if (
    /session|thread|resume/.test(normalized) &&
    /(expired|not found|unknown|invalid|missing)/.test(normalized)
  ) {
    return "SESSION_EXPIRED";
  }
  if (normalized.includes("protocol")) {
    return "PROTOCOL_ERROR";
  }
  return "PROCESS_CRASH";
};

const readStringField = (
  obj: Record<string, unknown>,
  key: string,
): string | null => {
  const value = obj[key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return null;
};
