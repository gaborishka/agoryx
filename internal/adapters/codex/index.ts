import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
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

const SOURCE = "adapter.codex";
type SpawnedProcess = ChildProcessByStdio<null, Readable, Readable>;

export class CodexAdapter implements PersistentAdapter {
  public readonly name = "codex";
  private readonly running = new Map<string, SpawnedProcess>();
  private status: AdapterStatus = "ready";

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

    this.status = "busy";
    const prompt = buildPrompt(input);
    const child = spawn("codex", buildCodexSpawnArgs(prompt, null), {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    this.running.set(input.requestId, child);

    let stderr = "";
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, input.config.timeoutMs);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    try {
      for await (const chunk of child.stdout) {
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

      const exitCode = await new Promise<number | null>((resolve) => {
        child.once("close", resolve);
      });

      if (timedOut) {
        yield messageError(
          baseArgs(input),
          "TIMEOUT",
          "codex request timed out",
          stderr,
        );
      } else if (exitCode !== 0) {
        yield messageError(
          baseArgs(input),
          classifyCodexProcessError(stderr),
          `codex process exited with code ${String(exitCode)}`,
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
        "UNKNOWN",
        error instanceof Error ? error.message : "unknown codex adapter failure",
        stderr,
      );
    } finally {
      clearTimeout(timer);
      this.running.delete(input.requestId);
      this.status = "ready";
    }
  }

  public async *sendTurn(input: SendTurnInput) {
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

    this.status = "busy";
    const child = spawn(
      "codex",
      buildCodexSpawnArgs(input.prompt, input.nativeSessionId),
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      },
    );
    this.running.set(input.requestId, child);

    let stderr = "";
    let output = "";
    let timedOut = false;
    let emittedThreadId: string | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, input.config.timeoutMs);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    try {
      for await (const chunk of child.stdout) {
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

      const exitCode = await new Promise<number | null>((resolve) => {
        child.once("close", resolve);
      });

      if (timedOut) {
        yield messageError(
          baseArgs(input),
          "TIMEOUT",
          "codex request timed out",
          stderr,
        );
      } else if (exitCode !== 0) {
        yield messageError(
          baseArgs(input),
          classifyCodexProcessError(stderr),
          `codex process exited with code ${String(exitCode)}`,
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
        "UNKNOWN",
        error instanceof Error ? error.message : "unknown codex adapter failure",
        stderr,
      );
    } finally {
      clearTimeout(timer);
      this.running.delete(input.requestId);
      this.status = "ready";
    }
  }

  public async cancel(requestId: string): Promise<void> {
    const proc = this.running.get(requestId);
    if (!proc) {
      return;
    }
    proc.kill("SIGTERM");
    this.running.delete(requestId);
    this.status = "ready";
  }

  public async health(): Promise<AdapterStatus> {
    return this.status;
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
  } catch {
    return null;
  }

  return null;
};

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
