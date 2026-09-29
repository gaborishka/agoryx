import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { codexHumanText, codexText, humanText, isAgoryxPrompt } from "./native.js";
import { passNote } from "./prompts.js";
import { describeClaudeTool } from "./runners/claude.js";
import { unwrapShellCommand } from "./runners/codex.js";
import type { AgentKind, Transcript, TranscriptDiff, TranscriptEntry, TranscriptImage, TranscriptTodo, TranscriptTool } from "./types.js";

/**
 * An agent's own session, as Claude Code or Codex shows it: what was said, what it thought, every tool
 * with its input and output, edits as diffs, plans, images. Read from the session file the CLI writes;
 * Agoryx keeps nothing of its own here.
 */

export type { Transcript, TranscriptDiff, TranscriptEntry, TranscriptImage, TranscriptTodo, TranscriptTool };

type Json = Record<string, any>;

const WINDOW = 6 * 1024 * 1024;
const MAX_ENTRIES = 600;
/** A page reaches further back until it has this many entries: raw tool output and pages read can fill a window. */
const MIN_ENTRIES = 30;
const REACH = 24 * 1024 * 1024;
const MAX_TEXT = 60_000;
const MAX_OUTPUT = 24_000;
const MAX_PATCH = 200_000;
const MAX_IMAGE = 3 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const cap = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters)` : text;

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const obj = (value: unknown): Json | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;

interface Line {
  start: number;
  value: Json;
}

/** Complete JSON lines in [start, end); a window that begins mid-line skips to the next one. */
const readWindow = (file: string, end: number | undefined, window: number): { lines: Line[]; start: number; size: number } => {
  const size = statSync(file).size;
  const until = Math.min(end ?? size, size);
  let reach = window;
  for (;;) {
    const from = Math.max(0, until - reach);
    const fd = openSync(file, "r");
    let buffer: Buffer;
    try {
      buffer = Buffer.alloc(until - from);
      readSync(fd, buffer, 0, buffer.length, from);
    } finally {
      closeSync(fd);
    }
    let cursor = 0;
    if (from > 0) {
      const first = buffer.indexOf(0x0a);
      cursor = first < 0 ? buffer.length : first + 1;
      // One line longer than the window: take it whole, or the page never moves back.
      if (cursor >= buffer.length) {
        reach *= 2;
        continue;
      }
    }
    const lines: Line[] = [];
    const begin = from + cursor;
    while (cursor < buffer.length) {
      const newline = buffer.indexOf(0x0a, cursor);
      if (newline < 0) break;
      const raw = buffer.subarray(cursor, newline).toString("utf8").trim();
      if (raw) {
        try {
          const value = JSON.parse(raw);
          if (value && typeof value === "object") lines.push({ start: from + cursor, value });
        } catch {
          // a corrupt line is skipped
        }
      }
      cursor = newline + 1;
    }
    return { lines, start: begin, size };
  }
};

const dataUrl = (media: string, base64: string): string | undefined =>
  base64.length * 0.75 <= MAX_IMAGE ? `data:${media};base64,${base64}` : undefined;

/** An image file the agent looked at or was given, inlined when it can be read. */
const fileImage = (path: string): TranscriptImage => {
  const clean = path.startsWith("file://") ? fileURLToPath(path) : path;
  const media = IMAGE_TYPES[extname(clean).toLowerCase()];
  if (!media) return { path: clean };
  try {
    if (statSync(clean).size > MAX_IMAGE) return { path: clean };
    return { path: clean, src: `data:${media};base64,${readFileSync(clean).toString("base64")}` };
  } catch {
    return { path: clean };
  }
};

/** Claude's `mcp__plugin_x_server__tool` as Codex names an MCP call: `server.tool`. */
const toolName = (name: string): string => {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match ? `${match[1]!.replace(/^plugin_[^_]+_/, "")}.${match[2]}` : name;
};

/** What a call with no view of its own is about, from the usual fields of its input. */
const subjectOf = (input: Json | undefined): string => {
  for (const key of ["title", "description", "query", "url", "file_path", "path", "pattern", "prompt", "libraryName", "name"]) {
    const value = str(input?.[key])?.trim().split("\n")[0]?.trim();
    if (value) return value.length > 160 ? `${value.slice(0, 159)}…` : value;
  }
  return "";
};

/** A path as the diff shows it: inside the session's folder, relative to it. */
const shownPath = (path: string, cwd: string | undefined): string => {
  const clean = path.startsWith("file://") ? fileURLToPath(path) : path;
  const base = cwd?.replace(/\/+$/, "");
  return base && clean.startsWith(`${base}/`) ? clean.slice(base.length + 1) : clean;
};

/** The a/ and b/ sides of a header; an absolute path keeps a single slash. */
const side = (prefix: "a" | "b", path: string): string => `${prefix}/${path.replace(/^\/+/, "")}`;

const addedPatch = (path: string, content: string): string => {
  const lines = content.replace(/\n$/, "").split("\n");
  return `--- /dev/null\n+++ ${side("b", path)}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`;
};

const withHeader = (path: string, body: string): string =>
  /^(---|diff )/.test(body) ? body : `--- ${side("a", path)}\n+++ ${side("b", path)}\n${body.endsWith("\n") ? body : `${body}\n`}`;

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

const hunksPatch = (path: string, hunks: Hunk[]): string =>
  `--- ${side("a", path)}\n+++ ${side("b", path)}\n${hunks
    .map((hunk) => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join("\n")}\n`)
    .join("")}`;

/** What an edit is about to do, from its input (before the result, with exact line numbers, arrives). */
const replacePatch = (path: string, edits: Array<{ old: string; next: string }>): string =>
  `--- ${side("a", path)}\n+++ ${side("b", path)}\n${edits
    .map(({ old, next }) => {
      const before = old ? old.split("\n") : [];
      const after = next ? next.split("\n") : [];
      return `@@ -1,${before.length} +1,${after.length} @@\n${[...before.map((line) => `-${line}`), ...after.map((line) => `+${line}`)].join("\n")}\n`;
    })
    .join("")}`;

const todosOf = (value: unknown): TranscriptTodo[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((todo) => {
    const text = str(todo?.content) ?? str(todo?.text) ?? str(todo?.step);
    if (!text) return [];
    const status = todo?.status === "in_progress" || todo?.status === "completed" ? todo.status : todo?.completed === true ? "completed" : "pending";
    return [{ text, status }];
  });
};

/** Tools whose input is already shown as the title, the diff or the plan. */
const SHOWN_INPUT = new Set(["Bash", "Read", "Edit", "MultiEdit", "Write", "NotebookEdit", "TodoWrite", "Glob", "Grep", "LS", "WebFetch", "WebSearch"]);

const inputText = (name: string, input: Json | undefined): string | undefined => {
  if (!input || SHOWN_INPUT.has(name)) return undefined;
  // Subagents, skills and the like: the prompt reads better than its JSON.
  const prompt = str(input.prompt);
  if (prompt && Object.keys(input).length <= 3) return cap(prompt, MAX_TEXT);
  const json = JSON.stringify(input, null, 2);
  return json === "{}" ? undefined : cap(json, MAX_OUTPUT);
};

const claudeInputDiffs = (name: string, input: Json | undefined, cwd: string | undefined): TranscriptDiff[] | undefined => {
  const raw = str(input?.file_path) ?? str(input?.notebook_path);
  if (!input || !raw) return undefined;
  const path = shownPath(raw, cwd);
  if (name === "Write" && typeof input.content === "string") return [{ path, op: "add", patch: cap(addedPatch(path, input.content), MAX_PATCH) }];
  if (name === "Edit") return [{ path, op: "update", patch: cap(replacePatch(path, [{ old: str(input.old_string) ?? "", next: str(input.new_string) ?? "" }]), MAX_PATCH) }];
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    const edits = input.edits.map((edit: Json) => ({ old: str(edit?.old_string) ?? "", next: str(edit?.new_string) ?? "" }));
    return [{ path, op: "update", patch: cap(replacePatch(path, edits), MAX_PATCH) }];
  }
  return undefined;
};

const resultParts = (content: unknown): { text: string; images: TranscriptImage[] } => {
  if (typeof content === "string") return { text: content, images: [] };
  const images: TranscriptImage[] = [];
  const texts: string[] = [];
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part?.type === "text" && typeof part.text === "string") texts.push(part.text);
      else if (part?.type === "image" && part.source?.type === "base64" && typeof part.source.data === "string") {
        const src = dataUrl(str(part.source.media_type) ?? "image/png", part.source.data);
        images.push(src ? { src } : {});
      }
    }
  }
  return { text: texts.join("\n"), images };
};

const settleClaudeTool = (entry: TranscriptTool, part: Json, structured: unknown, cwd: string | undefined): void => {
  const { text, images } = resultParts(part.content);
  entry.status = part.is_error === true ? "fail" : "ok";
  if (images.length) entry.images = images;
  const result = obj(structured);
  const path = str(result?.filePath) ? shownPath(result!.filePath, cwd) : undefined;
  if (result && path && Array.isArray(result.structuredPatch) && result.structuredPatch.length) {
    entry.diffs = [{ path, op: "update", patch: cap(hunksPatch(path, result.structuredPatch as Hunk[]), MAX_PATCH) }];
  } else if (result && path && result.type === "create" && typeof result.content === "string") {
    entry.diffs = [{ path, op: "add", patch: cap(addedPatch(path, result.content), MAX_PATCH) }];
  }
  const todos = todosOf(result?.newTodos);
  if (todos) entry.todos = todos;
  // An applied edit is its diff; the "file updated, here is cat -n" text says nothing more.
  if (entry.diffs && entry.status === "ok" && entry.category === "edit") return;
  if (entry.todos && entry.status === "ok") return;
  if (text.trim()) entry.output = cap(text, MAX_OUTPUT);
};

const INTERRUPTED = /^\[Request interrupted by user/;

const parseClaude = (lines: Line[]): Array<TranscriptEntry & { offset: number }> => {
  const entries: Array<TranscriptEntry & { offset: number }> = [];
  const tools = new Map<string, TranscriptTool>();
  for (const { start: offset, value } of lines) {
    if (value.isSidechain) continue;
    const at = str(value.timestamp);
    const id = str(value.uuid) ?? String(offset);
    const cwd = str(value.cwd);
    const content = value.message?.content;
    if (value.type === "user") {
      if (value.isCompactSummary) {
        entries.push({ id, at, kind: "system", code: "compacted", offset });
        continue;
      }
      if (value.isMeta) continue;
      if (Array.isArray(content) && content.some((part: Json) => part?.type === "tool_result")) {
        for (const part of content) {
          if (part?.type !== "tool_result") continue;
          const entry = tools.get(str(part.tool_use_id) ?? "");
          if (entry) settleClaudeTool(entry, part, value.toolUseResult, cwd);
        }
        continue;
      }
      const raw = typeof content === "string" ? content : Array.isArray(content) ? content.map((part: Json) => (part?.type === "text" ? str(part.text) ?? "" : "")).join("\n") : "";
      const agoryx = isAgoryxPrompt(raw);
      const text = agoryx ? raw : humanText(content);
      if (text === null) continue;
      if (INTERRUPTED.test(text)) {
        entries.push({ id, at, kind: "system", code: "interrupted", offset });
        continue;
      }
      const images = Array.isArray(content)
        ? content.flatMap((part: Json) =>
            part?.type === "image" && part.source?.type === "base64" && typeof part.source.data === "string"
              ? [{ src: dataUrl(str(part.source.media_type) ?? "image/png", part.source.data) }]
              : [],
          )
        : [];
      entries.push({
        id,
        at,
        kind: "user",
        text: cap(text.replace(/\n?\[image\]/g, "").trim(), MAX_TEXT),
        ...(agoryx ? { agoryx: true } : {}),
        ...(images.length ? { images } : {}),
        offset,
      });
    } else if (value.type === "assistant") {
      if (value.isApiErrorMessage) {
        const text = Array.isArray(content) ? content.map((part: Json) => str(part?.text) ?? "").join("\n") : "";
        entries.push({ id, at, kind: "system", code: "error", ...(text ? { text: cap(text, 2000) } : {}), offset });
        continue;
      }
      const message = str(value.message?.id);
      (Array.isArray(content) ? content : []).forEach((part: Json, index: number) => {
        const partId = `${id}:${index}`;
        if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
          const last = entries[entries.length - 1];
          // One API message is written as a line per block; consecutive text of it reads as one reply.
          if (last?.kind === "assistant" && message && last.id.startsWith(`${message}#`)) last.text = cap(`${last.text}\n\n${part.text}`, MAX_TEXT);
          else entries.push({ id: message ? `${message}#${partId}` : partId, at, kind: "assistant", text: cap(part.text, MAX_TEXT), offset });
        } else if (part?.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) {
          entries.push({ id: partId, at, kind: "thinking", text: cap(part.thinking, MAX_TEXT), offset });
        } else if (part?.type === "tool_use") {
          const name = str(part.name) ?? "tool";
          let input = obj(part.input);
          if (!input && typeof part.input === "string") {
            try {
              input = obj(JSON.parse(part.input));
            } catch {
              // not JSON
            }
          }
          input ??= obj(value.wireToolInputs?.[str(part.id) ?? ""]);
          const described = describeClaudeTool(name, input);
          const todos = name === "TodoWrite" ? todosOf(input?.todos) : undefined;
          const diffs = claudeInputDiffs(name, input, cwd);
          const inputShown = inputText(name, input);
          const entry: TranscriptTool & { offset: number } = {
            id: str(part.id) ?? partId,
            at,
            kind: "tool",
            tool: toolName(name),
            category: described.kind,
            title: described.label === name ? subjectOf(input) : described.label,
            ...(described.detail && !inputShown ? { detail: described.detail } : {}),
            ...(inputShown ? { input: inputShown } : {}),
            status: "running",
            ...(diffs ? { diffs } : {}),
            ...(todos ? { todos } : {}),
            offset,
          };
          tools.set(entry.id, entry);
          entries.push(entry);
        }
      });
    } else if (value.type === "system") {
      if (value.subtype === "compact_boundary") entries.push({ id, at, kind: "system", code: "compacted", offset });
      else if (value.level === "error" || value.subtype === "api_error") {
        const text = str(value.content) ?? str(value.error?.message);
        entries.push({ id, at, kind: "system", code: "error", ...(text ? { text: cap(text, 2000) } : {}), offset });
      }
    }
  }
  return entries;
};

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

const codexImages = (content: unknown): TranscriptImage[] => {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part: Json) => {
    const type = String(part?.type ?? "").toLowerCase();
    if (type === "local_image" && typeof part.path === "string") return [fileImage(part.path)];
    if ((type === "image" || type === "input_image") && typeof (part.image_url ?? part.url) === "string") {
      const url = String(part.image_url ?? part.url);
      return [url.startsWith("data:") && url.length * 0.75 <= MAX_IMAGE ? { src: url } : url.startsWith("data:") ? {} : fileImage(url)];
    }
    return [];
  });
};

const codexCommand = (command: unknown): string => {
  if (Array.isArray(command)) {
    const parts = command.map(String);
    return parts.length === 3 && /(^|\/)(ba|z)?sh$/.test(parts[0]!) && /^-l?c$/.test(parts[1]!) ? parts[2]! : parts.join(" ");
  }
  return unwrapShellCommand(str(command) ?? "");
};

const statusOf = (status: unknown, failed = false): "running" | "ok" | "fail" => {
  const value = String(status ?? "").toLowerCase();
  if (value === "in_progress" || value === "inprogress" || value === "running") return "running";
  return failed || value === "failed" || value === "declined" || value === "error" ? "fail" : "ok";
};

const mcpOutput = (result: unknown): { text: string; images: TranscriptImage[] } => {
  const content = obj(result)?.content ?? result;
  if (!Array.isArray(content)) return { text: typeof content === "string" ? content : content === undefined ? "" : JSON.stringify(content, null, 2), images: [] };
  const images: TranscriptImage[] = [];
  const texts: string[] = [];
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string") texts.push(part.text);
    else if (part?.type === "image" && typeof part.data === "string") {
      const src = dataUrl(str(part.mimeType) ?? str(part.mime_type) ?? "image/png", part.data);
      images.push(src ? { src } : {});
    }
  }
  return { text: texts.join("\n"), images };
};

/** One finished Codex item (the rollout's `item_completed`), as the session view shows it. */
const codexItem = (item: Json, id: string, at: string | undefined, cwd: string | undefined): TranscriptEntry | null => {
  switch (item.type) {
    case "UserMessage": {
      const raw = codexText(item.content);
      const agoryx = isAgoryxPrompt(raw);
      const text = agoryx ? raw : codexHumanText(raw);
      const images = codexImages(item.content);
      if (!text && !images.length) return null;
      return { id, at, kind: "user", text: cap(text.replace(/\n?\[image\]/g, "").trim(), MAX_TEXT), ...(agoryx ? { agoryx: true } : {}), ...(images.length ? { images } : {}) };
    }
    case "AgentMessage": {
      const text = codexText(item.content).trim();
      return text ? { id, at, kind: "assistant", text: cap(text, MAX_TEXT), ...(item.phase === "commentary" ? { commentary: true } : {}) } : null;
    }
    case "Reasoning": {
      const parts = [...(Array.isArray(item.summary_text) ? item.summary_text : []), ...(Array.isArray(item.raw_content) ? item.raw_content : [])];
      const text = parts.map((part) => (typeof part === "string" ? part : str(part?.text) ?? "")).join("\n\n").trim();
      return text ? { id, at, kind: "thinking", text: cap(text, MAX_TEXT) } : null;
    }
    case "CommandExecution": {
      const exit = typeof item.exit_code === "number" ? item.exit_code : null;
      const output = str(item.aggregated_output) ?? str(item.formatted_output) ?? [str(item.stdout), str(item.stderr)].filter(Boolean).join("\n");
      return {
        id,
        at,
        kind: "tool",
        tool: "shell",
        category: "command",
        title: cap(codexCommand(item.command), 4000),
        ...(exit !== null && exit !== 0 ? { detail: `exit ${exit}` } : {}),
        ...(output.trim() ? { output: cap(output, MAX_OUTPUT) } : {}),
        status: statusOf(item.status, exit !== null && exit !== 0),
      };
    }
    case "FileChange": {
      const changes = obj(item.changes) ?? {};
      const diffs: TranscriptDiff[] = Object.entries(changes).map(([raw, change]) => {
        const path = shownPath(raw, cwd);
        const kind = str(change?.type) ?? str(change?.kind);
        if (kind === "add") return { path, op: "add", patch: cap(addedPatch(path, str(change.content) ?? ""), MAX_PATCH) };
        if (kind === "delete") return { path, op: "delete", patch: `--- ${side("a", path)}\n+++ /dev/null\n` };
        return { path: str(change?.move_path) ? shownPath(change.move_path, cwd) : path, op: "update", patch: cap(withHeader(path, str(change?.unified_diff) ?? ""), MAX_PATCH) };
      });
      const failed = statusOf(item.status) === "fail";
      return {
        id,
        at,
        kind: "tool",
        tool: "apply_patch",
        category: "edit",
        title: diffs.map((diff) => diff.path).join(", ") || "files",
        status: statusOf(item.status),
        diffs,
        ...(failed && (str(item.stderr) || str(item.stdout)) ? { output: cap(str(item.stderr) || str(item.stdout) || "", MAX_OUTPUT) } : {}),
      };
    }
    case "McpToolCall": {
      const { text, images } = mcpOutput(item.result ?? item.error);
      const args = item.arguments === undefined ? "" : JSON.stringify(item.arguments, null, 2);
      const failed = obj(item.result)?.isError === true || item.error !== undefined && item.error !== null;
      return {
        id,
        at,
        kind: "tool",
        tool: `${str(item.server) ?? "mcp"}.${str(item.tool) ?? "tool"}`,
        category: "tool",
        title: subjectOf(obj(item.arguments)),
        ...(args && args !== "{}" ? { input: cap(args, MAX_OUTPUT) } : {}),
        ...(text.trim() ? { output: cap(text, MAX_OUTPUT) } : {}),
        ...(images.length ? { images } : {}),
        status: statusOf(item.status, failed),
      };
    }
    case "Extension": {
      const kind = str(item.kind) ?? "extension";
      if (kind.startsWith("web")) {
        const results = Array.isArray(item.results) ? item.results : [];
        const output = results
          .map((result: Json) => [str(result?.title), str(result?.url) ?? str(result?.snippet)].filter(Boolean).join(" — "))
          .filter(Boolean)
          .join("\n");
        const action = obj(item.action);
        const opened = action?.type === "openPage" || action?.type === "findInPage";
        return {
          id,
          at,
          kind: "tool",
          tool: action?.type === "findInPage" ? "find in page" : opened ? "open page" : kind,
          category: "web",
          title: str(item.query) || str(action?.query) || str(action?.url) || str(results[0]?.url) || str(results[0]?.title) || "",
          ...(output ? { output: cap(output, MAX_OUTPUT) } : {}),
          status: "ok",
        };
      }
      if (kind === "image_gen.generation") {
        // The image is on disk once made; the session also keeps it inline.
        const saved = str(item.savedPath);
        const inline = str(item.result) ? dataUrl("image/png", item.result) : undefined;
        const images: TranscriptImage[] = saved ? [fileImage(saved)] : inline ? [{ src: inline }] : [];
        if (images[0] && !images[0].src && inline) images[0] = { ...images[0], src: inline };
        const failed = statusOf(item.status) === "fail" || !images.length;
        const prompt = str(item.revisedPrompt) ?? str(item.revised_prompt);
        return {
          id,
          at,
          kind: "tool",
          tool: "image",
          category: "tool",
          title: saved ? shownPath(saved, cwd) : "",
          ...(prompt ? { input: cap(prompt, MAX_OUTPUT) } : {}),
          ...(str(item.failure) ? { output: cap(item.failure, MAX_OUTPUT) } : {}),
          ...(images.length ? { images } : {}),
          status: failed ? "fail" : "ok",
        };
      }
      if (kind === "clock.sleep" && typeof item.durationMs === "number") {
        return { id, at, kind: "tool", tool: "sleep", category: "tool", title: `${Math.round(item.durationMs / 100) / 10} s`, status: "ok" };
      }
      return { id, at, kind: "tool", tool: kind, category: "tool", title: subjectOf(item), status: statusOf(item.status) };
    }
    case "ImageView": {
      const path = str(item.path);
      return path ? { id, at, kind: "tool", tool: "view_image", category: "read", title: path.replace(/^file:\/\//, ""), images: [fileImage(path)], status: "ok" } : null;
    }
    case "SubAgentActivity":
    case "CollabAgentToolCall": {
      const title = str(item.tool) ?? str(item.kind) ?? "agents";
      const prompt = str(item.prompt) ?? str(item.message);
      return { id, at, kind: "tool", tool: item.type === "SubAgentActivity" ? "subagent" : "collab", category: "tool", title, ...(prompt ? { input: cap(prompt, MAX_OUTPUT) } : {}), status: statusOf(item.status) };
    }
    case "ContextCompaction":
      return { id, at, kind: "system", code: "compacted" };
    case "Plan":
    case "TodoList": {
      const todos = todosOf(item.items ?? item.plan);
      return todos ? { id, at, kind: "tool", tool: "update_plan", category: "note", title: "plan", todos, status: "ok" } : null;
    }
    default:
      return null;
  }
};

const parseCodex = (lines: Line[]): Array<TranscriptEntry & { offset: number }> => {
  const entries: Array<TranscriptEntry & { offset: number }> = [];
  const itemised = lines.some(({ value }) => value.type === "event_msg" && value.payload?.type === "item_completed");
  const calls = new Map<string, TranscriptTool>();
  let cwd: string | undefined;
  for (const { start: offset, value } of lines) {
    const payload = obj(value.payload) ?? {};
    const at = str(value.timestamp);
    if ((value.type === "session_meta" || value.type === "turn_context") && str(payload.cwd)) cwd = payload.cwd;
    if (value.type === "event_msg") {
      switch (payload.type) {
        case "item_completed": {
          const item = obj(payload.item);
          if (!item) break;
          const entry = codexItem(item, str(item.id) ?? String(offset), at, cwd);
          if (entry) entries.push({ ...entry, offset });
          break;
        }
        case "turn_aborted":
          entries.push({ id: String(offset), at, kind: "system", code: "interrupted", offset });
          break;
        case "error":
          entries.push({ id: String(offset), at, kind: "system", code: "error", ...(str(payload.message) ? { text: cap(payload.message, 2000) } : {}), offset });
          break;
        // Older Codex builds: no items, just messages and the model's calls.
        case "user_message":
          if (!itemised && typeof payload.message === "string") {
            const agoryx = isAgoryxPrompt(payload.message);
            const text = agoryx ? payload.message : codexHumanText(payload.message);
            const images = Array.isArray(payload.local_images) ? payload.local_images.filter((path: unknown) => typeof path === "string").map(fileImage) : [];
            if (text || images.length) entries.push({ id: String(offset), at, kind: "user", text: cap(text, MAX_TEXT), ...(agoryx ? { agoryx: true } : {}), ...(images.length ? { images } : {}), offset });
          }
          break;
        case "agent_message":
          if (!itemised && typeof payload.message === "string" && payload.message.trim()) {
            entries.push({ id: String(offset), at, kind: "assistant", text: cap(payload.message, MAX_TEXT), offset });
          }
          break;
        case "agent_reasoning":
          if (!itemised && typeof payload.text === "string" && payload.text.trim()) {
            entries.push({ id: String(offset), at, kind: "thinking", text: cap(payload.text, MAX_TEXT), offset });
          }
          break;
      }
    } else if (value.type === "response_item" && !itemised) {
      if (payload.type === "function_call" || payload.type === "custom_tool_call" || payload.type === "local_shell_call") {
        const name = str(payload.name) ?? "shell";
        let args: Json | undefined;
        try {
          args = obj(typeof payload.arguments === "string" ? JSON.parse(payload.arguments) : payload.arguments ?? payload.action);
        } catch {
          args = undefined;
        }
        const command = args?.cmd ?? args?.command;
        const shell = command !== undefined;
        const todos = name === "update_plan" ? todosOf(args?.plan) : undefined;
        const entry: TranscriptTool & { offset: number } = {
          id: str(payload.call_id) ?? String(offset),
          at,
          kind: "tool",
          tool: name,
          category: shell ? "command" : todos ? "note" : "tool",
          title: shell ? cap(codexCommand(command), 4000) : todos ? "plan" : subjectOf(args),
          ...(!shell && !todos ? { input: cap(typeof payload.input === "string" ? payload.input : JSON.stringify(args ?? {}, null, 2), MAX_OUTPUT) } : {}),
          ...(todos ? { todos } : {}),
          status: "running",
          offset,
        };
        calls.set(entry.id, entry);
        entries.push(entry);
      } else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
        const entry = calls.get(str(payload.call_id) ?? "");
        if (entry) {
          const raw = payload.output;
          const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((part: Json) => str(part?.text) ?? "").join("\n") : str(obj(raw)?.content) ?? "";
          let output = text;
          try {
            const parsed = obj(JSON.parse(text));
            if (parsed && typeof parsed.output === "string") output = parsed.output;
          } catch {
            // plain text
          }
          entry.status = "ok";
          if (output.trim() && !entry.todos) entry.output = cap(output, MAX_OUTPUT);
        }
      }
    }
  }
  return entries;
};

/**
 * The session file's entries up to `end` (its end by default), from as far back as a window of the file
 * reaches. `start` in the result is where to continue backwards from.
 */
export const readTranscript = (kind: AgentKind, file: string, options: { end?: number; window?: number } = {}): Transcript => {
  const window = options.window ?? WINDOW;
  let { lines, start, size } = readWindow(file, options.end, window);
  const until = Math.min(options.end ?? size, size);
  const parse = () => (kind === "claude" ? parseClaude(lines) : parseCodex(lines));
  let parsed = parse();
  while (parsed.length < MIN_ENTRIES && start > 0 && until - start < REACH) {
    const older = readWindow(file, start, window);
    lines = [...older.lines, ...lines];
    start = older.start;
    parsed = parse();
  }
  const kept = parsed.length > MAX_ENTRIES ? parsed.slice(parsed.length - MAX_ENTRIES) : parsed;
  const from = parsed.length > MAX_ENTRIES ? kept[0]!.offset : start;
  return {
    entries: kept.map(({ offset: _offset, ...entry }) => {
      if (entry.kind !== "assistant") return entry as TranscriptEntry;
      // A turn with nothing to add ends with the room's pass token; shown as what it means.
      const note = passNote(entry.text);
      return (note === null ? entry : { ...entry, text: note, pass: true }) as TranscriptEntry;
    }),
    start: from,
    end: until,
    size,
  };
};
