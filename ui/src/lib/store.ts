import { toast } from "sonner";
import { create } from "zustand";
import { api, ApiError, local, roomPath, setUnauthorizedHandler, Unauthorized } from "./api";
import { startAttention } from "./attention";
import { lastLine } from "./room";
import type { AgentPresence, OpEntry, RoomEvent, RoomSummary, RunState, Snapshot, TurnState } from "./types";

/**
 * The right-hand panel's tabs: an agent's own session, the shared document, the room's browser (in the app),
 * what turns changed, and the workspace's files. The table is a view of its own.
 */
export type PanelTab = "session" | "doc" | "browser" | "diff" | "files";
export const PANEL_TABS: readonly PanelTab[] = ["session", "doc", "browser", "diff", "files"];

/** Which changes the Зміни tab shows: one turn's, the whole room's against where it began, or one checkpoint. */
export type ChangeScope = "turn" | "room" | "commit";

export interface ChangesFocus {
  scope: ChangeScope;
  /** The turn (scope "turn"); none: the latest turn that changed something. */
  turn?: string;
  /** The checkpoint (scope "commit"); none: the latest. */
  sha?: string;
  /** One file of it, shown alone. */
  path?: string;
  /** Opened from «N дій»: the turn's actions start unfolded. Not kept in the address. */
  acts?: boolean;
}

/** What the room's main area shows: the conversation, or the table laid out as a board. */
export type RoomView = "chat" | "table";

export type DialogState =
  | { kind: "settings" }
  | { kind: "help" }
  | { kind: "keys" }
  | { kind: "table-form"; op: TableFormOp; target?: string; q?: string };

export type TableFormOp = "ask" | "propose" | "object" | "support" | "evidence" | "decide" | "settle" | "next";

export type Route = { kind: "room"; id: string } | { kind: "new" } | { kind: "boot" };

type Upsertable = { id: string };
const upsert = <T extends Upsertable>(list: T[], item: T): T[] => {
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index < 0) return [...list, item];
  const next = list.slice();
  next[index] = item;
  return next;
};

interface Store {
  route: Route;
  rooms: RoomSummary[];
  roomsLoaded: boolean;
  bootError: string | null;
  gate: boolean;
  snap: Snapshot | null;
  /** Messages already shown once — only newer ones animate in. */
  seen: Set<string>;
  panel: PanelTab | null;
  /** The tab the panel toggle opens: the one shown last. */
  lastTab: PanelTab;
  /** Whose session the session panel shows. */
  sessionAgent: string | null;
  changes: ChangesFocus;
  /** The file the Файли tab shows; null: the list. */
  filePath: string | null;
  /** Chat or table, remembered per room. */
  view: RoomView;
  wide: boolean;
  navOpen: boolean;
  dialog: DialogState | null;
  /** Doc panel: bumped when the canonical file changed, so the panel refetches. */
  docTick: number;
  /** Doc panel: bumped when the canonical file itself was reassigned. */
  docReset: number;
  lastDocRevision: { hash: string; by: string } | null;
  /** Revision to open in the doc panel (from a chip in the feed). */
  docFocus: number | null;
  flash: { ref: string; at: number } | null;
  /** Text put into the composer from elsewhere (a nudge on the table); `at` makes a repeat count. */
  compose: { text: string; at: number } | null;
  paletteOpen: boolean;

  loadRooms: () => Promise<void>;
  go: (route: Route) => void;
  openRoom: (id: string, quiet?: boolean) => Promise<void>;
  setPanel: (panel: PanelTab | null) => void;
  /** Open or close a tab; with none, the panel itself (on the tab shown last). */
  togglePanel: (tab?: PanelTab) => void;
  /** Show changes in the Зміни tab: a turn's (and one file of it), the room's, a checkpoint's. */
  openChanges: (focus: ChangesFocus) => void;
  /** Show a workspace file in the Файли tab; null: the list of files. */
  openFile: (path: string | null) => void;
  setDocFocus: (seq: number | null) => void;
  /** Show an agent's session in the side panel (the first agent's when none is named); again for the same agent closes it. */
  openSession: (agent?: string, toggle?: boolean) => void;
  setView: (view: RoomView) => void;
  setWide: (wide: boolean) => void;
  setNavOpen: (open: boolean) => void;
  openDialog: (dialog: DialogState | null) => void;
  goToRef: (ref: string) => void;
  /** Put a draft into the composer for the human to edit and send; nothing is sent. */
  composeDraft: (text: string) => void;
  openDocRevision: (seq: number) => void;
  setPaletteOpen: (open: boolean) => void;
  post: (suffix: string, body?: unknown) => Promise<Record<string, unknown>>;
}

let source: EventSource | null = null;
let reopenTimer: ReturnType<typeof setTimeout> | undefined;

const closeStream = () => {
  source?.close();
  source = null;
  clearTimeout(reopenTimer);
};

export const useStore = create<Store>((set, get) => ({
  route: { kind: "boot" },
  rooms: [],
  roomsLoaded: false,
  bootError: null,
  gate: false,
  snap: null,
  seen: new Set(),
  panel: null,
  lastTab: PANEL_TABS.includes(local.get("panelTab") as PanelTab) ? (local.get("panelTab") as PanelTab) : "session",
  sessionAgent: null,
  changes: { scope: "turn" },
  filePath: null,
  view: "chat",
  wide: local.get("wide") === "1",
  navOpen: false,
  dialog: null,
  docTick: 0,
  docReset: 0,
  lastDocRevision: null,
  docFocus: null,
  flash: null,
  compose: null,
  paletteOpen: false,

  async loadRooms() {
    try {
      const data = await api<{ rooms: RoomSummary[] }>("GET", "/api/rooms");
      const rooms = data.rooms.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      set({ rooms, roomsLoaded: true, bootError: null });
    } catch (error) {
      if (error instanceof Unauthorized) return;
      if (!get().roomsLoaded) set({ bootError: error instanceof Error ? error.message : String(error) });
    }
  },

  go(route) {
    const extra = routeState(route, null);
    const hash = hashFor({ ...get(), ...extra, route });
    if (location.hash !== hash) history.pushState(null, "", hash || location.pathname);
    applyRoute(route, extra);
  },

  async openRoom(id, quiet = false) {
    try {
      const snap = await api<Snapshot>("GET", roomPath(id));
      snap.ops ??= [];
      snap.streams ??= {};
      if (get().route.kind !== "room" || (get().route as { id: string }).id !== id) return;
      const fresh = !quiet || get().snap?.state.id !== id;
      set({
        snap,
        ...(fresh
          ? {
              seen: new Set(snap.state.messages.map((m) => m.id)),
              dialog: null,
              docTick: 0,
              docReset: get().docReset + 1,
              lastDocRevision: null,
              navOpen: false,
            }
          : {}),
      });
      document.title = `${snap.state.name} · Agoryx`;
      connect(id, snap.state.seq);
    } catch (error) {
      if (error instanceof Unauthorized) return;
      if (error instanceof ApiError && error.status === 404) {
        toast.error("Такої кімнати немає");
        const first = get().rooms.find((r) => r.id !== id);
        get().go(first ? { kind: "room", id: first.id } : { kind: "new" });
        return;
      }
      if (quiet) {
        reopenTimer = setTimeout(() => void get().openRoom(id, true), 3000);
        return;
      }
      toast.error(error instanceof Error ? error.message : String(error));
    }
  },

  setPanel(panel) {
    if (panel) local.set("panelTab", panel);
    set(panel ? { panel, lastTab: panel } : { panel });
  },
  togglePanel(tab) {
    const { panel, lastTab } = get();
    if (!tab) get().setPanel(panel ? null : lastTab);
    else get().setPanel(panel === tab ? null : tab);
  },
  openChanges(focus) {
    get().setPanel("diff");
    set({ changes: focus });
  },
  openFile(path) {
    get().setPanel("files");
    set({ filePath: path });
  },
  setDocFocus(docFocus) {
    set({ docFocus });
  },
  openSession(agent, toggle = false) {
    const { panel, sessionAgent, snap } = get();
    const target = agent ?? sessionAgent ?? snap?.state.agents[0]?.id ?? null;
    if (toggle && panel === "session" && sessionAgent === target) {
      set({ panel: null });
      return;
    }
    get().setPanel("session");
    set({ sessionAgent: target });
  },
  setView(view) {
    const route = get().route;
    if (route.kind === "room") local.set(`view.${route.id}`, view === "table" ? "table" : null);
    set({ view });
  },
  setWide(wide) {
    local.set("wide", wide ? "1" : null);
    set({ wide });
  },
  setNavOpen(navOpen) {
    set({ navOpen });
  },
  openDialog(dialog) {
    set({ dialog });
  },
  goToRef(ref) {
    get().setView(/^m-/.test(ref) ? "chat" : "table");
    set({ flash: { ref, at: Date.now() } });
  },
  composeDraft(text) {
    set({ compose: { text, at: Date.now() } });
  },
  openDocRevision(seq) {
    get().setPanel("doc");
    set({ docFocus: seq });
  },
  setPaletteOpen(paletteOpen) {
    set({ paletteOpen });
  },
  async post(suffix, body = {}) {
    const snap = get().snap;
    if (!snap) throw new Error("no room");
    return api("POST", roomPath(snap.state.id, suffix), body);
  },
}));

setUnauthorizedHandler(() => {
  closeStream();
  useStore.setState({ gate: true });
});

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------

type Patch = {
  seq: number;
  runs?: RunState[];
  presence?: Record<string, AgentPresence>;
  message?: Snapshot["state"]["messages"][number];
  turn?: TurnState;
  cursors?: Record<string, number>;
  sessions?: Snapshot["state"]["sessions"];
  table?: Snapshot["state"]["table"];
  settings?: Snapshot["state"]["settings"];
  name?: string;
  commits?: Snapshot["state"]["commits"];
  docRevisions?: Snapshot["state"]["docRevisions"];
  guests?: Snapshot["state"]["guests"];
  agents?: Snapshot["state"]["agents"];
  resume?: Snapshot["resume"];
  activity?: { turnId: string; activity: TurnState["activity"][number] };
};

const applyPatch = (event: RoomEvent, patch: Patch) => {
  const { snap, rooms } = useStore.getState();
  if (!snap || event.seq <= snap.state.seq) return;
  const st = { ...snap.state, seq: event.seq };
  const next: Snapshot = { ...snap, state: st };
  const extra: Partial<Store> = {};
  if (patch.runs) st.runs = patch.runs;
  if (patch.presence) next.presence = patch.presence;
  if (patch.message) st.messages = upsert(st.messages, patch.message);
  if (patch.turn) st.turns = upsert(st.turns, patch.turn);
  if (patch.cursors) st.cursors = patch.cursors;
  if (patch.sessions) st.sessions = patch.sessions;
  if (patch.table) st.table = patch.table;
  if (patch.settings) st.settings = patch.settings;
  if (patch.commits) st.commits = patch.commits;
  if (patch.docRevisions) st.docRevisions = patch.docRevisions;
  if (patch.guests) st.guests = patch.guests;
  if (patch.agents) st.agents = patch.agents;
  if (patch.resume) next.resume = patch.resume;
  if (patch.name) {
    st.name = patch.name;
    document.title = `${patch.name} · Agoryx`;
  }
  if (patch.activity) {
    const { turnId, activity } = patch.activity;
    st.turns = st.turns.map((turn) => (turn.id === turnId ? { ...turn, activity: upsert(turn.activity, activity) } : turn));
  }
  if (event.type === "table.op") next.ops = [...snap.ops, { seq: event.seq, ts: event.ts, op: event.op } satisfies OpEntry];
  if (event.type === "turn.ended") {
    const { [event.turnId]: _, ...rest } = snap.streams;
    next.streams = rest;
  }
  if (event.type === "turn.started") next.streams = { ...snap.streams, [event.turnId]: { agent: event.agent, text: "" } };
  if (event.type === "doc.revised") {
    extra.docTick = useStore.getState().docTick + 1;
    extra.lastDocRevision = { hash: event.hash, by: event.by };
  }
  if (event.type === "settings.changed" && "doc" in event.patch) {
    extra.docReset = useStore.getState().docReset + 1;
    extra.docFocus = null;
  }
  const touchesRoom =
    event.type === "turn.started" || event.type === "turn.ended" || event.type === "message.posted" || event.type === "room.renamed" || Boolean(patch.agents);
  if (touchesRoom) {
    extra.rooms = rooms.map((room) => {
      if (room.id !== st.id) return room;
      const working = st.turns.filter((t) => t.status === "running").map((t) => ({ agent: t.agent, since: t.startedAt }));
      const updated = { ...room, name: st.name, running: working.length > 0, working, agents: st.agents, updatedAt: event.ts };
      if (event.type === "message.posted" && event.message.kind !== "pass" && event.message.kind !== "system") {
        updated.lastMessage = lastLine(st, event.message);
      }
      return updated;
    });
  }
  useStore.setState({ snap: next, ...extra });
};

const applyStream = (data: { turnId: string; agent: string; text: string; reset?: boolean }) => {
  const { snap } = useStore.getState();
  if (!snap) return;
  const turn = snap.state.turns.find((t) => t.id === data.turnId);
  if (turn && turn.status !== "running") return;
  const before = snap.streams[data.turnId]?.text ?? "";
  const text = data.reset ? data.text : before + data.text;
  useStore.setState({ snap: { ...snap, streams: { ...snap.streams, [data.turnId]: { agent: data.agent, text } } } });
};

function connect(roomId: string, after: number) {
  closeStream();
  const es = new EventSource(`${roomPath(roomId, "/events")}?after=${after}`);
  source = es;
  es.addEventListener("room", (event) => {
    const { event: roomEvent, patch } = JSON.parse((event as MessageEvent).data) as { event: RoomEvent; patch: Patch };
    applyPatch(roomEvent, patch);
  });
  es.addEventListener("stream", (event) => applyStream(JSON.parse((event as MessageEvent).data)));
  es.addEventListener("presence", (event) => {
    const { agents } = JSON.parse((event as MessageEvent).data) as { agents: Record<string, AgentPresence> };
    const { snap } = useStore.getState();
    if (snap) useStore.setState({ snap: { ...snap, presence: agents } });
  });
  es.onerror = () => {
    if (source !== es) return;
    closeStream();
    reopenTimer = setTimeout(() => {
      const route = useStore.getState().route;
      if (route.kind === "room" && route.id === roomId) void useStore.getState().openRoom(roomId, true);
    }, 1500);
  };
}

// ---------------------------------------------------------------------------
// Routing: #<room id>, then what the room shows (?view=table&panel=diff&turn=t3&path=…); #new = start screen.
// Room changes are history entries; the panel, its tab and what it shows only replace the address.
// ---------------------------------------------------------------------------

const TURN_ID = /^t\d{1,9}$/;
const SHA = /^[0-9a-f]{7,40}$/;

const parseHash = (): { route: Route | null; params: URLSearchParams } => {
  const raw = location.hash.slice(1);
  const cut = raw.indexOf("?");
  const params = new URLSearchParams(cut < 0 ? "" : raw.slice(cut + 1));
  let head: string;
  try {
    head = decodeURIComponent(cut < 0 ? raw : raw.slice(0, cut));
  } catch {
    return { route: null, params };
  }
  if (head === "new") return { route: { kind: "new" }, params };
  return { route: head ? { kind: "room", id: head } : null, params };
};

type Addressed = Pick<Store, "route" | "view" | "panel" | "changes" | "filePath" | "sessionAgent" | "docFocus">;

/** The address of what the page shows. */
const hashFor = (s: Addressed): string => {
  if (s.route.kind === "new") return "#new";
  if (s.route.kind !== "room") return "";
  const p = new URLSearchParams();
  if (s.view === "table") p.set("view", "table");
  if (s.panel) {
    p.set("panel", s.panel);
    if (s.panel === "diff") {
      const c = s.changes;
      if (c.scope !== "turn") p.set("scope", c.scope);
      if (c.scope === "turn" && c.turn) p.set("turn", c.turn);
      if (c.scope === "commit" && c.sha) p.set("commit", c.sha);
      if (c.path) p.set("path", c.path);
    } else if (s.panel === "files" && s.filePath) p.set("path", s.filePath);
    else if (s.panel === "session" && s.sessionAgent) p.set("agent", s.sessionAgent);
    else if (s.panel === "doc" && s.docFocus != null) p.set("rev", String(s.docFocus));
  }
  const query = p.toString();
  return `#${encodeURIComponent(s.route.id)}${query ? `?${query}` : ""}`;
};

/** Nothing of another room's selected: its own turns, files and revisions. */
const FRESH = { changes: { scope: "turn" } as ChangesFocus, filePath: null, docFocus: null };

/**
 * What entering a room sets besides the route. From an address (`params`): what it says, the view otherwise
 * as last left in that room. From the sidebar or the palette (null): the open tab stays, on the new room's things.
 */
const routeState = (route: Route, params: URLSearchParams | null): Partial<Store> => {
  if (route.kind !== "room") return {};
  const s = useStore.getState();
  const same = s.route.kind === "room" && s.route.id === route.id;
  const remembered: RoomView = local.get(`view.${route.id}`) === "table" ? "table" : "chat";
  // A bare #<room> (the app opening a room it is already on) leaves what is shown as it is.
  if (!params || (same && !params.size)) return same ? {} : { view: remembered, ...FRESH };
  const view = params.get("view");
  // The view an address names is the one now shown here, so it is remembered: the rewritten address omits chat.
  if (view === "table" || view === "chat") local.set(`view.${route.id}`, view === "table" ? "table" : null);
  const tab = params.get("panel") as PanelTab | null;
  // An address without a panel closes it in this room; another room's address keeps the tab open.
  const panel = tab && PANEL_TABS.includes(tab) ? tab : same ? null : s.panel;
  const turn = params.get("turn");
  const sha = params.get("commit");
  const scope = params.get("scope");
  const path = params.get("path") || undefined;
  const rev = Number.parseInt(params.get("rev") ?? "", 10);
  return {
    view: view === "table" || view === "chat" ? view : remembered,
    panel,
    ...(panel ? { lastTab: panel } : {}),
    changes: {
      scope: scope === "room" ? "room" : scope === "commit" || sha ? "commit" : "turn",
      ...(turn && TURN_ID.test(turn) ? { turn } : {}),
      ...(sha && SHA.test(sha) ? { sha } : {}),
      ...(path && panel === "diff" ? { path } : {}),
    },
    filePath: panel === "files" ? (path ?? null) : null,
    sessionAgent: params.get("agent") || s.sessionAgent,
    docFocus: panel === "doc" && Number.isFinite(rev) ? rev : null,
  };
};

function applyRoute(route: Route, extra: Partial<Store> = {}) {
  const { route: prev, rooms } = useStore.getState();
  // Opening a room is looking at it (the daemon hears it from startAttention): its row stops counting at once.
  if (route.kind === "room") extra = { ...extra, rooms: rooms.map((room) => (room.id === route.id && (room.unread || room.waiting) ? { ...room, unread: 0, waiting: undefined } : room)) };
  useStore.setState({ route, navOpen: false, ...extra });
  if (route.kind === "room") {
    if (prev.kind !== "room" || prev.id !== route.id || !useStore.getState().snap) {
      closeStream();
      useStore.setState({ snap: null, compose: null });
      void useStore.getState().openRoom(route.id);
    }
  } else {
    closeStream();
    useStore.setState({ snap: null, compose: null });
    document.title = "Agoryx";
  }
}

export const syncRoute = () => {
  // One hash change fires popstate and hashchange; the second, and our own rewrites, already match what is shown.
  if (location.hash && location.hash === hashFor(useStore.getState())) return;
  const { route, params } = parseHash();
  if (route) {
    applyRoute(route, routeState(route, params));
    return;
  }
  const first = useStore.getState().rooms[0];
  const target: Route = first ? { kind: "room", id: first.id } : { kind: "new" };
  const extra = routeState(target, null);
  history.replaceState(null, "", hashFor({ ...useStore.getState(), ...extra, route: target }));
  applyRoute(target, extra);
};

/** The address follows the panel, its tab and what it shows, without new history entries. */
const followAddress = () =>
  useStore.subscribe((s, prev) => {
    if (s.route.kind === "boot") return;
    if (
      s.route === prev.route &&
      s.view === prev.view &&
      s.panel === prev.panel &&
      s.changes === prev.changes &&
      s.filePath === prev.filePath &&
      s.sessionAgent === prev.sessionAgent &&
      s.docFocus === prev.docFocus
    )
      return;
    const hash = hashFor(s);
    if (hash && hash !== location.hash) history.replaceState(null, "", hash);
  });

export const boot = async () => {
  await useStore.getState().loadRooms();
  if (useStore.getState().gate || useStore.getState().bootError) return;
  syncRoute();
  followAddress();
  window.addEventListener("popstate", syncRoute);
  window.addEventListener("hashchange", syncRoute);
  startAttention(
    () => {
      const s = useStore.getState();
      return s.route.kind === "room" ? (s.snap?.state.id ?? s.route.id) : null;
    },
    (fn) => useStore.subscribe(fn),
  );
  setInterval(() => void useStore.getState().loadRooms(), 5000);
};

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export const useRoom = () => useStore((s) => s.snap?.state);
