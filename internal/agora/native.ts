import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentKind } from "./types.js";

/**
 * The room's conversation lives in the agents' own sessions, so the human can
 * open `claude --resume <id>` / `codex resume <id>` and keep talking there.
 * This module reads those session files back and finds the exchanges that did
 * not come from Agoryx, so the room can show them too.
 *
 * Only complete exchanges are returned. A trailing exchange that is still in
 * progress is left for the next scan (its start is where the next scan begins).
 */

export interface NativeExchange {
  /** Stable id inside the session file (Claude promptId/uuid, Codex turn id). */
  key: string;
  /** When the exchange started, from the session file. */
  at: string;
  /** What the human typed natively; null when the agent spoke without a prompt. */
  prompt: string | null;
  /** The agent's final text; null when it produced none (interrupted, tool-only). */
  reply: string | null;
  interrupted: boolean;
}

export interface NativeScan {
  exchanges: NativeExchange[];
  /** Byte offset to resume from: the start of an unfinished exchange, or the end of what was read. */
  offset: number;
  /** An exchange is in progress that did not come from Agoryx (someone is typing in the native app). */
  openNative: boolean;
  /** Whether the last finished exchange came from Agoryx (pass it to the next scan). */
  lastAgoryx: boolean;
}

/** Prompts Agoryx sends: the first-turn briefing and every delta. */
const AGORYX_PROMPT = /^(You are [^\n,]{1,40}, in an Agoryx room|\[agoryx · )/;

export const isAgoryxPrompt = (text: string): boolean => AGORYX_PROMPT.test(text.trimStart());

// ---------------------------------------------------------------------------
// Locating session files
// ---------------------------------------------------------------------------

const claudeRoot = (env: NodeJS.ProcessEnv): string =>
  join(env.CLAUDE_CONFIG_DIR?.trim() || join(env.HOME?.trim() || homedir(), ".claude"), "projects");

const codexRoot = (env: NodeJS.ProcessEnv): string =>
  join(env.CODEX_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".codex"), "sessions");

/** Claude Code keys project dirs by the cwd with every non-alphanumeric character replaced by "-". */
export const claudeProjectKey = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, "-");

const safeReaddir = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

const locateClaude = (sessionId: string, cwd: string, env: NodeJS.ProcessEnv): string | null => {
  const root = claudeRoot(env);
  const file = `${sessionId}.jsonl`;
  const cwds = [cwd];
  try {
    cwds.push(realpathSync(cwd));
  } catch {
    // workspace may be gone
  }
  for (const dir of new Set(cwds.map(claudeProjectKey))) {
    const candidate = join(root, dir, file);
    if (existsSync(candidate)) return candidate;
  }
  for (const dir of safeReaddir(root)) {
    const candidate = join(root, dir, file);
    if (existsSync(candidate)) return candidate;
  }
  return null;
};

const pad = (n: number) => String(n).padStart(2, "0");

/** Codex thread ids are UUIDv7: the first 48 bits are the creation time in ms. */
const uuidV7Time = (id: string): number | null => {
  const hex = id.replace(/-/g, "").slice(0, 12);
  if (!/^[0-9a-f]{12}$/i.test(hex)) return null;
  const ms = Number.parseInt(hex, 16);
  return ms > Date.UTC(2020, 0, 1) && ms < Date.UTC(2100, 0, 1) ? ms : null;
};

const locateCodex = (sessionId: string, env: NodeJS.ProcessEnv): string | null => {
  const root = codexRoot(env);
  const suffix = `-${sessionId}.jsonl`;
  const findIn = (dir: string): string | null => {
    const hit = safeReaddir(dir).find((name) => name.endsWith(suffix));
    return hit ? join(dir, hit) : null;
  };
  // Rollouts live under YYYY/MM/DD of the session start (local time); check around the id's timestamp first.
  const ms = uuidV7Time(sessionId);
  if (ms !== null) {
    for (const offset of [0, -1, 1]) {
      const day = new Date(ms + offset * 86_400_000);
      for (const [y, m, d] of [
        [day.getFullYear(), day.getMonth() + 1, day.getDate()],
        [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()],
      ] as const) {
        const hit = findIn(join(root, String(y), pad(m), pad(d)));
        if (hit) return hit;
      }
    }
  }
  for (const year of safeReaddir(root).sort().reverse()) {
    for (const month of safeReaddir(join(root, year)).sort().reverse()) {
      for (const day of safeReaddir(join(root, year, month)).sort().reverse()) {
        const hit = findIn(join(root, year, month, day));
        if (hit) return hit;
      }
    }
  }
  return null;
};

export const locateNativeSession = (
  kind: AgentKind,
  sessionId: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null => (kind === "claude" ? locateClaude(sessionId, cwd, env) : locateCodex(sessionId, env));

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface Line {
  start: number;
  end: number;
  value: Record<string, any>;
}

/** Complete JSON lines from `offset`; a partial last line is left for later. */
const readLines = (file: string, offset: number): { lines: Line[]; from: number; end: number } => {
  const size = statSync(file).size;
  // A file that shrank was rewritten: start over (imports are deduplicated by key).
  if (size < offset) offset = 0;
  if (size === offset) return { lines: [], from: offset, end: offset };
  const fd = openSync(file, "r");
  let buffer: Buffer;
  try {
    buffer = Buffer.alloc(size - offset);
    readSync(fd, buffer, 0, buffer.length, offset);
  } finally {
    closeSync(fd);
  }
  const lines: Line[] = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const newline = buffer.indexOf(0x0a, cursor);
    if (newline < 0) break;
    const raw = buffer.subarray(cursor, newline).toString("utf8").trim();
    if (raw) {
      try {
        const value = JSON.parse(raw);
        if (value && typeof value === "object") lines.push({ start: offset + cursor, end: offset + newline + 1, value });
      } catch {
        // a corrupt line is skipped, not fatal
      }
    }
    cursor = newline + 1;
  }
  return { lines, from: offset, end: offset + cursor };
};

interface Draft {
  key: string;
  at: string;
  start: number;
  prompts: string[];
  agoryx: boolean;
  /** Claude: text parts after the last tool call. Codex: final answers. */
  reply: string[];
  /** Codex: the last progress note, used when a turn ends without a final answer. */
  commentary?: string;
  done: boolean;
  interrupted: boolean;
  /** Claude: the API message that ended the turn; its other content blocks follow as separate lines. */
  endedBy?: string;
  endedAt?: number;
}

const finish = (draft: Draft): NativeExchange | null => {
  if (draft.agoryx) return null;
  const prompt = draft.prompts.join("\n\n").trim() || null;
  const reply = draft.reply.join("\n\n").trim() || draft.commentary?.trim() || null;
  if (!prompt && !reply) return null;
  return { key: draft.key, at: draft.at, prompt, reply, interrupted: draft.interrupted };
};

const SYSTEM_TAGS =
  /^<(local-command-[a-z]+|bash-(input|stdout|stderr)|task-notification|ci-monitor-event|system-reminder|user-prompt-submit-hook|[a-z]+(-[a-z]+)*-(command|event|notification))[\s>]/;

/** Text the human typed, without harness wrappers; null when the line is not a human prompt. */
const humanText = (content: unknown): string | null => {
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    if (content.some((part) => part?.type === "tool_result")) return null;
    text = content
      .map((part) => (part?.type === "text" ? String(part.text ?? "") : part?.type === "image" ? "[image]" : ""))
      .filter(Boolean)
      .join("\n");
  } else {
    return null;
  }
  const command = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (command) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim();
    return `${command[1]!.trim()}${args ? ` ${args}` : ""}`;
  }
  // Skills expand to "<name-command>…instructions…": show what the human typed.
  const skill = /^\s*<([a-z][a-z0-9-]*)-command>/.exec(text);
  if (skill) return `/${skill[1]}`;
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  if (!text || SYSTEM_TAGS.test(text) || text.startsWith("<command-message>")) return null;
  return text;
};

const INTERRUPTED = /^\[Request interrupted by user/;
const TURN_ENDS = new Set(["end_turn", "max_tokens", "stop_sequence", "refusal"]);

const scanClaude = (lines: Line[], offset: number, end: number, tailAgoryx: boolean): NativeScan => {
  const exchanges: NativeExchange[] = [];
  let draft: Draft | null = null;
  let lastAgoryx = tailAgoryx;
  let consumed = offset;
  const close = (at: number) => {
    if (!draft) return;
    const done = finish(draft);
    if (done) exchanges.push(done);
    lastAgoryx = draft.agoryx;
    draft = null;
    consumed = at;
  };

  for (const { start, end: lineEnd, value } of lines) {
    if (value.isSidechain) {
      if (!draft) consumed = lineEnd;
      continue;
    }
    // A turn ends with one API message, written as one line per content block (thinking, text…).
    if (draft) {
      const ending = draft as Draft;
      if (ending.endedBy !== undefined) {
        if (value.type === "assistant" && value.message?.id === ending.endedBy) {
          for (const part of Array.isArray(value.message?.content) ? value.message.content : []) {
            if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) ending.reply.push(part.text);
          }
          ending.endedAt = lineEnd;
          continue;
        }
        close(ending.endedAt!);
      }
    }
    if (value.type === "user" && !value.isMeta) {
      const content = value.message?.content;
      const toolResult = Array.isArray(content) && content.some((part: any) => part?.type === "tool_result");
      const text = toolResult ? null : humanText(content);
      if (text !== null && INTERRUPTED.test(text)) {
        if (draft) {
          (draft as Draft).interrupted = true;
          close(lineEnd);
          continue;
        }
      } else if (!toolResult) {
        const origin = value.origin?.kind;
        const agoryx = typeof content === "string" ? isAgoryxPrompt(content) : text !== null && isAgoryxPrompt(text);
        // Newer Claude Code stamps human input with origin.kind = "human"; older builds have no origin.
        const human = !agoryx && text !== null && (origin === undefined || origin === "human");
        if (agoryx || human || origin !== undefined) {
          close(start);
          draft = {
            key: String(value.promptId ?? value.uuid ?? start),
            at: String(value.timestamp ?? ""),
            start,
            prompts: human ? [text!] : [],
            agoryx,
            reply: [],
            done: false,
            interrupted: false,
          };
        }
      }
    } else if (value.type === "assistant") {
      if (!draft) {
        // The agent went on without a new prompt (a stop hook, a background task): same speaker as before.
        draft = {
          key: String(value.uuid ?? start),
          at: String(value.timestamp ?? ""),
          start,
          prompts: [],
          agoryx: lastAgoryx,
          reply: [],
          done: false,
          interrupted: false,
        };
      }
      const current: Draft = draft;
      const parts = Array.isArray(value.message?.content) ? value.message.content : [];
      for (const part of parts) {
        if (part?.type === "tool_use") current.reply = [];
        else if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) current.reply.push(part.text);
      }
      if (TURN_ENDS.has(value.message?.stop_reason)) {
        current.endedBy = String(value.message?.id ?? `line-${start}`);
        current.endedAt = lineEnd;
        continue;
      }
    }
    if (!draft) consumed = lineEnd;
  }
  if (draft && (draft as Draft).endedBy !== undefined) close((draft as Draft).endedAt!);
  const open = draft as Draft | null;
  return {
    exchanges,
    offset: open ? open.start : Math.max(consumed, end),
    openNative: Boolean(open && !open.agoryx),
    lastAgoryx,
  };
};

const codexText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const type = String(part?.type ?? "").toLowerCase();
      if (type === "text" || type === "input_text" || type === "output_text") return String(part.text ?? "").trim();
      if (type.includes("image")) return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
};

/**
 * What the human typed into Codex, without what the app wraps around it
 * (attachment notes, ambient UI state blocks, "## My request:" framing).
 */
const codexHumanText = (text: string): string => {
  const request = /^## My request(?: for Codex)?:[ \t]*$/m.exec(text);
  let body = request ? text.slice(request.index + request[0].length) : text;
  for (let block = LEADING_BLOCK.exec(body); block; block = LEADING_BLOCK.exec(body)) body = body.slice(block[0].length);
  return body.trim();
};

const LEADING_BLOCK = /^\s*<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/;

const scanCodex = (lines: Line[], offset: number, end: number, tailAgoryx: boolean): NativeScan => {
  const exchanges: NativeExchange[] = [];
  let draft: Draft | null = null;
  let lastAgoryx = tailAgoryx;
  let consumed = offset;
  const open = (key: string, at: string, start: number): Draft => {
    draft = { key, at, start, prompts: [], agoryx: false, reply: [], done: false, interrupted: false };
    return draft;
  };
  const close = (at: number) => {
    if (!draft) return;
    const done = finish(draft);
    if (done) exchanges.push(done);
    lastAgoryx = draft.agoryx;
    draft = null;
    consumed = at;
  };
  const addPrompt = (text: string, turnId: string | undefined, at: string, start: number) => {
    const current: Draft = draft && (!turnId || draft.key === turnId) ? draft : (close(start), open(turnId ?? String(start), at, start));
    if (isAgoryxPrompt(text)) current.agoryx = true;
    else if (text.trim() && !current.prompts.includes(text.trim())) current.prompts.push(text.trim());
  };

  for (const { start, end: lineEnd, value } of lines) {
    const payload = value.payload ?? {};
    const ts = String(value.timestamp ?? "");
    if (value.type === "event_msg") {
      switch (payload.type) {
        case "task_started":
          close(start);
          open(String(payload.turn_id ?? start), ts, start);
          break;
        case "item_completed": {
          const item = payload.item ?? {};
          if (item.type === "UserMessage") addPrompt(codexHumanText(codexText(item.content)), payload.turn_id, ts, start);
          else if (item.type === "AgentMessage" && draft) {
            const text = codexText(item.content).trim();
            if (text && item.phase === "commentary") (draft as Draft).commentary = text;
            else if (text) (draft as Draft).reply = [text];
          }
          break;
        }
        case "user_message":
          // older Codex builds
          if (typeof payload.message === "string") addPrompt(payload.message, payload.turn_id, ts, start);
          break;
        case "agent_message":
          if (draft && typeof payload.message === "string" && payload.message.trim()) (draft as Draft).reply = [payload.message];
          break;
        case "task_complete":
          if (draft) {
            const current = draft as Draft;
            if (typeof payload.last_agent_message === "string" && payload.last_agent_message.trim()) {
              current.reply = [payload.last_agent_message];
            }
            close(lineEnd);
            continue;
          }
          break;
        case "turn_aborted":
          if (draft) {
            (draft as Draft).interrupted = true;
            close(lineEnd);
            continue;
          }
          break;
      }
    }
    if (!draft) consumed = lineEnd;
  }
  const current = draft as Draft | null;
  return {
    exchanges,
    offset: current ? current.start : Math.max(consumed, end),
    openNative: Boolean(current && !current.agoryx && current.prompts.length > 0),
    lastAgoryx,
  };
};

/** Reads complete exchanges from `offset` on. Throws only if the file cannot be read. */
export const scanNativeSession = (kind: AgentKind, file: string, offset = 0, lastAgoryx = true): NativeScan => {
  const { lines, from, end } = readLines(file, offset);
  const tail = from === 0 ? true : lastAgoryx;
  return kind === "claude" ? scanClaude(lines, from, end, tail) : scanCodex(lines, from, end, tail);
};
