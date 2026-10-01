import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { originName } from "./actor.js";
import { type AgentLook, agentLook } from "./look.js";
import { applyEvent, initialState } from "./projection.js";
import type {
  ActorOrigin,
  EphemeralEvent,
  RoomAgent,
  RoomCreatedEvent,
  RoomEvent,
  RoomEventBody,
  RoomSettings,
  RoomState,
  RoomWorktree,
  SystemNote,
} from "./types.js";

export type StoreListener = (event: RoomEvent | EphemeralEvent) => void;

export interface CreateRoomInput {
  name: string;
  workspace: string;
  createdWorkspace: boolean;
  worktree?: RoomWorktree;
  human: string;
  agents: RoomAgent[];
  settings: RoomSettings;
  id?: string;
  /** An agent opened the room from another room. */
  createdBy?: ActorOrigin;
}

export interface RoomSummary {
  id: string;
  name: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  messages: number;
  /**
   * `label` is the author's display name when an agent wrote it: a room list has no roster to look it up in.
   * `look`: that agent's shade and mark, only when it shares its kind with another agent in the room.
   */
  /** `sys`: what the line means when Agoryx wrote it (a decision), for a reader in another language. */
  lastMessage?: { author: string; text: string; label?: string; look?: AgentLook; sys?: SystemNote };
  running: boolean;
  /** Who sits in the room, in roster order: enough for a room list to draw their avatars. */
  agents: Array<Pick<RoomAgent, "id" | "kind" | "label">>;
  /** The agents whose turn runs now and since when; absent when nobody works. */
  working?: Array<{ agent: string; since: string }>;
  /** The folder the human started the room in; absent when Agoryx made one. */
  folder?: string;
  /** The room's own branch, when it works in a worktree. */
  branch?: string;
}

const EVENTS_FILE = "events.jsonl";

const UK_TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "ie", ж: "zh", з: "z", и: "y", і: "i",
  ї: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u",
  ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ь: "", ю: "iu", я: "ia", ы: "y", э: "e", ё: "e", ъ: "",
};

export const slugify = (name: string): string => {
  const translit = [...name.toLowerCase()].map((char) => UK_TRANSLIT[char] ?? char).join("");
  const slug = translit
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "room";
};

export const newRoomId = (name: string): string => `${slugify(name)}-${randomBytes(2).toString("hex")}`;

const parseLines = (text: string): { events: RoomEvent[]; consumed: number } => {
  const events: RoomEvent[] = [];
  let consumed = 0;
  let start = 0;
  while (start < text.length) {
    const end = text.indexOf("\n", start);
    if (end === -1) break; // partial trailing line: wait for the writer
    const line = text.slice(start, end).trim();
    start = end + 1;
    consumed = start;
    if (!line) continue;
    try {
      events.push(JSON.parse(line) as RoomEvent);
    } catch {
      // A corrupt line (e.g. a crash mid-write followed by more writes) is skipped.
    }
  }
  return { events, consumed: Buffer.byteLength(text.slice(0, consumed)) };
};

/**
 * Append-only JSONL event log for one room plus its in-memory projection.
 * One process writes (the daemon or a foreground `agoryx` run); others may
 * read and follow the file with refresh().
 */
export class RoomStore {
  readonly dir: string;
  readonly file: string;
  readonly events: RoomEvent[] = [];
  state!: RoomState;
  private offset = 0;
  private tailChecked = false;
  private readonly listeners = new Set<StoreListener>();

  private constructor(dir: string) {
    this.dir = dir;
    this.file = join(dir, EVENTS_FILE);
  }

  static create(root: string, input: CreateRoomInput): RoomStore {
    const id = input.id ?? newRoomId(input.name);
    const dir = join(root, id);
    if (existsSync(join(dir, EVENTS_FILE))) throw new Error(`room ${id} already exists`);
    mkdirSync(dir, { recursive: true });
    const store = new RoomStore(dir);
    const created: RoomCreatedEvent = {
      type: "room.created",
      id,
      name: input.name,
      workspace: input.workspace,
      createdWorkspace: input.createdWorkspace,
      ...(input.worktree ? { worktree: input.worktree } : {}),
      human: input.human,
      agents: input.agents,
      settings: input.settings,
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    };
    const event = { ...created, seq: 1, ts: new Date().toISOString() };
    appendFileSync(store.file, `${JSON.stringify(event)}\n`);
    store.offset = Buffer.byteLength(`${JSON.stringify(event)}\n`);
    store.events.push(event);
    store.state = initialState(event);
    return store;
  }

  static open(root: string, id: string): RoomStore {
    const dir = join(root, id);
    const file = join(dir, EVENTS_FILE);
    if (!existsSync(file)) throw new Error(`no room '${id}'`);
    const store = new RoomStore(dir);
    const { events, consumed } = parseLines(readFileSync(file, "utf8"));
    const first = events[0];
    if (!first || first.type !== "room.created") throw new Error(`room '${id}' has a corrupt event log`);
    store.state = initialState(first);
    store.events.push(first);
    for (const event of events.slice(1)) {
      store.events.push(event);
      applyEvent(store.state, event);
    }
    store.offset = consumed;
    return store;
  }

  static list(root: string): RoomSummary[] {
    if (!existsSync(root)) return [];
    const rooms: RoomSummary[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const store = RoomStore.open(root, entry.name);
        rooms.push(store.summary());
      } catch {
        // skip unreadable rooms
      }
    }
    return rooms.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * Resolve a room by id, id prefix, or name; with no ref, by the workspace
   * containing cwd, then by most recently active.
   */
  static resolveId(root: string, ref: string | undefined, cwd: string): string {
    const rooms = RoomStore.list(root);
    if (rooms.length === 0) throw new Error("no rooms yet — create one with `agoryx new <name>`");
    if (ref) {
      const lower = ref.toLowerCase();
      const exact = rooms.find((room) => room.id === ref);
      if (exact) return exact.id;
      const byName = rooms.filter((room) => room.name.toLowerCase() === lower);
      if (byName.length === 1) return byName[0]!.id;
      const byPrefix = rooms.filter((room) => room.id.startsWith(lower));
      if (byPrefix.length === 1) return byPrefix[0]!.id;
      if (byPrefix.length > 1 || byName.length > 1) throw new Error(`'${ref}' matches several rooms; use the full id`);
      throw new Error(`no room matches '${ref}'`);
    }
    const here = resolve(cwd);
    // The deepest workspace holding cwd wins (a room in repo/sub beats one in repo); a tie is ambiguous.
    const holding = rooms.filter((room) => here === room.workspace || here.startsWith(`${room.workspace}${sep}`));
    if (holding.length > 0) {
      const depth = Math.max(...holding.map((room) => room.workspace.length));
      const deepest = holding.filter((room) => room.workspace.length === depth);
      if (deepest.length > 1) {
        throw new Error(`${deepest.length} rooms work in ${deepest[0]!.workspace}: ${deepest.map((room) => room.id).join(", ")}; name one with --room`);
      }
      return deepest[0]!.id;
    }
    return rooms[0]!.id;
  }

  get id(): string {
    return this.state.id;
  }

  summary(): RoomSummary {
    const last = [...this.state.messages].reverse().find((message) => message.kind !== "pass" && message.kind !== "system");
    const lastEvent = this.events[this.events.length - 1]!;
    const lastBy = last ? (this.state.agents.find((agent) => agent.id === last.author) ?? this.state.former?.find((agent) => agent.id === last.author)) : undefined;
    const look = lastBy ? agentLook(this.state.agents, lastBy.id) : undefined;
    const lastGuest = last && !lastBy ? this.state.guests?.[last.author] : undefined;
    const lastLabel = lastBy ? lastBy.label : lastGuest ? originName(lastGuest) : undefined;
    const working = this.state.turns.filter((turn) => turn.status === "running").map((turn) => ({ agent: turn.agent, since: turn.startedAt }));
    return {
      id: this.state.id,
      name: this.state.name,
      workspace: this.state.workspace,
      createdAt: this.state.createdAt,
      updatedAt: lastEvent.ts,
      messages: this.state.messages.filter((message) => message.kind !== "pass").length,
      ...(last ? { lastMessage: { author: last.author, text: last.text.slice(0, 200), ...(lastLabel ? { label: lastLabel } : {}), ...(look?.mark ? { look } : {}), ...(last.sys ? { sys: last.sys } : {}) } } : {}),
      running: working.length > 0,
      agents: this.state.agents.map(({ id, kind, label }) => ({ id, kind, label })),
      ...(working.length > 0 ? { working } : {}),
      ...(this.state.worktree
        ? { folder: this.state.worktree.source, branch: this.state.worktree.branch }
        : this.state.createdWorkspace
          ? {}
          : { folder: this.state.workspace }),
    };
  }

  append(body: RoomEventBody): RoomEvent {
    let line = `${JSON.stringify({ ...body, seq: this.state.seq + 1, ts: new Date().toISOString() })}\n`;
    if (!this.tailChecked) {
      // A crash mid-write can leave a partial last line. Appending straight after it would glue the new
      // event onto the fragment and lose it on the next replay; start on a fresh line instead.
      this.tailChecked = true;
      const size = statSync(this.file).size;
      if (size > this.offset) {
        line = `\n${line}`;
        this.offset = size;
      }
    }
    // Apply the serialized form so the live state is exactly what a replay produces.
    const event = JSON.parse(line) as RoomEvent;
    appendFileSync(this.file, line);
    this.offset += Buffer.byteLength(line);
    this.events.push(event);
    applyEvent(this.state, event);
    this.notify(event);
    return event;
  }

  emit(event: EphemeralEvent): void {
    this.notify(event);
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  since(seq: number): RoomEvent[] {
    // Usually dense by seq (index = seq), but a corrupt line skipped on replay leaves a gap.
    const at = Math.max(0, seq);
    const start = this.events[at - 1]?.seq === at ? at : 0;
    return this.events.slice(start).filter((event) => event.seq > at);
  }

  /** Pick up events appended by another process (read-only followers). */
  refresh(): RoomEvent[] {
    const fd = openSync(this.file, "r");
    try {
      const size = fstatSync(fd).size;
      if (size <= this.offset) return [];
      const buffer = Buffer.alloc(size - this.offset);
      readSync(fd, buffer, 0, buffer.length, this.offset);
      const { events, consumed } = parseLines(buffer.toString("utf8"));
      this.offset += consumed;
      const fresh = events.filter((event) => event.seq > this.state.seq);
      for (const event of fresh) {
        this.events.push(event);
        applyEvent(this.state, event);
        this.notify(event);
      }
      return fresh;
    } finally {
      closeSync(fd);
    }
  }

  private notify(event: RoomEvent | EphemeralEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // listeners must not break the writer
      }
    }
  }
}
