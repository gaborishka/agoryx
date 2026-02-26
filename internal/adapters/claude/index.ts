import { spawn, type ChildProcessByStdio } from "node:child_process";
import { tmpdir } from "node:os";
import type { Readable, Writable } from "node:stream";
import { setTimeout as wait } from "node:timers/promises";
import type {
  AdapterMode,
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

const SOURCE = "adapter.claude";
const STDERR_BUFFER_MAX = 16_000;
const STDERR_SNAPSHOT_SIZE = 8_000;
type OneShotProcess = ChildProcessByStdio<null, Readable, Readable>;
type InteractiveProcess = ChildProcessByStdio<Writable, Readable, Readable>;

interface ClaudeInteractiveTurnResult {
  text: string;
  sessionId: string | null;
}

interface ClaudeInteractiveStreamItem {
  type: "delta" | "session.bound";
  text?: string;
  sessionId?: string;
}

interface ClaudeInteractiveTurn {
  requestId: string;
  output: string;
  resultText: string | null;
  idleTimeout: ReturnType<typeof createIdleTimeoutController>;
  onDelta: (text: string) => void;
  onSessionId: (sessionId: string) => void;
  resolve: (result: ClaudeInteractiveTurnResult) => void;
  reject: (error: Error) => void;
}

export class ClaudeAdapter implements PersistentAdapter {
  public readonly name = "claude";
  private readonly running = new Map<string, OneShotProcess>();
  private readonly interactiveRequestIds = new Set<string>();
  private status: AdapterStatus = "ready";
  private activeRequests = 0;
  private interactiveRunner: ClaudeInteractiveRunner | null = null;
  private interactiveSessionId: string | null = null;
  private interactiveCwd: string | null = null;

  public async *send(input: AgentInput) {
    const messageId = createId("msg");
    const startedPayload = {
      messageId,
      author: "agent.claude",
      role: "assistant" as const,
      text: "",
      format: "markdown" as const,
      metadata: {
        provider: "anthropic",
        model: "claude-code",
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
    const child = spawn("claude", buildClaudeSpawnArgs(prompt, null), {
      stdio: ["ignore", "pipe", "pipe"],
      env: buildClaudeSpawnEnv(process.env),
      cwd: buildClaudeSpawnCwd(process.env, input.config.mode, input.config.workspaceCwd),
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
      let resultText: string | null = null;
      for await (const chunk of child.stdout) {
        idleTimeout.touch();
        const parsedChunk = parseClaudeChunk(chunk.toString("utf8"));
        if (parsedChunk.resultText) {
          resultText = parsedChunk.resultText;
        }

        if (parsedChunk.deltaParts.length === 0) {
          continue;
        }

        const chunkParts = parsedChunk.deltaParts.map((part, index) =>
          index === 0 ? part : `\n${part}`,
        );
        for (const text of chunkParts) {
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
          "claude request timed out",
          stderr,
        );
      } else if (processResult.type === "error") {
        yield messageError(
          baseArgs(input),
          "PROCESS_CRASH",
          `claude process failed to start: ${processResult.message}`,
          stderr,
        );
      } else if (processResult.exitCode !== 0) {
        yield messageError(
          baseArgs(input),
          classifyClaudeProcessError(stderr),
          `claude process exited with code ${String(processResult.exitCode)}`,
          stderr,
        );
      } else {
        yield messageCompleted(baseArgs(input), {
          ...startedPayload,
          text: output.trim() || resultText?.trim() || "(no content)",
        });
      }
    } catch (error) {
      yield messageError(
        baseArgs(input),
        spawnFailureMessage ? "PROCESS_CRASH" : "UNKNOWN",
        spawnFailureMessage
          ? `claude process failed to start: ${spawnFailureMessage}`
          : error instanceof Error
          ? error.message
          : "unknown claude adapter failure",
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
      author: "agent.claude",
      role: "assistant" as const,
      text: "",
      format: "markdown" as const,
      metadata: {
        provider: "anthropic",
        model: "claude-code",
        requestId: input.requestId,
      },
    };

    yield messageStarted(baseArgs(input), startedPayload);

    const child = spawn("claude", buildClaudeSpawnArgs(input.prompt, input.nativeSessionId), {
      stdio: ["ignore", "pipe", "pipe"],
      env: buildClaudeSpawnEnv(process.env),
      cwd: buildClaudeSpawnCwd(process.env, input.config.mode, input.config.workspaceCwd),
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
    let resultText: string | null = null;
    let emittedSessionId: string | null = null;
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
        const raw = chunk.toString("utf8");
        const lines = raw.split(/\r?\n/);
        for (const line of lines) {
          const sessionId = extractClaudeSessionId(line);
          if (sessionId && sessionId !== emittedSessionId) {
            emittedSessionId = sessionId;
            yield sessionBound(baseArgs(input), sessionId);
          }
        }

        const parsedChunk = parseClaudeChunk(raw);
        if (parsedChunk.resultText) {
          resultText = parsedChunk.resultText;
        }
        if (parsedChunk.deltaParts.length === 0) {
          continue;
        }

        const chunkParts = parsedChunk.deltaParts.map((part, index) =>
          index === 0 ? part : `\n${part}`,
        );
        for (const text of chunkParts) {
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
          "claude request timed out",
          stderr,
        );
      } else if (processResult.type === "error") {
        yield messageError(
          baseArgs(input),
          "PROCESS_CRASH",
          `claude process failed to start: ${processResult.message}`,
          stderr,
        );
      } else if (processResult.exitCode !== 0) {
        yield messageError(
          baseArgs(input),
          classifyClaudeProcessError(stderr),
          `claude process exited with code ${String(processResult.exitCode)}`,
          stderr,
        );
      } else {
        yield messageCompleted(baseArgs(input), {
          ...startedPayload,
          text: output.trim() || resultText?.trim() || "(no content)",
        });
      }
    } catch (error) {
      yield messageError(
        baseArgs(input),
        spawnFailureMessage ? "PROCESS_CRASH" : "UNKNOWN",
        spawnFailureMessage
          ? `claude process failed to start: ${spawnFailureMessage}`
          : error instanceof Error
          ? error.message
          : "unknown claude adapter failure",
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
      author: "agent.claude",
      role: "assistant" as const,
      text: "",
      format: "markdown" as const,
      metadata: {
        provider: "anthropic",
        model: "claude-code",
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
        this.interactiveSessionId = preBoundSessionId;
        yield sessionBound(baseArgs(input), preBoundSessionId);
      }

      const queue = new AsyncQueue<ClaudeInteractiveStreamItem>();
      this.interactiveRequestIds.add(input.requestId);

      const turnPromise = runner
        .sendTurn({
          prompt: input.prompt,
          requestId: input.requestId,
          timeoutMs: input.config.timeoutMs,
          onDelta: (text) => {
            queue.push({ type: "delta", text });
          },
          onSessionId: (sessionId) => {
            if (
              sessionId !== preBoundSessionId &&
              sessionId !== input.nativeSessionId
            ) {
              queue.push({ type: "session.bound", sessionId });
            }
          },
        })
        .then((result) => {
          if (
            result.sessionId &&
            result.sessionId !== preBoundSessionId &&
            result.sessionId !== input.nativeSessionId
          ) {
            queue.push({ type: "session.bound", sessionId: result.sessionId });
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
          classifyClaudeInteractiveError(turnOutcome.error.message),
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
        error instanceof Error ? error.message : "unknown claude interactive failure",
      );
    } finally {
      this.interactiveRequestIds.delete(input.requestId);
      this.markRequestEnd();
    }
  }

  private async ensureInteractiveRunner(
    nativeSessionId: string | null,
    workspaceCwd?: string,
  ): Promise<ClaudeInteractiveRunner> {
    const cwd = buildClaudeSpawnCwd(process.env, "agentic", workspaceCwd);

    const needsRestart = shouldRestartClaudeInteractiveRunner(
      this.interactiveRunner !== null,
      this.interactiveRunner?.isClosed() ?? false,
      this.interactiveCwd,
      cwd,
      this.interactiveSessionId,
      nativeSessionId,
    );

    if (needsRestart) {
      await this.disposeInteractiveRunner();
      const runner = new ClaudeInteractiveRunner(
        cwd,
        buildClaudeSpawnEnv(process.env),
        nativeSessionId,
      );
      this.interactiveRunner = runner;
      this.interactiveSessionId = runner.sessionId();
      this.interactiveCwd = cwd;
      return runner;
    }

    if (!this.interactiveRunner) {
      throw new Error("interactive claude runner is not available");
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
        "claude interactive turn cancelled",
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
      `[adapter.claude] waitForRequestCleanup timed out after ${timeoutMs}ms for request ${requestId}`,
    );
    return false;
  }

  private stubText(input: AgentInput): string {
    const lastUserMessage = [...input.messages]
      .reverse()
      .find((message) => message.role === "user");
    const prompt = lastUserMessage?.text ?? "(empty prompt)";
    return [
      "[stub/claude] I reviewed your latest input.",
      `Prompt preview: ${prompt.slice(0, 180)}`,
      "Integration mode is currently STUB. Switch adapter mode to CLI to run claude directly.",
    ].join("\n");
  }
}

class ClaudeInteractiveRunner {
  private readonly child: InteractiveProcess;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private closed = false;
  private sessionIdValue: string | null;
  private activeTurn: ClaudeInteractiveTurn | null = null;

  public constructor(
    cwd: string,
    env: NodeJS.ProcessEnv,
    nativeSessionId: string | null,
  ) {
    this.sessionIdValue = nativeSessionId;
    this.child = spawn("claude", buildClaudeInteractiveSpawnArgs(nativeSessionId), {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd,
    });

    this.child.stdout.on("data", (chunk: Buffer) => {
      this.consumeStdout(chunk.toString("utf8"));
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBuffer += chunk.toString("utf8");
      if (this.stderrBuffer.length > STDERR_BUFFER_MAX) {
        this.stderrBuffer = this.stderrBuffer.slice(-STDERR_SNAPSHOT_SIZE);
      }
      this.activeTurn?.idleTimeout.touch();
    });
    this.child.once("close", (code) => {
      this.handleClose(code);
    });
    this.child.once("error", (error) => {
      this.handleFatal(error instanceof Error ? error : new Error(String(error)));
    });
  }

  public sessionId(): string | null {
    return this.sessionIdValue;
  }

  public async sendTurn(input: {
    prompt: string;
    requestId: string;
    timeoutMs: number;
    onDelta: (text: string) => void;
    onSessionId: (sessionId: string) => void;
  }): Promise<ClaudeInteractiveTurnResult> {
    if (this.closed) {
      throw new Error("PROCESS_CRASH: claude interactive process is closed");
    }
    if (this.activeTurn) {
      throw new Error("PROTOCOL_ERROR: claude interactive turn overlap is not supported");
    }

    const timeoutMs = normalizeInteractiveTimeoutMs(input.timeoutMs);
    const turnPromise = new Promise<ClaudeInteractiveTurnResult>((resolve, reject) => {
      this.activeTurn = {
        requestId: input.requestId,
        output: "",
        resultText: null,
        idleTimeout: createIdleTimeoutController(timeoutMs, () => {
          void this.cancelActiveTurn("TIMEOUT: claude interactive request timed out");
        }),
        onDelta: input.onDelta,
        onSessionId: input.onSessionId,
        resolve,
        reject,
      };
    });

    const line = JSON.stringify(buildClaudeInteractiveInput(input.prompt));
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(`${line}\n`, (error) => {
        if (!error) {
          resolve();
          return;
        }
        reject(
          error instanceof Error
            ? error
            : new Error("PROCESS_CRASH: failed to write claude interactive request"),
        );
      });
    }).catch((error) => {
      this.rejectActiveTurn(
        error instanceof Error
          ? error
          : new Error("PROCESS_CRASH: failed to send claude interactive request"),
      );
      throw error;
    });

    return turnPromise;
  }

  public async cancelActiveTurn(reason: string): Promise<void> {
    const activeTurn = this.activeTurn;
    if (!activeTurn) {
      return;
    }

    this.activeTurn = null;
    activeTurn.idleTimeout.clear();

    await new Promise<void>((resolve) => {
      const control = JSON.stringify({ type: "control", signal: "interrupt" });
      this.child.stdin.write(`${control}\n`, () => {
        resolve();
      });
    }).catch((error: unknown) => {
      this.closed = true;
      console.error(
        `[adapter.claude] interrupt write failed, marking runner closed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

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
    this.closed = true;

    if (this.activeTurn) {
      this.activeTurn.idleTimeout.clear();
      this.activeTurn.reject(
        new Error("PROCESS_CRASH: claude interactive process was shut down"),
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

    const sessionId = extractClaudeSessionId(line);
    if (sessionId) {
      this.sessionIdValue = sessionId;
      this.activeTurn?.onSessionId(sessionId);
    }

    const parsed = tryParseJsonObject(line, "interactive line");
    if (!parsed || !this.activeTurn) {
      return;
    }

    if (parsed.type === "error") {
      const message =
        extractTextFromUnknown(parsed.error) ||
        extractTextFromUnknown(parsed.message) ||
        "claude interactive error";
      this.rejectActiveTurn(new Error(`PROCESS_CRASH: ${message}`));
      return;
    }

    const chunk = parseClaudeChunk(line);
    for (const part of chunk.deltaParts) {
      this.activeTurn.output += part;
      this.activeTurn.onDelta(part);
    }
    if (chunk.resultText) {
      this.activeTurn.resultText = chunk.resultText;
    }

    if (isClaudeResultEvent(parsed)) {
      const activeTurn = this.activeTurn;
      this.activeTurn = null;
      activeTurn.idleTimeout.clear();
      activeTurn.resolve({
        text: activeTurn.resultText?.trim() || activeTurn.output.trim() || "(no content)",
        sessionId: this.sessionIdValue,
      });
    }
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
    this.handleFatal(new Error(`PROCESS_CRASH: claude interactive process closed${suffix}`));
  }

  private handleFatal(error: Error): void {
    this.rejectActiveTurn(error);
  }
}

const baseArgs = (input: { roomId: string; sessionId: string; requestId: string }) => ({
  roomId: input.roomId,
  sessionId: input.sessionId,
  requestId: input.requestId,
  source: SOURCE,
});

const buildPrompt = (input: AgentInput): string =>
  input.messages
    .map((message) => `[${message.author}] ${message.text}`)
    .join("\n\n")
    .slice(-20000);

const MIN_INTERACTIVE_TIMEOUT_MS = 1_000;

export const normalizeInteractiveTimeoutMs = (timeoutMs: number): number => {
  if (!Number.isFinite(timeoutMs)) {
    return MIN_INTERACTIVE_TIMEOUT_MS;
  }
  return Math.max(MIN_INTERACTIVE_TIMEOUT_MS, Math.trunc(timeoutMs));
};

export const buildClaudeSpawnArgs = (
  prompt: string,
  nativeSessionId: string | null = null,
): string[] => [
  ...(nativeSessionId ? ["--resume", nativeSessionId] : []),
  "-p",
  prompt,
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
];

export const buildClaudeInteractiveSpawnArgs = (
  nativeSessionId: string | null = null,
): string[] => [
  ...(nativeSessionId ? ["--resume", nativeSessionId] : []),
  "--print",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
];

export const buildClaudeInteractiveInput = (prompt: string): Record<string, unknown> => ({
  type: "user",
  message: {
    role: "user",
    content: [
      {
        type: "text",
        text: prompt,
      },
    ],
  },
});

export const buildClaudeSpawnEnv = (
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  const sanitized = { ...env };
  delete sanitized.CLAUDECODE;
  return sanitized;
};

export const buildClaudeSpawnCwd = (
  env: NodeJS.ProcessEnv,
  mode: AdapterMode = "cli",
  workspaceCwd?: string,
): string => {
  if (mode === "agentic") {
    return workspaceCwd?.trim() || process.cwd();
  }
  const overridden = env.AGORYX_CLAUDE_CWD?.trim();
  if (overridden) {
    return overridden;
  }
  return tmpdir();
};

export const parseClaudeChunk = (
  raw: string,
): { deltaParts: string[]; resultText: string | null } => {
  const lines = raw.split(/\r?\n/);
  const parts: string[] = [];
  let resultText: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const maybeObject = tryParseJsonObject(trimmed);
    if (!maybeObject) {
      continue;
    }

    if (isClaudeResultEvent(maybeObject)) {
      const extracted = extractTextFromUnknown(
        (maybeObject as Record<string, unknown>).result,
      );
      if (extracted) {
        resultText = extracted;
      }
      continue;
    }

    if ((maybeObject as Record<string, unknown>).type === "stream_event") {
      const extracted = extractTextFromUnknown(
        (maybeObject as Record<string, unknown>).event,
      );
      if (extracted) {
        parts.push(extracted);
      }
      continue;
    }

    const text = extractTextFromJsonLine(trimmed);
    if (text) {
      parts.push(text);
    }
  }

  return {
    deltaParts: parts,
    resultText,
  };
};

export const extractClaudeSessionId = (line: string): string | null => {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = tryParseJsonObject(trimmed);
  if (!parsed) {
    return null;
  }

  const type = parsed.type;
  if (typeof type !== "string") {
    return null;
  }

  // Ignore hook/session bootstrap events that may carry a different internal id.
  if (type === "system") {
    if (parsed.subtype !== "init") {
      return null;
    }
    return readTopLevelSessionId(parsed);
  }

  if (type === "stream_event" || type === "assistant" || type === "result") {
    return readTopLevelSessionId(parsed);
  }

  return null;
};

export const shouldRestartClaudeInteractiveRunner = (
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

const tryParseJsonObject = (
  line: string,
  context?: string,
): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (error: unknown) {
    if (context && looksLikeJsonPayload(line)) {
      logClaudeJsonParseWarning(context, line, error);
    }
    return null;
  }
};

const looksLikeJsonPayload = (line: string): boolean => {
  const trimmed = line.trim();
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
};

const logClaudeJsonParseWarning = (
  context: string,
  line: string,
  error: unknown,
): void => {
  const detail = error instanceof Error ? error.message : String(error);
  const preview = line.length > 180 ? `${line.slice(0, 180)}...` : line;
  console.error(
    `[adapter.claude] Failed to parse JSON (${context}): ${detail}; line='${preview}'`,
  );
};

const isClaudeResultEvent = (value: unknown): boolean => {
  if (!value || typeof value !== "object") {
    return false;
  }
  return (value as Record<string, unknown>).type === "result";
};

const extractTextFromUnknown = (value: unknown): string | null => {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => extractTextFromUnknown(item))
      .filter((item): item is string => Boolean(item));
    return parts.length > 0 ? parts.join("") : null;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const obj = value as Record<string, unknown>;
  const candidates = [
    obj.delta,
    obj.text,
    obj.value,
    obj.result,
    obj.event,
    obj.data,
    obj.content,
    obj.message,
    obj.item,
    obj.output_text,
  ];
  for (const candidate of candidates) {
    const text = extractTextFromUnknown(candidate);
    if (text) {
      return text;
    }
  }

  return null;
};

const readTopLevelSessionId = (obj: Record<string, unknown>): string | null => {
  const keys = [
    "session_id",
    "sessionId",
    "conversation_id",
    "conversationId",
    "thread_id",
    "threadId",
  ] as const;
  for (const key of keys) {
    const candidate = obj[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return null;
};

const classifyClaudeProcessError = (
  stderr: string,
): "SESSION_EXPIRED" | "PROCESS_CRASH" => {
  const normalized = stderr.toLowerCase();
  if (
    /session|conversation|thread|resume/.test(normalized) &&
    /(expired|not found|unknown|invalid|missing)/.test(normalized)
  ) {
    return "SESSION_EXPIRED";
  }
  return "PROCESS_CRASH";
};

const classifyClaudeInteractiveError = (message: string): ErrorClass => {
  const normalized = message.toLowerCase();
  if (normalized.includes("timeout")) {
    return "TIMEOUT";
  }
  if (
    /session|conversation|thread|resume/.test(normalized) &&
    /(expired|not found|unknown|invalid|missing)/.test(normalized)
  ) {
    return "SESSION_EXPIRED";
  }
  if (normalized.includes("protocol")) {
    return "PROTOCOL_ERROR";
  }
  return "PROCESS_CRASH";
};
