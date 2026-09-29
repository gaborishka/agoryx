import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { trackAgentProcess } from "../agentprocs.js";

export interface JsonlProcessOptions {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onJson: (value: Record<string, unknown>) => void;
  onText?: (line: string) => void;
}

export interface JsonlProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: Error;
}

const STDERR_LIMIT = 64 * 1024;
const KILL_GRACE_MS = 3000;

/** Remove lone UTF-16 surrogates, which some CLIs reject in prompts. */
export const stripLoneSurrogates = (text: string): string =>
  text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");

/**
 * Spawn a CLI that prints JSON lines on stdout. The child gets its own process
 * group so that stop/timeout can take down the whole tree (shells, tools).
 */
export const runJsonlProcess = (options: JsonlProcessOptions): Promise<JsonlProcessResult> =>
  new Promise((resolvePromise) => {
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;

    const child = spawn(options.bin, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    trackAgentProcess(child.pid, options.env);

    const killTree = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          // already gone
        }
      }
    };

    const terminate = () => {
      killTree("SIGTERM");
      if (killTimer) clearTimeout(killTimer);
      killTimer = setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    };

    const onAbort = () => {
      aborted = true;
      terminate();
    };

    const finish = (result: Omit<JsonlProcessResult, "stderr" | "timedOut" | "aborted">) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      // The process group is gone; a late SIGKILL could hit a new group that reused its id.
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ ...result, stderr, timedOut, aborted });
    };

    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, Math.min(options.timeoutMs, 2 ** 31 - 1));
      timeoutTimer.unref();
    }

    const decoder = new StringDecoder("utf8");
    let carry = "";
    const handleLine = (raw: string) => {
      const line = raw.trim();
      if (!line) return;
      if (line.startsWith("{")) {
        try {
          options.onJson(JSON.parse(line) as Record<string, unknown>);
          return;
        } catch {
          // fall through to text
        }
      }
      options.onText?.(line);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      carry += decoder.write(chunk);
      let index = carry.indexOf("\n");
      while (index !== -1) {
        handleLine(carry.slice(0, index));
        carry = carry.slice(index + 1);
        index = carry.indexOf("\n");
      }
    });
    child.stdout.on("end", () => {
      carry += decoder.end();
      if (carry) handleLine(carry);
      carry = "";
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk.toString("utf8");
    });
    // EPIPE when the child exits before reading stdin must not crash us.
    child.stdin.on("error", () => {});
    child.on("error", (error) => finish({ code: null, signal: null, spawnError: error }));
    child.on("close", (code, sig) => finish({ code, signal: sig }));

    if (options.stdin !== undefined) child.stdin.end(stripLoneSurrogates(options.stdin));
    else child.stdin.end();
  });

/** Classify CLI failures into something a human can act on. */
export const classifyFailure = (text: string): "rate_limit" | "auth" | "context" | "session" | "unknown" => {
  const lower = text.toLowerCase();
  if (/rate.?limit|usage limit|too many requests|429|quota|overloaded/.test(lower)) return "rate_limit";
  if (/not logged in|unauthori[sz]ed|401|authenticat|login required|invalid api key|please run .*login/.test(lower)) return "auth";
  if (/context (window|length)|too long|prompt is too long|maximum context|token limit/.test(lower)) return "context";
  if (/no conversation found|session .*not found|thread .*not found|no rollout found|could not find session|unknown session/.test(lower)) return "session";
  return "unknown";
};

export const lastLines = (text: string, count = 6): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-count)
    .join("\n");
