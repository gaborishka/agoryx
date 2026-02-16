import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { setTimeout as wait } from "node:timers/promises";
import type { Adapter, AdapterStatus, AgentInput } from "../adapter.js";
import {
  messageCompleted,
  messageDelta,
  messageError,
  messageStarted,
} from "../event-factory.js";
import { extractTextFromJsonLine } from "../parse-output.js";
import { createId } from "../../session/ids.js";

const SOURCE = "adapter.claude";
type SpawnedProcess = ChildProcessByStdio<null, Readable, Readable>;

export class ClaudeAdapter implements Adapter {
  public readonly name = "claude";
  private readonly running = new Map<string, SpawnedProcess>();
  private status: AdapterStatus = "ready";

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

    this.status = "busy";
    const prompt = buildPrompt(input);
    const child = spawn("claude", ["-p", prompt, "--output-format", "stream-json"], {
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
          "claude request timed out",
          stderr,
        );
      } else if (exitCode !== 0) {
        yield messageError(
          baseArgs(input),
          "PROCESS_CRASH",
          `claude process exited with code ${String(exitCode)}`,
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
        error instanceof Error ? error.message : "unknown claude adapter failure",
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
    if (this.status !== "ready") {
      return this.status;
    }
    if (process.env.ANTHROPIC_API_KEY) {
      // This is informational and does not block operation.
      return "ready";
    }
    return "ready";
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

const baseArgs = (input: AgentInput) => ({
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
