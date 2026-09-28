import { toast } from "sonner";
import { create } from "zustand";
import { api, ApiError, local, roomPath, setUnauthorizedHandler, Unauthorized } from "./api";
import type { AgentPresence, OpEntry, RoomEvent, RoomSummary, RunState, Snapshot, TurnState } from "./types";

/** The right-hand panel holds the shared document; the table is a view of its own. */
export type PanelTab = "doc";

/** What the room's main area shows: the conversation, or the table laid out as a board. */
export type RoomView = "chat" | "table";

export type DialogState =
  | { kind: "file"; path: string }
  | { kind: "turn-diff"; turnId: string; path?: string }
  | { kind: "commit"; sha: string }
  | { kind: "files" }
  | { kind: "sessions" }
  | { kind: "settings" }
  | { kind: "help" }
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
  togglePanel: (tab: PanelTab) => void;
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
  view: local.get("view") === "table" ? "table" : "chat",
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
    const hash = route.kind === "room" ? `#${encodeURIComponent(route.id)}` : route.kind === "new" ? "#new" : "";
    if (location.hash !== hash) history.pushState(null, "", hash || location.pathname);
    applyRoute(route);
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
              docFocus: null,
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
    set({ panel });
  },
  togglePanel(tab) {
    const { panel } = get();
    get().setPanel(panel === tab ? null : tab);
  },
  setView(view) {
    local.set("view", view === "table" ? "table" : null);
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
  const touchesRoom = event.type === "turn.started" || event.type === "turn.ended" || event.type === "message.posted" || event.type === "room.renamed";
  if (touchesRoom) {
    extra.rooms = rooms.map((room) => {
      if (room.id !== st.id) return room;
      const updated = { ...room, name: st.name, running: st.turns.some((t) => t.status === "running"), updatedAt: event.ts };
      if (event.type === "message.posted" && event.message.kind !== "pass" && event.message.kind !== "system") {
        updated.lastMessage = { author: event.message.author, text: event.message.text.slice(0, 200) };
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
// Routing (hash = room id, #new = start screen)
// ---------------------------------------------------------------------------

const routeFromHash = (): Route | null => {
  const raw = decodeURIComponent(location.hash.slice(1));
  if (raw === "new") return { kind: "new" };
  if (raw) return { kind: "room", id: raw };
  return null;
};

function applyRoute(route: Route) {
  const prev = useStore.getState().route;
  useStore.setState({ route, navOpen: false });
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
  const route = routeFromHash();
  if (route) {
    applyRoute(route);
    return;
  }
  const first = useStore.getState().rooms[0];
  const target: Route = first ? { kind: "room", id: first.id } : { kind: "new" };
  history.replaceState(null, "", target.kind === "room" ? `#${encodeURIComponent(target.id)}` : "#new");
  applyRoute(target);
};

export const boot = async () => {
  await useStore.getState().loadRooms();
  if (useStore.getState().gate || useStore.getState().bootError) return;
  syncRoute();
  window.addEventListener("popstate", syncRoute);
  window.addEventListener("hashchange", syncRoute);
  setInterval(() => void useStore.getState().loadRooms(), 5000);
};

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export const useRoom = () => useStore((s) => s.snap?.state);
