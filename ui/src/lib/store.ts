import { toast } from "sonner";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { api, ApiError, local, roomPath, setUnauthorizedHandler, Unauthorized } from "./api";
import { startAttention } from "./attention";
import { isProtocolMode, nativeRoomMode, isWorkMode, type ProtocolMode, type WorkMode } from "./workflow";
import { requestNonce } from "./request-nonce";
import { isWorkTableEvent } from "../../../internal/agora/work-table.js";
import type { Quote } from "./quote";
import { lastLine, type Seating } from "./room";
import type { AgentPresence, LimitSnapshot, OpEntry, RoomEvent, RoomSummary, RunState, Snapshot, TurnState } from "./types";

/**
 * The right-hand panel's tabs: an agent's own session, the shared document, the room's browser (in the app),
 * what turns changed, the workspace's files, and the table beside the conversation (it is also a view of its own,
 * but never both at once). `thread`: a thread of this room, opened from its card; it is not one of the tabs an
 * address or the toggle brings back, since it shows another room.
 */
export type PanelTab = "session" | "doc" | "browser" | "diff" | "files" | "table" | "project" | "thread";
export const PANEL_TABS: readonly PanelTab[] = ["session", "doc", "browser", "diff", "files", "table", "project"];

/** Which changes the Changes tab shows: one turn's, the whole room's against where it began, or one checkpoint. */
export type ChangeScope = "turn" | "room" | "commit";

export interface ChangesFocus {
  scope: ChangeScope;
  /** The turn (scope "turn"); none: the latest turn that changed something. */
  turn?: string;
  /** The checkpoint (scope "commit"); none: the latest. */
  sha?: string;
  /** One file of it, shown alone. */
  path?: string;
  /** Opened from “N actions”: the turn's actions start unfolded. Not kept in the address. */
  acts?: boolean;
}

/** The room's conversation, shared table, or saved workflow sessions. */
export type RoomView = "chat" | "table" | "sessions";

export type DialogState =
  /** Return the folder: to checkpoint `sha`, undo return `undo` (its seq), or neither: pick a checkpoint. */
  | { kind: "revert"; sha?: string; undo?: number }
  | { kind: "mode" }
  | { kind: "settings" }
  /** Who sits in the room: seat, send out, roles; `agent`: the one to show first. */
  | { kind: "agents"; agent?: string }
  | { kind: "help" }
  | { kind: "keys" }
  | { kind: "usage" }
  | { kind: "phone" }
  | { kind: "table-form"; op: TableFormOp; target?: string; q?: string }
  /** A project's settings, by its hash. */
  | { kind: "project"; hash: string; tab?: ProjectTab };

export const PROJECT_TABS = ["general", "context", "memory", "usage", "changes"] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];

export type TableFormOp = "ask" | "propose" | "object" | "support" | "evidence" | "decide" | "settle" | "next";

/** The settings screen's sections (#settings/<section>). */
export const SETTINGS_SECTIONS = ["general", "profile", "agents", "phone", "limits", "about"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export type Route =
  | { kind: "room"; id: string }
  /** The start screen; `dir`: a Work room in this folder (a project's "New room here"). */
  | { kind: "new"; mode?: WorkMode; dir?: string }
  /** The catalog of available ways to work. */
  | { kind: "modes" }
  | { kind: "workspace"; mode: WorkMode }
  | { kind: "settings"; section: SettingsSection }
  /** A project (a Work folder), by its hash. */
  | { kind: "project"; hash: string }
  /** Every project. */
  | { kind: "projects" }
  | { kind: "boot" };

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
  /** This browser as a paired device (a phone), or null on the computer itself. */
  device: { id: string; name: string } | null;
  /** Why a pairing code from the link or the form did not work. */
  pairError: string | null;
  snap: Snapshot | null;
  /** Snapshot freshness: an open room may still show its last known state during reconnect. */
  connection: "connecting" | "live" | "reconnecting" | "offline";
  /** Messages already shown once — only newer ones animate in. */
  seen: Set<string>;
  panel: PanelTab | null;
  /** The tab the panel toggle opens: the one shown last. */
  lastTab: PanelTab;
  /** Whose session the session panel shows. */
  sessionAgent: string | null;
  /** The thread the thread tab shows: a room started from this one. */
  thread: string | null;
  changes: ChangesFocus;
  /** The file the Files tab shows; null: the list. */
  filePath: string | null;
  /** The files open as tabs in the Files tab, in the order they were opened. */
  fileTabs: string[];
  /** The room's terminals at the bottom of the room: shown or not, and how tall. */
  terminalOpen: boolean;
  terminalHeight: number;
  /** A new terminal asked for from elsewhere (the session's «continue in the terminal»), with what to type in it. */
  terminalRequest: { text: string; at: number } | null;
  /** Chat, table, or sessions, remembered per room. */
  view: RoomView;
  workspaceMode: WorkMode;
  /** null: current run; a UUID: a saved run; "new": explicitly configure a new session. */
  workflowRunId: string | null;
  wide: boolean;
  /** Widths dragged by hand, kept between visits: the room list's and the docked panel's (null: as designed). */
  navWidth: number | null;
  panelWidth: number | null;
  navOpen: boolean;
  /** Desktop room list visibility, independent of the mobile drawer. */
  navCollapsed: boolean;
  /** The room list folds rooms whose agents work and ask nothing into one Working section (this browser's choice). */
  foldWorking: boolean;
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
  /** A passage quoted from a message or a diff, on its way to the composer; `at` makes a repeat count; `to`: whom it is for by default. */
  quoting: { quote: Quote; at: number; to?: string } | null;
  /** A passage on its way to a thread's steer box, as `quoting` is to the composer: the human sends it. `pick`: which thread is the human's to choose. */
  steering: { quote: Quote; at: number; pick?: boolean } | null;
  paletteOpen: boolean;

  loadRooms: () => Promise<void>;
  go: (route: Route) => void;
  openRoom: (id: string, quiet?: boolean) => Promise<void>;
  setPanel: (panel: PanelTab | null) => void;
  /** Open or close a tab; with none, the panel itself (on the tab shown last). */
  togglePanel: (tab?: PanelTab) => void;
  /** Show changes in the Changes tab: a turn's (and one file of it), the room's, a checkpoint's. */
  openChanges: (focus: ChangesFocus) => void;
  /** Show a workspace file in the Files tab; null: the list of files. */
  openFile: (path: string | null) => void;
  /** Close a file's tab; the one beside it is shown if it was the shown one. */
  closeFile: (path: string) => void;
  setTerminalOpen: (open: boolean) => void;
  /** A new terminal with `text` typed in (not run: Enter stays the human's). */
  openTerminal: (text: string) => void;
  setTerminalHeight: (height: number) => void;
  setDocFocus: (seq: number | null) => void;
  /** Show an agent's session in the side panel (the first agent's when none is named); again for the same agent closes it. */
  openSession: (agent?: string, toggle?: boolean) => void;
  /** Show a thread of this room in the side panel. */
  openThread: (id: string) => void;
  setView: (view: RoomView) => void;
  setWorkspaceMode: (mode: WorkMode) => void;
  openWorkflow: (roomId: string, mode: ProtocolMode, runId?: string) => void;
  setWide: (wide: boolean) => void;
  setNavWidth: (width: number | null) => void;
  setPanelWidth: (width: number | null) => void;
  setNavOpen: (open: boolean) => void;
  setNavCollapsed: (collapsed: boolean) => void;
  setFoldWorking: (fold: boolean) => void;
  openDialog: (dialog: DialogState | null) => void;
  goToRef: (ref: string) => void;
  /** Put a draft into the composer for the human to edit and send; nothing is sent. */
  composeDraft: (text: string) => void;
  /** Add a quoted passage above the composer's draft (the draft stays); nothing is sent. `to` is @-addressed when the draft names no one yet. */
  quote: (quote: Quote, to?: string) => void;
  /** Put a quoted passage into the open thread's steer box (the room's threads to pick from when none is open); nothing is sent. */
  steerQuote: (quote: Quote) => void;
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
  device: null,
  pairError: null,
  snap: null,
  connection: "offline",
  seen: new Set(),
  panel: null,
  lastTab: PANEL_TABS.includes(local.get("panelTab") as PanelTab) ? (local.get("panelTab") as PanelTab) : "session",
  sessionAgent: null,
  thread: null,
  changes: { scope: "turn" },
  filePath: null,
  fileTabs: [],
  terminalOpen: false,
  terminalHeight: Number(local.get("terminalHeight")) || 280,
  terminalRequest: null,
  view: "chat",
  workspaceMode: "chat",
  workflowRunId: null,
  wide: local.get("wide") === "1",
  navWidth: Number(local.get("navWidth")) || null,
  panelWidth: Number(local.get("panelWidth")) || null,
  navOpen: false,
  navCollapsed: local.get("navCollapsed") === "1",
  foldWorking: local.get("sidebar.foldWorking") !== "0",
  dialog: null,
  docTick: 0,
  docReset: 0,
  lastDocRevision: null,
  docFocus: null,
  flash: null,
  compose: null,
  quoting: null,
  steering: null,
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
    if (!quiet || get().snap?.state.id !== id) set({ connection: "connecting" });
    try {
      let snap = await api<Snapshot>("GET", roomPath(id));
      snap.ops ??= [];
      snap.streams ??= {};
      snap.events ??= [];
      if (get().route.kind !== "room" || (get().route as { id: string }).id !== id) return;
      const fresh = !quiet || get().snap?.state.id !== id;
      // A GET started before a live event must not roll the room back to an older snapshot.
      const current = get().snap;
      if (quiet && current?.state.id === id && current.state.seq > snap.state.seq) snap = current;
      set({
        snap,
        ...(!isProtocolMode(get().workspaceMode) ? { workspaceMode: nativeRoomMode(snap.state) } : {}),
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
        toast.error("There is no such room");
        const first = get().rooms.find((r) => r.id !== id);
        get().go(first ? { kind: "room", id: first.id } : { kind: "new" });
        return;
      }
      if (quiet) {
        set({ connection: "offline" });
        reopenTimer = setTimeout(() => void get().openRoom(id, true), 3000);
        return;
      }
      set({ connection: "offline" });
      toast.error(error instanceof Error ? error.message : String(error));
    }
  },

  setPanel(panel) {
    if (panel === "thread" && !get().thread) panel = null;
    if (panel && panel !== "thread") local.set("panelTab", panel);
    // The table beside the conversation: the room's column goes back to the conversation.
    if (panel === "table" && get().view === "table") get().setView("chat");
    set(panel ? { panel, lastTab: panel } : { panel });
  },
  togglePanel(tab) {
    const { panel, lastTab, thread } = get();
    if (!tab) get().setPanel(panel ? null : lastTab === "thread" && !thread ? "session" : lastTab);
    else get().setPanel(panel === tab ? null : tab);
  },
  openChanges(focus) {
    get().setPanel("diff");
    set({ changes: focus });
  },
  openFile(path) {
    get().setPanel("files");
    // The file shown from an address is a tab too, though it was never opened here.
    const { fileTabs, filePath } = get();
    const tabs = filePath && !fileTabs.includes(filePath) ? [...fileTabs, filePath] : fileTabs;
    set({ filePath: path, fileTabs: path && !tabs.includes(path) ? [...tabs, path] : tabs });
  },
  closeFile(path) {
    const { filePath } = get();
    const fileTabs = filePath && !get().fileTabs.includes(filePath) ? [...get().fileTabs, filePath] : get().fileTabs;
    const at = fileTabs.indexOf(path);
    const rest = fileTabs.filter((p) => p !== path);
    set({ fileTabs: rest, ...(filePath === path ? { filePath: rest[Math.min(at, rest.length - 1)] ?? null } : {}) });
  },
  setTerminalOpen(terminalOpen) {
    set({ terminalOpen });
  },
  openTerminal(text) {
    set({ terminalOpen: true, terminalRequest: { text, at: Date.now() } });
  },
  setTerminalHeight(height) {
    const terminalHeight = Math.round(Math.max(120, Math.min(height, window.innerHeight * 0.75)));
    local.set("terminalHeight", String(terminalHeight));
    set({ terminalHeight });
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
  openThread(id) {
    set({ thread: id });
    get().setPanel("thread");
  },
  setWorkspaceMode(workspaceMode) {
    const route = get().route;
    if (route.kind === "room") local.set(`workMode.${route.id}`, workspaceMode);
    set({ workspaceMode, workflowRunId: null, ...(isProtocolMode(workspaceMode) ? { view: "chat" as const } : {}), ...(route.kind === "new" ? { route: { ...route, mode: workspaceMode } } : {}) });
  },
  openWorkflow(roomId, workspaceMode, runId) {
    const route: Route = { kind: "room", id: roomId };
    const extra: Partial<Store> = { ...routeState(route, null), workspaceMode, workflowRunId: addressedWorkflowRun(runId), view: "chat" };
    local.set(`workMode.${roomId}`, workspaceMode);
    local.set(`view.${roomId}`, null);
    const hash = hashFor({ ...get(), ...extra, route });
    if (location.hash !== hash) history.pushState(null, "", hash);
    applyRoute(route, extra);
  },
  setView(view) {
    const route = get().route;
    const workspaceMode = route.kind === "room" ? roomWorkspaceMode(route.id) : get().workspaceMode === "work" ? "work" : "chat";
    if (route.kind === "room") {
      local.set(`view.${route.id}`, view === "chat" ? null : view);
      local.set(`workMode.${route.id}`, workspaceMode);
    }
    // The table as the room's view takes it back from the panel.
    const next: Partial<Store> = { view, workspaceMode, workflowRunId: null, ...(view === "table" && get().panel === "table" ? { panel: null } : {}), ...(route.kind === "new" ? { route: { ...route, mode: workspaceMode } } : {}) };
    const hash = hashFor({ ...get(), ...next });
    if (location.hash !== hash) history.pushState(null, "", hash);
    set(next);
  },
  setWide(wide) {
    local.set("wide", wide ? "1" : null);
    set({ wide });
  },
  setNavWidth(navWidth) {
    local.set("navWidth", navWidth ? String(navWidth) : null);
    set({ navWidth });
  },
  setPanelWidth(panelWidth) {
    local.set("panelWidth", panelWidth ? String(panelWidth) : null);
    set({ panelWidth });
  },
  setFoldWorking(foldWorking) {
    local.set("sidebar.foldWorking", foldWorking ? null : "0");
    set({ foldWorking });
  },
  setNavCollapsed(navCollapsed) {
    local.set("navCollapsed", navCollapsed ? "1" : null);
    set({ navCollapsed });
  },
  setNavOpen(navOpen) {
    set({ navOpen });
  },
  openDialog(dialog) {
    set({ dialog });
  },
  goToRef(ref) {
    // A table item opens where the table already is: beside the conversation, or as the view.
    if (/^m-/.test(ref)) get().setView("chat");
    else if (get().panel !== "table") get().setView("table");
    set({ flash: { ref, at: Date.now() } });
  },
  composeDraft(text) {
    set({ compose: { text, at: Date.now() } });
  },
  quote(quote, to) {
    set({ quoting: { quote, at: Date.now(), ...(to ? { to } : {}) } });
  },
  steerQuote(quote) {
    const { thread, rooms, snap } = get();
    const threads = rooms.filter((room) => room.parent && room.parent === snap?.state.id);
    const open = thread && threads.some((room) => room.id === thread) ? thread : null;
    const latest = [...threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    set({ steering: { quote, at: Date.now(), ...(!open && threads.length > 1 ? { pick: true } : {}) } });
    if (open) get().setPanel("thread");
    else if (latest) get().openThread(latest.id);
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
    const request = suffix === "/table" && body && typeof body === "object" ? { nonce: requestNonce(), ...body } : body;
    const result = await api("POST", roomPath(snap.state.id, suffix), request);
    // An accepted agent request is durable before its HTTP acknowledgment. Recover it even if SSE lagged.
    if (suffix === "/table-assist" && get().snap?.state.id === snap.state.id) {
      const message = result.message as { seq?: number } | undefined;
      if (typeof message?.seq === "number" && message.seq > get().snap!.state.seq) await get().openRoom(snap.state.id, true);
    }
    // Update from the server's committed event even if SSE is reconnecting. Later delivery is deduplicated by seq.
    if (suffix === "/table" && get().snap?.state.id === snap.state.id && result.event && result.table) {
      const event = result.event as RoomEvent;
      const cursor = get().snap!.state.seq;
      if (event.seq === cursor + 1) {
        applyPatch(event, { seq: event.seq, table: result.table as Snapshot["state"]["table"] });
      } else if (event.seq > cursor) {
        // A disconnected stream may have missed messages/turns before this action. A table-only ack cannot skip them.
        await get().openRoom(snap.state.id, true);
      }
    }
    return result;
  },
}));

setUnauthorizedHandler(() => {
  closeStream();
  useStore.setState({ gate: true, connection: "offline" });
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
  reverts?: Snapshot["state"]["reverts"];
  docRevisions?: Snapshot["state"]["docRevisions"];
  /** null: the room's folder no longer has a GitHub remote, or gh is signed out. */
  repo?: Snapshot["state"]["repo"] | null;
  prs?: Snapshot["state"]["prs"];
  guests?: Snapshot["state"]["guests"];
  agents?: Snapshot["state"]["agents"];
  former?: Snapshot["state"]["former"];
  resume?: Snapshot["resume"];
  /** null: the thread is open again. */
  resolved?: Snapshot["state"]["resolved"] | null;
  activity?: { turnId: string; activity: TurnState["activity"][number] };
};

const applyPatch = (event: RoomEvent, patch: Patch) => {
  if ((event.type === "room.mode.changed" || event.type === "room.project.changed")) {
    const s = useStore.getState();
    useStore.setState({ panel: null, terminalOpen: false, docFocus: null, docReset: s.docReset + 1 });
    if (s.route.kind === "room") void s.openRoom(s.route.id, true);
    void s.loadRooms();
    return;
  }
  const { snap, rooms } = useStore.getState();
  if (!snap || event.seq <= snap.state.seq) return;
  const st = { ...snap.state, seq: event.seq };
  const next: Snapshot = { ...snap, state: st };
  if (isWorkTableEvent(event)) next.events = [...(snap.events ?? []), event].slice(-100);
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
  if (patch.reverts) st.reverts = patch.reverts;
  if (patch.docRevisions) st.docRevisions = patch.docRevisions;
  if (patch.repo === null) delete st.repo;
  else if (patch.repo) st.repo = patch.repo;
  if (patch.prs) st.prs = patch.prs;
  if (patch.resolved === null) delete st.resolved;
  else if (patch.resolved) st.resolved = patch.resolved;
  if (patch.guests) st.guests = patch.guests;
  if (patch.agents) st.agents = patch.agents;
  if (patch.former) st.former = patch.former;
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
  es.onopen = () => { if (source === es) useStore.setState({ connection: "live" }); };
  es.addEventListener("room", (event) => {
    const { event: roomEvent, patch } = JSON.parse((event as MessageEvent).data) as { event: RoomEvent; patch: Patch };
    applyPatch(roomEvent, patch);
  });
  es.addEventListener("stream", (event) => applyStream(JSON.parse((event as MessageEvent).data)));
  es.addEventListener("limits", (event) => {
    const { limits } = JSON.parse((event as MessageEvent).data) as { limits: LimitSnapshot[] };
    const { snap } = useStore.getState();
    if (snap) useStore.setState({ snap: { ...snap, limits } });
  });
  es.addEventListener("git", (event) => {
    const { gitRepo } = JSON.parse((event as MessageEvent).data) as { gitRepo: boolean };
    const { snap } = useStore.getState();
    if (snap) useStore.setState({ snap: { ...snap, gitRepo } });
  });
  es.addEventListener("presence", (event) => {
    const { agents } = JSON.parse((event as MessageEvent).data) as { agents: Record<string, AgentPresence> };
    const { snap } = useStore.getState();
    if (snap) useStore.setState({ snap: { ...snap, presence: agents } });
  });
  es.onerror = () => {
    if (source !== es) return;
    useStore.setState({ connection: "reconnecting" });
    closeStream();
    reopenTimer = setTimeout(() => {
      const route = useStore.getState().route;
      if (route.kind === "room" && route.id === roomId) void useStore.getState().openRoom(roomId, true);
    }, 1500);
  };
}

// ---------------------------------------------------------------------------
// Routing: #<room id> with its view, protocol and optional run; #new[?mode=…&dir=…] = creation;
// #modes = catalog; #settings[/<section>] = settings; #projects and #project/<hash> = projects.
// Room and workflow selections create history entries; native panel changes replace the address.
// ---------------------------------------------------------------------------

const TURN_ID = /^t\d{1,9}$/;
const SHA = /^[0-9a-f]{7,40}$/;
const WORKFLOW_RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const addressedWorkflowRun = (value: unknown): string | null => typeof value === "string" && (value === "new" || WORKFLOW_RUN_ID.test(value)) ? value : null;
const isRoomView = (value: unknown): value is RoomView => value === "chat" || value === "table" || value === "sessions";

export const parseRouteHash = (hash: string): { route: Route | null; params: URLSearchParams } => {
  const raw = hash.replace(/^#/, "");
  const cut = raw.indexOf("?");
  const params = new URLSearchParams(cut < 0 ? "" : raw.slice(cut + 1));
  let head: string;
  try {
    head = decodeURIComponent(cut < 0 ? raw : raw.slice(0, cut));
  } catch {
    return { route: null, params };
  }
  // New room in a project's folder (from its page): the folder comes back with the address, on reload or Back.
  if (head === "new") {
    const mode = params.get("mode"), dir = params.get("dir");
    return { route: { kind: "new", ...(isWorkMode(mode) ? { mode } : {}), ...(dir ? { dir } : {}) }, params };
  }
  if (head.startsWith("workspace/") && isWorkMode(head.slice(10))) return { route: { kind: "workspace", mode: head.slice(10) as WorkMode }, params };
  if (head === "modes") return { route: { kind: "modes" }, params };
  if (head === "projects") return { route: { kind: "projects" }, params };
  if (/^project\/[0-9a-f]{12}$/.test(head)) return { route: { kind: "project", hash: head.slice("project/".length) }, params };
  if (head === "settings" || head.startsWith("settings/")) {
    const section = head.slice("settings/".length) as SettingsSection;
    return { route: { kind: "settings", section: SETTINGS_SECTIONS.includes(section) ? section : "general" }, params };
  }
  return { route: head ? { kind: "room", id: head } : null, params };
};

type Addressed = Pick<Store, "route" | "view" | "workspaceMode" | "workflowRunId" | "panel" | "changes" | "filePath" | "sessionAgent" | "docFocus" | "thread">;

/** The address of what the page shows. */
const hashFor = (s: Addressed): string => {
  if (s.route.kind === "new") {
    const params = new URLSearchParams();
    if (s.route.mode) params.set("mode", s.route.mode);
    if (s.route.dir) params.set("dir", s.route.dir);
    return `#new${params.size ? `?${params}` : ""}`;
  }
  if (s.route.kind === "workspace") return `#workspace/${s.route.mode}`;
  if (s.route.kind === "modes") return "#modes";
  if (s.route.kind === "settings") return s.route.section === "general" ? "#settings" : `#settings/${s.route.section}`;
  if (s.route.kind === "project") return `#project/${s.route.hash}`;
  if (s.route.kind === "projects") return "#projects";
  if (s.route.kind !== "room") return "";
  const p = new URLSearchParams();
  if (isProtocolMode(s.workspaceMode)) {
    p.set("mode", s.workspaceMode);
    if (s.workflowRunId) p.set("run", s.workflowRunId);
  } else if (s.view !== "chat") p.set("view", s.view);
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
    else if (s.panel === "thread" && s.thread) p.set("thread", s.thread);
  }
  const query = p.toString();
  return `#${encodeURIComponent(s.route.id)}${query ? `?${query}` : ""}`;
};

/** Nothing of another room's selected: its own turns, files and revisions. */
const FRESH = { changes: { scope: "turn" } as ChangesFocus, filePath: null, fileTabs: [] as string[], docFocus: null, thread: null, steering: null, workflowRunId: null };

const roomWorkspaceMode = (id: string) => {
  const s = useStore.getState();
  return nativeRoomMode(s.snap?.state.id === id ? s.snap.state : s.rooms.find(room => room.id === id));
};

/**
 * What entering a room sets besides the route. From an address (`params`): what it says, the view otherwise
 * as last left in that room. From the sidebar or the palette (null): the open tab stays, on the new room's things.
 */
const routeState = (route: Route, params: URLSearchParams | null): Partial<Store> => {
  if (route.kind === "workspace") return { ...FRESH, view: "chat", workspaceMode: route.mode, panel: null };
  if (route.kind === "new" || route.kind === "modes") return { ...FRESH, view: "chat", workspaceMode: route.kind === "new" ? route.mode ?? "chat" : "chat", panel: null };
  if (route.kind !== "room") return { workflowRunId: null };
  const s = useStore.getState();
  const same = s.route.kind === "room" && s.route.id === route.id;
  const storedView = local.get(`view.${route.id}`);
  const remembered: RoomView = isRoomView(storedView) ? storedView : "chat";
  // Conversation navigation uses its saved local view; a protocol opens only through an explicit mode/run. Browser addresses are explicit:
  // an absent mode/run must not resurrect a selection made after a history entry.
  // Another room's thread is not this one's: that tab closes.
  if (!params) return { view: remembered, workspaceMode: roomWorkspaceMode(route.id), ...FRESH, ...(s.panel === "thread" ? { panel: null } : {}) };
  const view = params.get("view");
  const requestedMode = params.get("mode");
  const workspaceMode = view !== "sessions" && isProtocolMode(requestedMode) ? requestedMode : roomWorkspaceMode(route.id);
  local.set(`workMode.${route.id}`, workspaceMode);
  // The view an address names is the one now shown here, so it is remembered: the rewritten address omits chat.
  if (isRoomView(view)) local.set(`view.${route.id}`, view === "chat" ? null : view);
  const tab = params.get("panel") as PanelTab | null;
  // An address without a panel closes it in this room; another room's address keeps the tab open.
  const thread = tab === "thread" ? params.get("thread") : null;
  const panel = thread ? "thread" : tab && PANEL_TABS.includes(tab) ? tab : same || s.panel === "thread" ? null : s.panel;
  const turn = params.get("turn");
  const sha = params.get("commit");
  const scope = params.get("scope");
  const path = params.get("path") || undefined;
  const rev = Number.parseInt(params.get("rev") ?? "", 10);
  const shown: RoomView = !isProtocolMode(workspaceMode) && isRoomView(view) ? view : "chat";
  return {
    view: panel === "table" && shown === "table" ? "chat" : shown,
    workspaceMode,
    workflowRunId: isProtocolMode(workspaceMode) ? addressedWorkflowRun(params.get("run")) : null,
    panel,
    ...(panel ? { lastTab: panel } : {}),
    changes: {
      scope: scope === "room" ? "room" : scope === "commit" || sha ? "commit" : "turn",
      ...(turn && TURN_ID.test(turn) ? { turn } : {}),
      ...(sha && SHA.test(sha) ? { sha } : {}),
      ...(path && panel === "diff" ? { path } : {}),
    },
    filePath: panel === "files" ? (path ?? null) : null,
    fileTabs: same ? s.fileTabs : [],
    sessionAgent: params.get("agent") || s.sessionAgent,
    docFocus: panel === "doc" && Number.isFinite(rev) ? rev : null,
    thread,
  };
};

function applyRoute(route: Route, extra: Partial<Store> = {}) {
  const { route: prev, rooms, snap } = useStore.getState();
  const openRoom = route.kind === "room" && (prev.kind !== "room" || prev.id !== route.id || !snap);
  const clearRoom = route.kind !== "room" || openRoom;
  // Opening a room is looking at it (the daemon hears it from startAttention): its row stops counting at once.
  if (route.kind === "room") extra = { ...extra, rooms: rooms.map((room) => (room.id === route.id && (room.unread || room.waiting) ? { ...room, unread: 0, waiting: undefined } : room)) };
  if (clearRoom) closeStream();
  useStore.setState({ route, navOpen: false, ...extra, ...(clearRoom ? { snap: null, compose: null, quoting: null, steering: null } : {}) });
  if (openRoom && route.kind === "room") void useStore.getState().openRoom(route.id);
  else if (route.kind !== "room") {
    document.title = "Agoryx";
  }
}

export const syncRoute = () => {
  // One hash change fires popstate and hashchange; the second, and our own rewrites, already match what is shown.
  if (location.hash && location.hash === hashFor(useStore.getState())) return;
  const { route, params } = parseRouteHash(location.hash);
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
export const followAddress = () =>
  useStore.subscribe((s, prev) => {
    if (s.route.kind === "boot") return;
    if (
      s.route === prev.route &&
      s.view === prev.view &&
      s.workspaceMode === prev.workspaceMode &&
      s.workflowRunId === prev.workflowRunId &&
      s.panel === prev.panel &&
      s.changes === prev.changes &&
      s.filePath === prev.filePath &&
      s.sessionAgent === prev.sessionAgent &&
      s.docFocus === prev.docFocus &&
      s.thread === prev.thread
    )
      return;
    const hash = hashFor(s);
    if (hash && hash !== location.hash) history.replaceState(null, "", hash);
  });

/** This browser is on the computer that runs the daemon (not a phone reaching it over the network). */
export const onThisComputer = () => ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);

/** Why a code did not work, in the phone's words (the daemon says `reason`). */
const PAIR_FAILURES: Record<string, string> = {
  wrong: "The code is wrong, already used or expired. Make a new one on the computer.",
  "slow-down": "Too many wrong codes. Wait a minute.",
  "typing-stopped": "Too many wrong attempts, so this code can’t be entered anymore. Scan the QR code or make a new code on the computer.",
};

/** Trades a pairing code for this device's own token; the daemon keeps it as a cookie. Throws with the reason. */
export const claimPairing = async (code: string) => {
  try {
    await api("POST", "/api/pair/claim", { code });
  } catch (error) {
    const reason = error instanceof ApiError ? String(error.body.reason ?? "") : "";
    throw new Error(PAIR_FAILURES[reason] ?? "Couldn’t connect this device. Check that the phone can reach the computer and try again.");
  }
  useStore.setState({ pairError: null });
};

/** A room a notification was tapped for: the service worker asks an open page to show it. */
const listenToServiceWorker = () => {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data as { type?: string; room?: string | null } | null;
    if (data?.type === "open-room" && data.room) useStore.getState().go({ kind: "room", id: data.room });
  });
};

export const boot = async () => {
  // A link from the QR code: /?pair=CODE. The code leaves the address bar before anything else happens.
  const pair = new URLSearchParams(location.search).get("pair");
  if (pair !== null) {
    history.replaceState(null, "", location.pathname + location.hash);
    try {
      await claimPairing(pair);
    } catch (error) {
      useStore.setState({ pairError: error instanceof Error ? error.message : String(error) });
    }
  }
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
  // The room list is asked for while it can be seen; a hidden tab asks once when it is shown again.
  setInterval(() => document.visibilityState === "visible" && void useStore.getState().loadRooms(), 5000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void useStore.getState().loadRooms());
  listenToServiceWorker();
  try {
    const info = await api<{ device: { id: string; name: string } | null }>("GET", "/api/info");
    useStore.setState({ device: info.device ?? null });
  } catch {
    // an older daemon: this is the computer
  }
};

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export const useRoom = () => useStore((s) => s.snap?.state);

/**
 * Who sits in the room — what a name, a face or a colour needs. Not the whole state, which is new with every event:
 * a message row that reads only this is not drawn again while a turn runs.
 */
export const useSeating = (): Seating | undefined =>
  useStore(
    useShallow((s) => {
      const st = s.snap?.state;
      return st ? { agents: st.agents, human: st.human, guests: st.guests, former: st.former } : undefined;
    }),
  );

/** List navigation opens a conversation at its latest activity; bare deep links retain native semantics. */
export function openConversation(room: RoomSummary) {
  const mode = room.activityMode ?? room.workflow?.mode;
  if (isProtocolMode(mode) && room.workflow) useStore.getState().openWorkflow(room.id, mode, room.workflow.id);
  else useStore.getState().go({ kind: "room", id: room.id });
}
