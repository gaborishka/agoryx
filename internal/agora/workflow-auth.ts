import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentKind } from "./types.js";

export interface WorkflowCredentials { accessToken: string; accountId?: string }
export interface WorkflowAuthentication {
  current(): WorkflowCredentials | null;
  recover(rejectedToken: string, signal: AbortSignal): Promise<WorkflowCredentials | null>;
  invalidate(rejectedToken: string): void;
}
const fingerprint = (token: string) => createHash("sha256").update(token).digest("hex");
const failed = new Map<string, string>();
interface Refresh { controller: AbortController; promise: Promise<void>; waiters: number }
const refreshing = new Map<string, Refresh>();
export const workflowAuthKey = (kind: AgentKind, env: NodeJS.ProcessEnv): string => `${kind}:${kind === "codex" ? env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex") : env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude")}:${kind === "claude" && env.CLAUDE_CODE_OAUTH_TOKEN ? "static-env" : "native"}`;
export const workflowAuthBlocked = (key: string, token: string): boolean => failed.get(key) === fingerprint(token);

/** Coalesce same-account refreshes. Individual worker cancellation must not cancel other
 * waiting workers; when the last one leaves, stop the bounded native helper too. */
export const createWorkflowAuthentication = (options: {
  key: string;
  read(): WorkflowCredentials | null;
  refresh(signal: AbortSignal): Promise<void>;
  canRefresh?: boolean;
}): WorkflowAuthentication => ({
  invalidate(rejectedToken) { failed.set(options.key, fingerprint(rejectedToken)); },
  current() {
    const credentials = options.read();
    return credentials && !workflowAuthBlocked(options.key, credentials.accessToken) ? credentials : null;
  },
  async recover(rejectedToken, signal) {
    if (signal.aborted) return null;
    let latest = options.read();
    if (latest && latest.accessToken !== rejectedToken) return workflowAuthBlocked(options.key, latest.accessToken) ? null : latest;
    if (workflowAuthBlocked(options.key, rejectedToken)) return null;
    if (options.canRefresh === false) { failed.set(options.key, fingerprint(rejectedToken)); return null; }
    let shared = refreshing.get(options.key);
    if (shared?.controller.signal.aborted) shared = undefined;
    if (!shared) {
      const controller = new AbortController();
      shared = { controller, waiters: 0, promise: Promise.resolve() };
      const entry = shared;
      shared.promise = Promise.resolve().then(() => options.refresh(controller.signal)).catch(() => {
        if (!controller.signal.aborted) failed.set(options.key, fingerprint(rejectedToken));
      }).finally(() => { if (refreshing.get(options.key) === entry) refreshing.delete(options.key); });
      refreshing.set(options.key, shared);
    }
    const entry = shared;
    entry.waiters++;
    let abort: (() => void) | undefined;
    try {
      await Promise.race([entry.promise, new Promise<void>((resolve) => {
        abort = resolve; signal.addEventListener("abort", abort, { once: true });
      })]);
      if (signal.aborted) return null;
      latest = options.read();
      if (!latest || latest.accessToken === rejectedToken) { failed.set(options.key, fingerprint(rejectedToken)); return null; }
      failed.delete(options.key);
      return latest;
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
      if (--entry.waiters === 0) entry.controller.abort();
    }
  },
});

export const nativeWorkflowAuthArgs = (kind: AgentKind): string[] => kind === "claude" ? [
  "--print", "--safe-mode", "--no-chrome", "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
  "--no-session-persistence", "--disable-slash-commands", "--settings", '{"disableAllHooks":true}', "--output-format", "json", "--system-prompt", "Reply exactly OK.",
] : [
  "app-server", "--stdio", "-c", "mcp_servers={}", "-c", "project_doc_max_bytes=0",
  ...["apps", "plugins", "hooks", "memories", "multi_agent", "browser_use", "computer_use", "image_generation"].flatMap((feature) => ["--disable", feature]),
];

/** Native clients own shared credential refresh; no refresh token is copied into a worker.
 * Codex uses only account/read (no thread or inference). Claude's supported CLI has no
 * refresh-only command, so a fixed, tool-free health turn performs its routine refresh. */
export const refreshNativeWorkflowAuth = async (kind: AgentKind, binary: string, source: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) throw new Error("Authentication refresh cancelled");
  const directory = mkdtempSync(join(tmpdir(), "agoryx-auth-refresh-"));
  const env: NodeJS.ProcessEnv = {
    HOME: source.HOME ?? homedir(), PATH: source.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin", USER: source.USER, LOGNAME: source.LOGNAME, __CF_USER_TEXT_ENCODING: source.__CF_USER_TEXT_ENCODING,
    LANG: "en_US.UTF-8", TERM: "dumb", NO_COLOR: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    ...(source.CODEX_HOME ? { CODEX_HOME: source.CODEX_HOME } : {}), ...(source.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: source.CLAUDE_CONFIG_DIR } : {}),
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, nativeWorkflowAuthArgs(kind), { cwd: directory, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
      let settled = false, buffer = "", size = 0, completed = false;
      const finish = (success: boolean) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
        try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already stopped */ }
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        if (success) resolve(); else reject(new Error("Native authentication refresh unavailable"));
      };
      const abort = () => finish(false);
      const timer = setTimeout(abort, 30000);
      signal.addEventListener("abort", abort, { once: true });
      child.on("error", abort); child.stdin.on("error", () => {});
      child.stderr.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 256 * 1024) finish(false); });
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length; if (size > 256 * 1024) { finish(false); return; }
        buffer += chunk.toString("utf8");
        for (;;) {
          const newline = buffer.indexOf("\n"); if (newline < 0) break;
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          let item: Record<string, any>; try { item = JSON.parse(line); } catch { continue; }
          if (kind === "claude" && item.type === "result") completed = item.is_error === false;
          if (kind === "codex" && item.id === 1) {
            if (item.error) { finish(false); return; }
            child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n${JSON.stringify({ id: 2, method: "account/read", params: { refreshToken: true } })}\n`);
          }
          if (kind === "codex" && item.id === 2) { finish(!item.error && item.result?.account?.type === "chatgpt"); return; }
        }
      });
      child.on("close", (code) => finish(code === 0 && completed));
      if (kind === "codex") child.stdin.write(`${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "agoryx-auth-refresh", version: "1" }, capabilities: null } })}\n`);
      else child.stdin.end("This is a local authentication health check. Reply OK.");
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
};
