import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AttentionItem, AttentionReason } from "../agora/types.js";

/**
 * What the macOS app decides about rooms that wait for the human (docs/archive/plans/2026-09-29-desktop-attention.md,
 * Part A.4): whether the human looks at a room, the tray's and the banners' words, when a banner may show,
 * and the follower that polls the daemon's /api/attention. desktop/src/attention.ts only wires these to
 * Electron. Node built-ins and a type-only import: Electron's main process loads this file.
 */

export interface LookingInput {
  /** The focused window, when it is an Agoryx window (the main one or a daemon-origin child); else null. */
  window: { url: string; visible: boolean; minimized: boolean } | null;
  locked: boolean;
  daemonOrigin: string | null;
}

export interface Looking {
  room: string | null;
  looking: boolean;
}

/** The room in a UI hash (`#<id>`); `#new`, an empty or a malformed hash (`#%`) is none. */
const roomOfHash = (hash: string): string | null => {
  let raw: string;
  try {
    raw = decodeURIComponent(hash.replace(/^#/, ""));
  } catch {
    return null;
  }
  return raw && raw !== "new" ? raw : null;
};

/** Whether the human looks at a room in the app, and which. Never throws. */
export const lookingAt = (input: LookingInput): Looking => {
  const none: Looking = { room: null, looking: false };
  if (!input.window || !input.daemonOrigin) return none;
  let url: URL;
  try {
    url = new URL(input.window.url);
  } catch {
    return none;
  }
  // The start page, an agent's preview (`/raw/…`) or anything off the daemon: no room is on screen.
  if (url.origin !== input.daemonOrigin || url.pathname.startsWith("/raw/")) return none;
  const room = roomOfHash(url.hash);
  return { room, looking: input.window.visible && !input.window.minimized && !input.locked };
};

/** At most `max` characters, the last one "…" when cut; whitespace collapsed (names come from agents too). */
const cut = (text: string, max: number): string => {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
};

/** "1 room is waiting for you", "3 rooms are waiting for you". */
export const roomsWord = (n: number): string => (n === 1 ? "1 room is waiting for you" : `${n} rooms are waiting for you`);

const SHORT: Record<AttentionReason, (by: string | undefined) => string> = {
  done: () => "agents finished",
  budget: () => "turn limit reached",
  stopped: () => "stopped",
  mention: (by) => `${by ?? "an agent"} is calling you`,
  error: (by) => (by ? `${by}’s turn failed` : "a turn failed"),
  thread: (by) => (by ? `thread “${by}” reported` : "a thread reported"),
};

/** The tray's line for a room: “<name> — <short reason>”. */
export const trayLabel = (item: AttentionItem): string => `${cut(item.name, 40)} — ${SHORT[item.reason](item.by && cut(item.by, 40))}`;

export interface Banner {
  title: string;
  subtitle?: string;
  body: string;
  /** The room a click opens. */
  room: string;
}

const subtitleOf = (item: AttentionItem): string => {
  const by = item.by && cut(item.by, 60);
  switch (item.reason) {
    case "done":
      return "Agents finished — waiting for you";
    case "budget":
      return "Turn limit reached — waiting for you";
    case "stopped":
      return by ? `${by} stopped the conversation` : "The conversation was stopped";
    case "mention":
      return `${by ?? "An agent"} is asking for you`;
    case "error":
      return `${by ?? "An agent"}: the turn could not finish`;
    case "thread":
      return by ? `Thread “${by}” reported back` : "A thread reported back";
  }
};

const newer = (a: AttentionItem, b: AttentionItem): boolean => (a.ts === b.ts ? a.seq > b.seq : a.ts > b.ts);

/** One banner for the rooms that arrived together. `items` must not be empty. */
export const bannerFor = (items: AttentionItem[]): Banner => {
  const newest = items.reduce((best, item) => (newer(item, best) ? item : best));
  if (items.length === 1) return { title: cut(newest.name, 60), subtitle: subtitleOf(newest), body: newest.text, room: newest.room };
  const word = roomsWord(items.length);
  return {
    title: `${word.charAt(0).toUpperCase()}${word.slice(1)}`,
    body: cut(items.map((item) => cut(item.name, 60)).join(", "), 160),
    room: newest.room,
  };
};

export const BANNER_SETTLE_MS = 2500;
export const BANNER_GAP_MS = 10_000;

/** When the pending banner may show: 2.5 s after the first arrival (settle), 10 s after the last banner (cap). */
export const nextBannerAt = (firstPendingAt: number, lastBannerAt: number | null): number =>
  Math.max(firstPendingAt + BANNER_SETTLE_MS, lastBannerAt === null ? -Infinity : lastBannerAt + BANNER_GAP_MS);

export interface AttentionFollowerOptions {
  fetch?: typeof fetch;
  log?: (message: string) => void;
  /** How long one call may take before the daemon counts as not answering; default 3 s. */
  timeoutMs?: number;
}

export interface AttentionFollowerEvents {
  /** Any field of any item, or the connection, changed. */
  state: [items: AttentionItem[], connected: boolean];
  /** A room waits now and did not in the previous snapshot. */
  arrived: [item: AttentionItem];
}

const REASONS = new Set<string>(["done", "budget", "stopped", "error", "mention", "thread"]);

/** The daemon's `rooms`, or null for an answer that is not one. */
const parseItems = (rooms: unknown): AttentionItem[] | null => {
  if (!Array.isArray(rooms)) return null;
  const items: AttentionItem[] = [];
  for (const entry of rooms as unknown[]) {
    if (!entry || typeof entry !== "object") continue;
    const fields = entry as Record<string, unknown>;
    if (typeof fields.room !== "string" || typeof fields.name !== "string" || typeof fields.seq !== "number") continue;
    if (typeof fields.ts !== "string" || typeof fields.reason !== "string" || !REASONS.has(fields.reason) || typeof fields.text !== "string") continue;
    items.push({
      room: fields.room,
      name: fields.name,
      seq: fields.seq,
      ts: fields.ts,
      reason: fields.reason as AttentionReason,
      ...(typeof fields.by === "string" ? { by: fields.by } : {}),
      text: fields.text,
    });
  }
  return items;
};

/**
 * Follows one daemon's /api/attention for the app: reports where the app looks (`report`, each second),
 * and keeps the answer — the rooms that wait — as its snapshot. Only rooms new to the snapshot "arrive":
 * the first snapshot only seeds, a room's later item replaces its earlier one silently, and a new daemon
 * (a restart) keeps the snapshot. Never throws; a daemon that does not answer is "not connected".
 */
export class AttentionFollower extends EventEmitter<AttentionFollowerEvents> {
  /** This app run's view: the dev app and Agoryx.app never overwrite each other's. */
  readonly view = `app-${randomUUID()}`;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (message: string) => void;
  private readonly timeoutMs: number;
  private daemon: { url: string; token: string } | null = null;
  /** Grows with each daemon switch: an answer from the previous one is dropped. */
  private generation = 0;
  private snapshot: AttentionItem[] = [];
  private seeded = false;
  private ok = false;
  private reporting = false;
  /** Each call's number, in the order they start; an answer older than the last one accepted is dropped. */
  private calls = 0;
  private acceptedCall = 0;
  private disposed = false;
  private readonly logged = new Set<string>();

  constructor(options: AttentionFollowerOptions = {}) {
    super();
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.log = options.log ?? (() => {});
    this.timeoutMs = options.timeoutMs ?? 3000;
  }

  /** The daemon to call, or null: stop calling, not connected, the last items kept. The same url and token is a no-op. */
  setDaemon(info: { url: string; token: string } | null): void {
    if (this.disposed) return;
    if (info && this.daemon && info.url === this.daemon.url && info.token === this.daemon.token) return;
    this.daemon = info ? { url: info.url, token: info.token } : null;
    this.generation += 1;
    this.reporting = false;
    if (!info) this.connect(false);
  }

  /** Tells the daemon where the app looks; its answer is the new snapshot. Skipped while one is in flight. */
  async report(looking: Looking): Promise<void> {
    if (this.reporting || !this.daemon || this.disposed) return;
    this.reporting = true;
    const generation = this.generation;
    try {
      await this.call("view", { view: this.view, room: looking.room, looking: looking.looking });
    } finally {
      if (generation === this.generation) this.reporting = false;
    }
  }

  /**
   * The app stops looking (it quits): one last report, sent even while another is in flight, so the daemon
   * does not keep this view's room as watched until the view expires.
   */
  async leave(): Promise<void> {
    if (!this.daemon || this.disposed) return;
    await this.call("view", { view: this.view, room: null, looking: false });
  }

  /** Marks one room seen, or all of them when no room is given. */
  async markSeen(room?: string): Promise<void> {
    if (!this.daemon || this.disposed) return;
    await this.call("seen", room === undefined ? { all: true } : { room });
  }

  items(): AttentionItem[] {
    return [...this.snapshot];
  }

  /** The last call succeeded. */
  connected(): boolean {
    return this.ok;
  }

  dispose(): void {
    this.disposed = true;
    this.daemon = null;
    this.generation += 1;
    this.removeAllListeners();
  }

  private async call(what: "view" | "seen", body: unknown): Promise<void> {
    const daemon = this.daemon;
    if (!daemon) return;
    const generation = this.generation;
    const call = ++this.calls;
    const current = () => generation === this.generation && !this.disposed;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    let items: AttentionItem[] | null = null;
    try {
      const response = await this.fetchImpl(`${daemon.url}/api/attention/${what}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-agoryx-token": daemon.token },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (!current()) return;
        // An older daemon (404), or one that refuses the app: nothing to follow there.
        this.logOnce(`status ${response.status}`, `the daemon answered ${response.status} to /api/attention/${what}`);
        this.connect(false);
        return;
      }
      const answer = (await response.json()) as { rooms?: unknown } | null;
      if (!current()) return;
      items = parseItems(answer?.rooms);
      if (!items) {
        this.logOnce("answer", `the daemon's /api/attention/${what} answer has no rooms`);
        this.connect(false);
        return;
      }
    } catch (error) {
      if (!current()) return;
      const message = controller.signal.aborted ? `no answer in ${this.timeoutMs} ms` : error instanceof Error ? error.message : String(error);
      this.logOnce(`error ${message}`, `cannot reach the daemon: ${message}`);
      this.connect(false);
      return;
    } finally {
      clearTimeout(timer);
    }
    // A later call (a mark-seen next to a view report) has answered already: this snapshot is older than it.
    if (call < this.acceptedCall) return;
    this.acceptedCall = call;
    this.accept(items);
  }

  /** A new snapshot from the daemon. */
  private accept(items: AttentionItem[]): void {
    const before = this.snapshot;
    const waited = new Set(before.map((item) => item.room));
    const arrived = this.seeded ? items.filter((item) => !waited.has(item.room)) : [];
    const changed = !this.ok || JSON.stringify(before) !== JSON.stringify(items);
    this.snapshot = items;
    this.seeded = true;
    this.ok = true;
    this.logged.clear();
    if (changed) this.tell(() => this.emit("state", items, true));
    for (const item of arrived) this.tell(() => this.emit("arrived", item));
  }

  private connect(ok: boolean): void {
    if (this.ok === ok) return;
    this.ok = ok;
    this.tell(() => this.emit("state", this.items(), ok));
  }

  /** A listener's throw is logged, never passed back into a call. */
  private tell(emit: () => void): void {
    try {
      emit();
    } catch (error) {
      this.log(`attention listener failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Logs a message once until the next successful call. */
  private logOnce(key: string, message: string): void {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    this.log(message);
  }
}
