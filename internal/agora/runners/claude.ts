import { randomUUID } from "node:crypto";
import { classifyFailure, lastLines, runJsonlProcess } from "./process.js";
import {
  shellQuote,
  truncate,
  type AgentRunner,
  type TurnCallbacks,
  type TurnRequest,
  type TurnResult,
} from "./types.js";
import type { Activity, ActivityKind, TurnUsage } from "../types.js";

type Json = Record<string, unknown>;

const asObject = (value: unknown): Json | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * Claude Code runs sandboxed: file edits inside the workspace are accepted,
 * Bash runs inside Claude Code's own sandbox (auto-allowed there), and the
 * web tools stay available. No permission bypass.
 *
 * Two narrow additions keep the room's own tools working in -p mode, where
 * nobody can answer an approval prompt: the table/diff shim is allowed by
 * name (Claude Code otherwise refuses commands it cannot statically analyse,
 * e.g. an evidence note quoting `===`), and when the room has network on,
 * sandboxed Bash gets it too — the same as Codex's network_access.
 */
export const buildClaudeSettings = (request: Pick<TurnRequest, "settings"> & { env?: NodeJS.ProcessEnv }): Json => {
  const readonly = request.settings.access === "readonly";
  const shim = request.env?.AGORYX_CLI;
  const tools = ["agoryx", ...(shim ? [shim] : [])].flatMap((cli) => [`Bash(${cli} table *)`, `Bash(${cli} diff *)`]);
  return {
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      ...(request.settings.network ? { network: { allowedDomains: ["*"] } } : {}),
    },
    permissions: {
      allow: tools,
      ...(readonly ? { deny: ["Edit", "Write", "MultiEdit", "NotebookEdit"] } : {}),
    },
  };
};

export const buildClaudeArgs = (request: TurnRequest, sessionId: string, fresh: boolean): string[] => {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    request.settings.access === "readonly" ? "default" : "acceptEdits",
    "--settings",
    JSON.stringify(buildClaudeSettings(request)),
    "--allowedTools",
    "WebSearch",
    "WebFetch",
  ];
  if (request.model) args.push("--model", request.model);
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

export const describeClaudeTool = (name: string, input: Json | undefined): { kind: ActivityKind; label: string; detail?: string } => {
  const kind = TOOL_KINDS[name] ?? "tool";
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = str(input?.[key]);
      if (value) return value;
    }
    return undefined;
  };
  switch (kind) {
    case "command":
      return { kind, label: truncate(pick("command", "bash_id", "shell_id") ?? name, 800), detail: pick("description") };
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

export const createClaudeRunner = (bin = process.env.AGORYX_CLAUDE_BIN || "claude"): AgentRunner => ({
  kind: "claude",

  resumeCommand(sessionId: string, cwd: string): string {
    return `cd ${shellQuote(cwd)} && claude --resume ${sessionId}`;
  },

  async run(request: TurnRequest, callbacks: TurnCallbacks): Promise<TurnResult> {
    const attempt = async (sessionId: string, fresh: boolean): Promise<TurnResult> => {
      let finalText: string | undefined;
      let lastAssistantText = "";
      let resultError = false;
      let resultSubtype = "";
      let usage: TurnUsage | undefined;
      let confirmedSession: string | null = fresh ? null : sessionId;
      const pendingTools = new Map<string, Activity>();

      if (fresh) callbacks.onSession(sessionId);

      const outcome = await runJsonlProcess({
        bin,
        args: buildClaudeArgs(request, sessionId, fresh),
        cwd: request.cwd,
        env: buildClaudeEnv(request.env),
        stdin: request.prompt,
        signal: request.signal,
        timeoutMs: request.settings.turnTimeoutMs,
        onJson: (event) => {
          const type = str(event.type);
          const sid = str(event.session_id);
          if (sid && sid !== confirmedSession) {
            confirmedSession = sid;
            callbacks.onSession(sid);
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
                pendingTools.set(id, activity);
                callbacks.onActivity(activity);
              } else if (block.type === "text") {
                const text = str(block.text);
                if (text?.trim()) lastAssistantText = text;
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
              const pending = id ? pendingTools.get(id) : undefined;
              if (!pending) continue;
              const failed = block.is_error === true;
              const output = toolResultText(block.content);
              callbacks.onActivity({
                ...pending,
                status: failed ? "fail" : "ok",
                ...(failed && output ? { detail: truncate(output, 240) } : {}),
              });
              pendingTools.delete(id!);
            }
            return;
          }
          if (type === "result") {
            resultSubtype = str(event.subtype) ?? "";
            resultError = event.is_error === true;
            const text = str(event.result);
            if (text !== undefined) finalText = text;
            const rawUsage = asObject(event.usage);
            if (rawUsage) {
              usage = {
                inputTokens:
                  Number(rawUsage.input_tokens ?? 0) +
                  Number(rawUsage.cache_creation_input_tokens ?? 0) +
                  Number(rawUsage.cache_read_input_tokens ?? 0),
                outputTokens: Number(rawUsage.output_tokens ?? 0),
                cachedTokens: Number(rawUsage.cache_read_input_tokens ?? 0),
              };
            }
            if (typeof event.total_cost_usd === "number") usage = { ...usage, costUsd: event.total_cost_usd };
            const denials = Array.isArray(event.permission_denials) ? (event.permission_denials as Json[]) : [];
            denials.forEach((denial, index) => {
              const described = describeClaudeTool(str(denial.tool_name) ?? "tool", asObject(denial.tool_input));
              callbacks.onActivity({
                id: `denied-${index}-${str(denial.tool_use_id) ?? ""}`,
                kind: "denied",
                label: `${str(denial.tool_name) ?? "tool"}: ${described.label}`,
                status: "fail",
              });
            });
          }
        },
      });

      if (outcome.aborted) {
        return { status: "interrupted", text: lastAssistantText, sessionId: confirmedSession, ...(usage ? { usage } : {}) };
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
          text: lastAssistantText,
          sessionId: confirmedSession,
          error: { kind: "timeout", message: `turn exceeded ${Math.round(request.settings.turnTimeoutMs / 60000)} min` },
        };
      }
      if (finalText !== undefined && !resultError) {
        return { status: "ok", text: finalText, sessionId: confirmedSession ?? sessionId, ...(usage ? { usage } : {}) };
      }
      const detail = [finalText, lastLines(outcome.stderr)].filter(Boolean).join("\n") || `exit ${outcome.code} ${resultSubtype}`;
      const kind = classifyFailure(detail);
      return {
        status: "error",
        text: "",
        sessionId: kind === "session" ? null : confirmedSession,
        error: { kind, message: truncate(detail, 600) },
        ...(usage ? { usage } : {}),
      };
    };

    return request.sessionId ? attempt(request.sessionId, false) : attempt(randomUUID(), true);
  },
});
