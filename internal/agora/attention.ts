import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agoraHome, roomsDir } from "./paths.js";
import type { AttentionItem, AttentionReason, EphemeralEvent, RoomEvent, RoomState } from "./types.js";

/**
 * Which rooms wait for the human, and which room the human looks at (docs/plans/2026-09-29-desktop-attention.md).
 *
 * Agoryx only observes here: nothing is written into a room, and no agent is told anything. An item is
 * derived from a room's own log — the event that needs the human, keyed by (room, seq) — and lives while
 * the human's seen cursor for that room is below it. The cursors are the only state kept, in
 * `<agoraHome>/attention.json`; where each client looks is kept in memory and expires.
 */

/** Where one client (the app, or a browser tab) looks; in memory only. */
export interface AttentionView {
  view: string;
  room: string | null;
  looking: boolean;
}

/** What the board reads from a room: its store (RoomStore fits). */
export interface AttentionLog {
  readonly state: RoomState;
  since(seq: number): RoomEvent[];
}

export type RoomListener = (event: RoomEvent | EphemeralEvent) => void;

export interface AttentionBoardOptions {
  env: NodeJS.ProcessEnv;
  now?: () => number;
  viewTtlMs?: number;
  saveMs?: number;
  log?: (message: string) => void;
}

/** `<agoraHome>/attention.json`: the seen cursor per room. */
export const attentionFile = (env: NodeJS.ProcessEnv = process.env): string => join(agoraHome(env), "attention.json");

const TEXT_MAX = 160;
const MAX_VIEWS = 64;

/** One line, whitespace collapsed, at most 160 characters with "…". */
const oneLine = (text: string): string => {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > TEXT_MAX ? `${chars.slice(0, TEXT_MAX - 1).join("")}…` : chars.join("");
};

/** Who did it, as the human reads it: an agent's label, or a guest's "<agent>@<room>" handle as recorded. */
const whoLabel = (state: RoomState, handle: string, guest: boolean): string =>
  guest ? handle : (state.agents.find((agent) => agent.id === handle)?.label ?? handle);

/** Whether an event needs the human, and why. Pure. */
export const attentionOf = (state: RoomState, event: RoomEvent): Omit<AttentionItem, "room" | "name"> | null => {
  const at = { seq: event.seq, ts: event.ts };
  if (event.type === "message.posted") {
    const message = event.message;
    if ((message.kind !== "agent" && message.kind !== "update") || message.native) return null;
    if (!message.mentions.includes(state.human.toLowerCase())) return null;
    return { ...at, reason: "mention", by: whoLabel(state, message.author, Boolean(message.from)), text: oneLine(message.text) };
  }
  if (event.type !== "run.ended") return null;
  const posted = state.messages.filter(
    (message) => message.runId === event.runId && (message.kind === "agent" || message.kind === "update") && !message.native && message.seq < event.seq,
  );
  const text = posted.length > 0 ? oneLine(posted[posted.length - 1]!.text) : "";
  if (event.reason === "stopped") {
    // The human's own stop never counts; an agent's, a guest's, or one nobody is credited with (a crash
    // recovered, a daemon ended by a signal) cut the run short without the human's decision.
    if (event.by !== undefined && !event.from && !state.agents.some((agent) => agent.id === event.by)) return null;
    return { ...at, reason: "stopped", ...(event.by !== undefined ? { by: whoLabel(state, event.by, Boolean(event.from)) } : {}), text };
  }
  const failed = state.turns.find((turn) => turn.runId === event.runId && turn.status === "error" && (turn.endSeq ?? event.seq) < event.seq);
  if (failed) {
    const line = (failed.error?.message ?? "").split(/\r?\n/).find((part) => part.trim()) ?? "";
    return { ...at, reason: "error", by: whoLabel(state, failed.agent, false), text: oneLine(line) };
  }
  // A run in which every turn passed leaves nothing for the human.
  if (posted.length === 0) return null;
  const reason: AttentionReason = event.reason === "budget" ? "budget" : "done";
  return { ...at, reason, text };
};

/** A view report from `POST /api/attention/view`, or the text of the 400. */
export const parseView = (body: unknown): AttentionView | string => {
  const fields = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  if (typeof fields.view !== "string" || !/^[\w-]{1,64}$/.test(fields.view)) return "view must be 1-64 letters, digits, _ or -";
  if (fields.room !== null && (typeof fields.room !== "string" || fields.room.length > 200)) return "room must be null or a room id";
  if (typeof fields.looking !== "boolean") return "looking must be true or false";
  return { view: fields.view, room: fields.room, looking: fields.looking };
};

type Found = Omit<AttentionItem, "room" | "name">;

interface Tracked {
  log: () => AttentionLog;
  /** The room's unseen item: its seq is always above the room's seen cursor. */
  item?: Found;
  /** A failure in the listener was logged (once per room). */
  failed?: boolean;
}

const APP_VIEW_TTL_MS = 10_000;

interface ViewRecord {
  room: string | null;
  looking: boolean;
  at: number;
}

/** The seen cursors on disk; unreadable or foreign content counts as none. */
const readSeen = (path: string): Record<string, number> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
  const seen: Record<string, number> = {};
  const fields = parsed && typeof parsed === "object" ? (parsed as { version?: unknown; seen?: unknown }) : {};
  if (fields.version !== 1 || !fields.seen || typeof fields.seen !== "object") return seen;
  for (const [room, seq] of Object.entries(fields.seen as Record<string, unknown>)) {
    if (typeof seq === "number" && Number.isInteger(seq) && seq >= 0) seen[room] = seq;
  }
  return seen;
};

/**
 * The rooms that wait for the human. Tracks the rooms the daemon holds a handle for, through one
 * listener each; never appends to a room, and never throws into a room's listeners.
 */
export class AttentionBoard {
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly viewTtlMs: number;
  private readonly saveMs: number;
  private readonly log: (message: string) => void;
  private readonly file: string;
  /** The highest seq the human has seen, per room. */
  private readonly seen: Record<string, number>;
  private readonly rooms = new Map<string, Tracked>();
  private readonly views = new Map<string, ViewRecord>();
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private closed = false;
  private saveFailed = false;

  constructor(options: AttentionBoardOptions) {
    this.env = options.env;
    this.now = options.now ?? Date.now;
    this.viewTtlMs = options.viewTtlMs ?? 45_000;
    this.saveMs = options.saveMs ?? 1000;
    this.log = options.log ?? (() => {});
    this.file = attentionFile(this.env);
    this.seen = readSeen(this.file);
    // A room whose folder is gone has nothing left to wait for.
    const root = roomsDir(this.env);
    for (const room of Object.keys(this.seen)) {
      if (!existsSync(join(root, room, "events.jsonl"))) {
        delete this.seen[room];
        this.schedule();
      }
    }
  }

  /** Follows one room's events; a no-op for a room already tracked. Never throws into the room's listeners. */
  track(room: string, log: () => AttentionLog, listeners: Set<RoomListener>): void {
    if (this.rooms.has(room)) return;
    const entry: Tracked = { log };
    this.rooms.set(room, entry);
    try {
      const store = log();
      const cursor = this.seen[room];
      if (cursor === undefined || this.watched(room)) {
        // Seen for the first time (or on screen now): what is already there raises nothing.
        this.advance(room, entry, store.state.seq);
      } else {
        for (const event of store.since(cursor)) this.consider(room, entry, store.state, event);
      }
    } catch (error) {
      this.failed(room, entry, error);
    }
    listeners.add((event) => {
      if (!("seq" in event) || typeof event.seq !== "number") return;
      try {
        if (this.watched(room)) this.advance(room, entry, event.seq);
        else this.consider(room, entry, entry.log().state, event);
      } catch (error) {
        this.failed(room, entry, error);
      }
    });
  }

  /** One client's report of where it looks. Starting to look at a room marks it seen. */
  view(report: AttentionView): void {
    const now = this.now();
    const previous = this.views.get(report.view);
    const already = previous !== undefined && this.fresh(report.view, previous, now) && previous.looking && previous.room === report.room;
    this.views.delete(report.view);
    for (const [id, record] of this.views) {
      if (!this.fresh(id, record, now)) this.views.delete(id);
    }
    this.views.set(report.view, { room: report.room, looking: report.looking, at: now });
    while (this.views.size > MAX_VIEWS) {
      let oldest: string | undefined;
      let oldestAt = Infinity;
      for (const [id, record] of this.views) {
        if (record.at < oldestAt) {
          oldest = id;
          oldestAt = record.at;
        }
      }
      if (oldest === undefined) break;
      this.views.delete(oldest);
    }
    if (report.looking && report.room !== null && !already) this.markSeen(report.room);
  }

  /** Everything in the room so far is seen. An unknown room is a no-op. */
  markSeen(room: string): void {
    const entry = this.rooms.get(room);
    if (!entry) return;
    try {
      this.advance(room, entry, entry.log().state.seq);
    } catch (error) {
      this.failed(room, entry, error);
    }
  }

  markAllSeen(): void {
    for (const room of this.rooms.keys()) this.markSeen(room);
  }

  item(room: string): AttentionItem | undefined {
    const entry = this.rooms.get(room);
    if (!entry?.item) return undefined;
    let name = room;
    try {
      name = entry.log().state.name;
    } catch {
      // the id stands in for the name
    }
    return { room, name, ...entry.item };
  }

  /** Newest first. */
  items(): AttentionItem[] {
    const items: AttentionItem[] = [];
    for (const room of this.rooms.keys()) {
      const item = this.item(room);
      if (item) items.push(item);
    }
    return items.sort((a, b) => (a.ts === b.ts ? b.seq - a.seq : a.ts < b.ts ? 1 : -1));
  }

  /** Flushes the pending save. */
  close(): void {
    this.closed = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (this.dirty) this.save();
  }

  /** The app reports every second, so its views ("app-…") expire after 10 s: a crashed app stops counting soon. */
  private fresh(id: string, record: ViewRecord, now: number): boolean {
    const ttl = id.startsWith("app-") ? Math.min(this.viewTtlMs, APP_VIEW_TTL_MS) : this.viewTtlMs;
    return now - record.at <= ttl;
  }

  /** Some client looks at this room now. */
  private watched(room: string): boolean {
    const now = this.now();
    for (const [id, record] of this.views) {
      if (record.looking && record.room === room && this.fresh(id, record, now)) return true;
    }
    return false;
  }

  /** An event the human has not seen: it becomes the room's item unless the precedence keeps the current one. */
  private consider(room: string, entry: Tracked, state: RoomState, event: RoomEvent): void {
    if (event.seq <= (this.seen[room] ?? 0)) return;
    const found = attentionOf(state, event);
    if (!found) return;
    // "Done" says less than a question, a stop, an error or a spent budget: it never hides one unseen.
    if (entry.item && found.reason === "done" && entry.item.reason !== "done") return;
    entry.item = found;
  }

  private advance(room: string, entry: Tracked, seq: number): void {
    if (entry.item && entry.item.seq <= seq) entry.item = undefined;
    if (this.seen[room] !== undefined && this.seen[room] >= seq) return;
    this.seen[room] = seq;
    this.schedule();
  }

  private failed(room: string, entry: Tracked, error: unknown): void {
    if (entry.failed) return;
    entry.failed = true;
    this.log(`attention: cannot follow room ${room}: ${error instanceof Error ? error.message : String(error)}`);
  }

  private schedule(): void {
    this.dirty = true;
    if (this.saveTimer || this.closed) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, this.saveMs);
    this.saveTimer.unref?.();
  }

  private save(): void {
    this.dirty = false;
    // Renamed into place: a reader sees the whole old file or the whole new one.
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      rmSync(tmp, { force: true });
      writeFileSync(tmp, `${JSON.stringify({ version: 1, seen: this.seen }, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, this.file);
      this.saveFailed = false;
    } catch (error) {
      if (!this.saveFailed) this.log(`attention: cannot save ${this.file}: ${error instanceof Error ? error.message : String(error)}`);
      this.saveFailed = true;
    }
  }
}
