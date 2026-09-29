import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { classifyFailure, lastLines, runJsonlProcess } from "./process.js";
import {
  shellQuote,
  truncate,
  type AgentRunner,
  type TurnCallbacks,
  type TurnRequest,
  type TurnResult,
} from "./types.js";
import type { Activity, TurnUsage } from "../types.js";

type Json = Record<string, unknown>;

const asObject = (value: unknown): Json | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * Codex always runs inside its own sandbox: workspace-write (or read-only),
 * never with approvals/sandbox bypass.
 */
export const buildCodexArgs = (request: TurnRequest): string[] => {
  const sandbox = request.settings.access === "readonly" ? "read-only" : "workspace-write";
  const common = ["--json", "--skip-git-repo-check"];
  if (request.model) common.push("-m", request.model);
  if (request.effort) common.push("-c", `model_reasoning_effort="${request.effort}"`);
  if (request.settings.network && sandbox === "workspace-write") {
    common.push("-c", "sandbox_workspace_write.network_access=true");
  }
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
      return {
        kind: "command",
        label: truncate(unwrapShellCommand(str(item.command) ?? ""), 800),
        status: status === "in_progress" ? "running" : failed ? "fail" : "ok",
        ...(failed && output ? { detail: truncate(output, 240) } : {}),
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
    case "mcp_tool_call":
      return {
        kind: "tool",
        label: `${str(item.server) ?? "mcp"}.${str(item.tool) ?? "tool"}`,
        status: str(item.status) === "in_progress" ? "running" : str(item.status) === "failed" ? "fail" : "ok",
      };
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

export const createCodexRunner = (bin = process.env.AGORYX_CODEX_BIN || "codex"): AgentRunner => ({
  kind: "codex",

  resumeCommand(sessionId: string, cwd: string, model?: string): string {
    return `cd ${shellQuote(cwd)} && ${shellQuote(bin)} resume ${shellQuote(sessionId)}${model ? ` -m ${shellQuote(model)}` : ""}`;
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
    if (outcome.timedOut) {
      return {
        status: "error",
        text: lastMessage ?? "",
        sessionId: threadId,
        error: { kind: "timeout", message: `turn exceeded ${Math.round(request.settings.turnTimeoutMs / 60000)} min` },
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
