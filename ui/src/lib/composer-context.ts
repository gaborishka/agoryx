import { local } from "./api";
import { type Quote, readQuote } from "./quote";
import type { RoomMessage, RoomSkill } from "./types";

export const COMMANDS = [
  { id: "stop", hint: "Stop the current run" },
  { id: "continue", hint: "Continue the conversation" },
  { id: "table", hint: "Show the room's table" },
  { id: "chat", hint: "Show the conversation" },
  { id: "files", hint: "Open the working folder" },
  { id: "changes", hint: "Open the room's changes" },
  { id: "doc", hint: "Open the shared document; /doc path assigns a file" },
  { id: "add", hint: "Open agents; /add codex or /add claude seats one" },
  { id: "model", hint: "Open model settings; /model @handle selects an agent" },
] as const;
export type CommandId = (typeof COMMANDS)[number]["id"];
export type ComposerTrigger = { kind: "context" | "command"; start: number; end: number; query: string; targets?: string[] };
export type ComposerChoice = { kind: "participant" | "file" | "command" | "skill" | "target"; value: string; label: string; detail: string; owner?: string; group?: string; skill?: RoomSkill };
export type ComposerAction = { kind: "skill"; skill: RoomSkill; targets: string[] } | { kind: "command"; command: CommandId; targets: string[] };
export const choiceKey = (choice: ComposerChoice) => `${choice.kind}:${choice.value}`;

/** Only the token at a collapsed caret, outside quoted lines and fenced code. */
export function composerTrigger(text: string, start: number, end = start): ComposerTrigger | null {
  if (start !== end || start < 0 || start > text.length) return null;
  const before = text.slice(0, start);
  const line = before.slice(before.lastIndexOf("\n") + 1);
  if (/^\s*>/.test(line)) return null;
  let fence: { mark: string; length: number } | null = null;
  for (const row of before.split("\n")) {
    const match = row.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!match) continue;
    const mark = match[1]![0]!;
    if (!fence) fence = { mark, length: match[1]!.length };
    else if (mark === fence.mark && match[1]!.length >= fence.length && !match[2]!.trim()) fence = null;
  }
  if (fence) return null;
  const slash = before.match(/^\s*((?:@[\w-]+\s+)*)\/([\p{L}\p{N}_:-]*)$/iu);
  if (slash) {
    const tokenStart = before.lastIndexOf("/");
    const targets = [...slash[1]!.matchAll(/@([\w-]+)/g)].map(m => m[1]!.toLowerCase());
    return { kind: "command", start: tokenStart, end: start + (text.slice(start).match(/^[\p{L}\p{N}_:-]*/u)?.[0].length ?? 0), query: slash[2]!, ...(targets.length ? { targets } : {}) };
  }
  const at = before.match(/(?:^|[^\w@])@([\p{L}\p{N}_./-]*)$/u);
  if (!at) return null;
  // An inline code span is literal text too.
  if ((line.slice(0, line.lastIndexOf("@")).match(/`/g)?.length ?? 0) % 2) return null;
  return { kind: "context", start: start - at[1]!.length - 1, end: start + (text.slice(start).match(/^[\p{L}\p{N}_./-]*/u)?.[0].length ?? 0), query: at[1]! };
}

export function composerChoices(trigger: ComposerTrigger | null, people: readonly { id: string; label: string }[], files: readonly string[], skills: readonly RoomSkill[] = [], filter = "all"): ComposerChoice[] {
  if (!trigger) return [];
  const query = trigger.query.toLowerCase();
  if (trigger.kind === "command") {
    const targets = trigger.targets?.filter(id => id !== "all") ?? (filter !== "all" && filter !== "room" ? [filter] : []);
    const onlyRoom = filter === "room" && !trigger.targets?.length;
    const skillChoices: ComposerChoice[] = onlyRoom ? [] : skills.filter(s =>
      targets.every(id => s.agents.includes(id)) && `${s.name} ${s.description}`.toLowerCase().includes(query),
    ).map(s => ({ kind: "skill", value: s.id, label: `/${s.name}`, detail: `${s.source} · ${s.description}${skills.filter(other => other.name === s.name).length > 1 ? ` · ${s.path}` : ""}`, owner: s.agents.map(id => people.find(p => p.id === id)?.label ?? id).join(" · "), skill: s }));
    const commands: ComposerChoice[] = COMMANDS.filter(c =>
      (c.id.startsWith(query) || c.hint.toLowerCase().includes(query)) && (!targets.length || c.id === "model") && (!onlyRoom || c.id !== "model"),
    ).map(c => ({ kind: "command", value: c.id, label: `/${c.id}`, detail: c.hint, group: c.id === "model" ? "Agent settings" : "Room commands", owner: c.id === "model" ? "Choose agent" : "Room" }));
    return [...skillChoices, ...commands];
  }
  const participants: ComposerChoice[] = [...people, { id: "all", label: "Everyone" }]
    .filter((p) => `${p.id} ${p.label}`.toLowerCase().includes(query))
    .slice(0, 6).map((p) => ({ kind: "participant", value: p.id, label: p.label, detail: `@${p.id}` }));
  const paths = files.filter((path) => path.toLowerCase().includes(query)).sort((a, b) => {
    const rank = (p: string) => p.split("/").at(-1)!.toLowerCase().startsWith(query) ? 0 : 1;
    return rank(a) - rank(b) || a.localeCompare(b);
  }).slice(0, 8).map((path): ComposerChoice => ({ kind: "file", value: path, label: path.split("/").at(-1)!, detail: path }));
  return [...participants, ...paths];
}

export function replaceComposerToken(text: string, trigger: ComposerTrigger, value: string) {
  const after = text.slice(trigger.end);
  const inserted = value + (value && (!after || /^[\w@/]/.test(after)) ? " " : "");
  return { text: text.slice(0, trigger.start) + inserted + after, caret: trigger.start + inserted.length };
}

/** A known single-line command. Ordinary paths and unknown /words remain messages. */
export function composerCommand(text: string): { id: CommandId; args: string } | null {
  const match = text.trim().match(/^\/([a-z]+)(?:[ \t]+([^\r\n]*))?$/i);
  const id = match?.[1]?.toLowerCase();
  if (!COMMANDS.some((c) => c.id === id)) return null;
  return { id: id as CommandId, args: match?.[2]?.trim() ?? "" };
}

/** The user's sent messages, newest first. Recalling one is a draft, never a send. */
export const composerHistoryMessages = (messages: readonly RoomMessage[], human: string) =>
  messages.filter((m) => m.kind === "human" && m.author === human && !m.native && m.text.trim()).slice().reverse();
export const composerHistory = (messages: readonly RoomMessage[], human: string) => composerHistoryMessages(messages, human).map(m => m.text);

export const saveComposerAction = (room: string, action: ComposerAction | null) => local.set(`action.${room}`, action ? JSON.stringify(action) : null);
export function savedComposerAction(room: string): ComposerAction | null {
  try {
    const a = JSON.parse(local.get(`action.${room}`) ?? "null");
    if (!a || !Array.isArray(a.targets) || a.targets.some((t: unknown) => typeof t !== "string")) return null;
    if (a.kind === "command" && COMMANDS.some(c => c.id === a.command)) return a;
    if (a.kind === "skill" && a.skill && ["id", "name", "path", "description", "source"].every(k => typeof a.skill[k] === "string") && Array.isArray(a.skill.agents) && a.skill.agents.every((id: unknown) => typeof id === "string")) return a;
  } catch { /* Invalid local draft. */ }
  return null;
}

/**
 * A sent message taken apart again for the composer: the files and quotes it opens with (as withContextFiles
 * and withQuotes wrote them) come back as chips, the rest as the draft. A block that would not be written
 * exactly so stays text. `authorOf`: who wrote a message or a turn (m12, t7) in this room.
 */
export function recallSent(text: string, authorOf: (id: string) => string | undefined): { body: string; quotes: Quote[]; files: string[] } {
  const blocks = text.split("\n\n");
  const files: string[] = [];
  const quotes: Quote[] = [];
  let at = 0;
  for (; at < blocks.length; at += 1) {
    const block = blocks[at]!;
    const file = quotes.length ? null : /^> File: \[(`+) (.*) \1\]\([^)]*\)$/.exec(block)?.[2];
    if (file !== undefined && file !== null && validContextPath(file) && withContextFiles("", [file]) === block) {
      files.push(file);
      continue;
    }
    const q = readQuote(block, authorOf);
    if (!q) break;
    quotes.push(q);
  }
  return { body: blocks.slice(at).join("\n\n"), quotes, files };
}

export function historyStep(index: number, direction: "older" | "newer", length: number): number {
  return direction === "older" ? Math.min(index + 1, length - 1) : Math.max(index - 1, -1);
}

/** In a recalled multiline message, arrows still move between its lines before leaving it. */
export function historyBoundary(text: string, start: number, end: number, direction: "older" | "newer"): boolean {
  if (start !== end) return false;
  return direction === "older" ? !text.slice(0, start).includes("\n") : !text.slice(end).includes("\n");
}

const draftKeys = (roomId: string) => [`draft.${roomId}`, `quotes.${roomId}`, `contextFiles.${roomId}`, `action.${roomId}`];
export const composerDraftSnapshot = (roomId: string) => draftKeys(roomId).map((key) => ({ key, value: local.get(key) }));
/** A successful send clears its saved draft even after navigation, but preserves edits made while it was pending. */
export const clearSentComposerDraft = (snapshot: ReturnType<typeof composerDraftSnapshot>) => {
  for (const { key, value } of snapshot) if (local.get(key) === value) local.set(key, null);
};

export const validContextPath = (path: unknown): path is string => typeof path === "string" && Boolean(path) && !/[\r\n\u2028\u2029]/.test(path) && !path.startsWith("/") && !path.startsWith("~/") && !path.split("/").includes("..");
export function savedContextFiles(roomId: string): string[] {
  try {
    const raw: unknown = JSON.parse(local.get(`contextFiles.${roomId}`) ?? "[]");
    return Array.isArray(raw) ? [...new Set(raw.filter(validContextPath))] : [];
  } catch { return []; }
}
export const saveContextFiles = (roomId: string, paths: string[]) => local.set(`contextFiles.${roomId}`, paths.length ? JSON.stringify(paths) : null);

/** File names are source context, so @ in a path cannot become a recipient. */
export const withContextFiles = (body: string, paths: readonly string[]) => {
  const links = paths.filter(validContextPath).map((path) => {
    const ticks = "`".repeat(Math.max(0, ...Array.from(path.matchAll(/`+/g), (m) => m[0].length)) + 1);
    const label = `${ticks} ${path} ${ticks}`;
    const href = path.split("/").map((part) => encodeURIComponent(part).replace(/[()']/g, (c) => `%${c.charCodeAt(0).toString(16)}`)).join("/");
    return `> File: [${label}](${href})`;
  });
  return [...links, body].filter(Boolean).join("\n\n");
};
