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
  /**
   * The CLI has said its answer is ready (Codex `turn.completed`, Claude `result`). The turn is over from
   * there: the process is given `readyGraceMs` to exit by itself, then its whole group is taken down — the
   * result comes once the group is gone, so nothing it still writes can land after the turn's snapshot.
   */
  readyWhen?: (value: Record<string, unknown>) => boolean;
  readyGraceMs?: number;
}

export interface JsonlProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** `readyWhen` fired: the exit code and signal say nothing about the answer. */
  ready: boolean;
  spawnError?: Error;
}

const STDERR_LIMIT = 64 * 1024;
const KILL_GRACE_MS = 3000;

/** Remove lone UTF-16 surrogates, which some CLIs reject in prompts. */
export const stripLoneSurrogates = (text: string): string =>
  text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");

export interface JsonlChildOptions {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onJson: (value: Record<string, unknown>) => void;
  onText?: (line: string) => void;
}

export interface JsonlChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: Error;
}

/** A spawned CLI whose stdout is read as JSON lines and whose stdin stays open until the caller ends it. */
export interface JsonlChild {
  readonly pid: number | undefined;
  /** True once the process is gone (or never started). */
  readonly exited: boolean;
  /** Resolves when the process has exited and its output is read. */
  readonly whenExited: Promise<JsonlChildExit>;
  stderr(): string;
  /** Write one JSON line to stdin. */
  send(value: unknown): void;
  /** Write raw text to stdin and close it. */
  end(text?: string): void;
  /** SIGTERM to the whole group, SIGKILL after a grace period. */
  terminate(): void;
}

/**
 * Spawn a CLI that prints JSON lines on stdout. The child gets its own process
 * group so that stop/timeout can take down the whole tree (shells, tools).
 */
export const spawnJsonlChild = (options: JsonlChildOptions): JsonlChild => {
  let stderr = "";
  let killTimer: NodeJS.Timeout | undefined;
  let exited = false;
  let settle!: (exit: JsonlChildExit) => void;
  const whenExited = new Promise<JsonlChildExit>((resolvePromise) => {
    settle = resolvePromise;
  });

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

  const finish = (exit: JsonlChildExit) => {
    if (exited) return;
    exited = true;
    // The process group is gone; a late SIGKILL could hit a new group that reused its id.
    if (killTimer) clearTimeout(killTimer);
    settle(exit);
  };
  child.on("error", (error) => finish({ code: null, signal: null, spawnError: error }));
  child.on("close", (code, sig) => finish({ code, signal: sig }));

  return {
    pid: child.pid,
    get exited() {
      return exited;
    },
    whenExited,
    stderr: () => stderr,
    send(value) {
      if (exited || child.stdin.destroyed || !child.stdin.writable) return;
      child.stdin.write(`${stripLoneSurrogates(JSON.stringify(value))}\n`);
    },
    end(text) {
      if (text !== undefined) child.stdin.end(stripLoneSurrogates(text));
      else child.stdin.end();
    },
    terminate() {
      if (exited) return;
      killTree("SIGTERM");
      if (killTimer) clearTimeout(killTimer);
      killTimer = setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    },
  };
};

/** Run a CLI for one turn: prompt on stdin, JSON lines out, until it exits, is stopped, or says it is ready. */
export const runJsonlProcess = (options: JsonlProcessOptions): Promise<JsonlProcessResult> =>
  new Promise((resolvePromise) => {
    let timedOut = false;
    let aborted = false;
    let ready = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let readyTimer: NodeJS.Timeout | undefined;

    const child = spawnJsonlChild({
      bin: options.bin,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      onText: options.onText,
      onJson: (event) => {
        options.onJson(event);
        if (ready || !options.readyWhen?.(event)) return;
        ready = true;
        // The turn is done: a slow shutdown is not a timeout.
        if (timeoutTimer) clearTimeout(timeoutTimer);
        const grace = options.readyGraceMs ?? 0;
        if (grace > 0) {
          readyTimer = setTimeout(() => child.terminate(), grace);
          readyTimer.unref();
        } else {
          child.terminate();
        }
      },
    });

    const onAbort = () => {
      aborted = true;
      child.terminate();
    };

    void child.whenExited.then((exit) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (readyTimer) clearTimeout(readyTimer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ ...exit, stderr: child.stderr(), timedOut, aborted, ready });
    });

    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        child.terminate();
      }, Math.min(options.timeoutMs, 2 ** 31 - 1));
      timeoutTimer.unref();
    }

    if (options.stdin !== undefined) child.end(options.stdin);
    else child.end();
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
