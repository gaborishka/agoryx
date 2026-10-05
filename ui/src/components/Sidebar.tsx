import { ArrowLeftIcon, FoldersIcon, CircleAlertIcon, ChevronRightIcon, CircleHelpIcon, type LucideIcon, Settings2Icon, MonitorIcon, MoonIcon, PlusIcon, SmartphoneIcon, SquarePenIcon, SunIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { MarkMono } from "@/components/brand/Mark";
import { Facepile, Tip } from "@/components/room/bits";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { local } from "@/lib/api";
import { waitingReason } from "@/lib/attention";
import { keyLabel } from "@/lib/keys";
import { ago, names, plural, roomPreviewParts } from "@/lib/format";
import { nestThreads } from "@/lib/room";
import { isBusy, layoutRooms, OWN, CHATS, type Group } from "@/lib/sidebar";
import { openConversation, useStore } from "@/lib/store";
import { SETTINGS_NAVIGATION } from "@/lib/settings-sections";
import { THEME_LABEL, useTheme } from "@/lib/theme";
import type { RoomAgent, RoomSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { phaseName, WORK_MODES, conversationMode } from "@/lib/workflow";

/**
 * The room list shows where the human is needed: who works in each room and for how long, which rooms wait,
 * and how much was said since the human last looked. Rooms whose agents work and ask nothing fold into Working at the
 * list's foot and come back when they finish or need the human (lib/sidebar). It only changes what the human sees;
 * nothing reaches the agents. Unread counts and «waits» come from the daemon (attention.json's seen cursor, the same
 * one the tray and the Dock read); the folded folders and sections are this browser's.
 */

const readFolded = (): Set<string> => {
  try {
    const list: unknown = JSON.parse(local.get("sidebar.folded") ?? "[]");
    return new Set(Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
};

/** «2:13», «1:02:13». */
const elapsed = (since: string, now: number) => {
  const s = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

/** Ticks once a second while mounted. */
function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="tabular">{elapsed(since, now)}</span>;
}

/** What the room does now, when it does something: who works and for how long, or that it waits for the human. Nothing else: a quiet room is one line. */
function LiveLine({ room, on }: { room: RoomSummary; on: boolean }) {
  const working = room.working ?? [];
  const workflow = room.workflow;
  if (room.workflowError) return <span className="flex min-w-0 items-center gap-1.5 text-meta text-destructive" title={room.workflowError}><CircleAlertIcon className="size-3 shrink-0" /><span className="truncate">Session needs recovery</span></span>;
  if (workflow?.status === "running" || workflow?.status === "waiting_user") {
    const waiting = workflow.status === "waiting_user";
    return (
      <span className={cn("flex min-w-0 items-center gap-1.5 text-meta", waiting ? "text-amber-ink" : "text-muted-foreground")}>
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full bg-current", !waiting && "animate-breathe")} />
        <span className="truncate">{WORK_MODES[workflow.mode].title} · {waiting ? "Your choice" : phaseName(workflow.phase)}</span>
      </span>
    );
  }
  if (room.waiting && !on) {
    // “Waiting for you” (or “Claude is calling you”) always shows; why, or what was said, follows as far as it fits.
    const item = room.waiting;
    const head = item.reason === "mention" ? waitingReason(item) : "Waiting for you";
    const rest = item.reason === "mention" ? item.text : waitingReason(item);
    return (
      <span className="truncate text-meta text-muted-foreground">
        <span className="font-medium text-amber-ink">{head}</span>
        {rest ? ` · ${rest}` : ""}
      </span>
    );
  }
  if (working.length) {
    const who = [...new Set(working.map((w) => w.agent))].map((id) => room.agents?.find((a) => a.id === id)?.label ?? id);
    const since = working.reduce((first, w) => (w.since < first ? w.since : first), working[0]!.since);
    return (
      // Names give way first; the timer always shows.
      <span className="flex min-w-0 items-center gap-1.5 overflow-hidden text-meta text-muted-foreground">
        <span className="size-1.5 shrink-0 animate-breathe rounded-full bg-foreground" aria-hidden />
        <span className="truncate">
          {names(who)} {who.length > 1 ? "are working" : "is working"}
        </span>
        <span className="tabular shrink-0 text-faint">
          <Elapsed since={since} />
        </span>
      </span>
    );
  }
  return null;
}

/** A room's last line, for its tooltip: the list itself stays one line a room. */
const lastLine = (room: RoomSummary) => {
  const { who, text } = roomPreviewParts(room.lastMessage);
  return who ? `${who}: ${text}` : text;
};

function RoomRow({ room, on, depth = 0 }: { room: RoomSummary; on: boolean; depth?: number }) {
  const agents = (room.agents ?? []) as RoomAgent[];
  const working = new Set((room.working ?? []).map((w) => w.agent));
  const unread = on ? 0 : (room.unread ?? 0);
  const waits = (Boolean(room.waiting) || room.workflow?.status === "waiting_user") && !on;
  const protocolActive = room.workflow?.status === "running" || room.workflow?.status === "waiting_user";
  const live = (waits || working.size > 0 || protocolActive || Boolean(room.workflowError));
  const rowMode = conversationMode(room);
  const ModeIcon = WORK_MODES[rowMode].icon;
  const indent = Math.min(depth, 3);
  return (
    <div className="relative" style={indent ? { paddingLeft: `${indent * 1.125}rem` } : undefined}>
      {indent ? <span aria-hidden className="absolute top-0 bottom-0 w-px bg-border" style={{ left: `${indent * 1.125 - 0.5}rem` }} /> : null}
        <button
          type="button"
          title={room.lastMessage ? lastLine(room) : room.mode === "chat" ? (room.projectName ?? "Conversation materials") : depth ? `Thread · ${room.branch ?? room.workspace}` : room.workspace}
          data-on={on}
          data-thread={depth ? room.parent : undefined}
          aria-current={on ? "page" : undefined}
          onClick={() => openConversation(room)}
          className={cn(
            // relative: the row's sr-only span is placed in the row, not at the page's foot, where it made the page scroll.
            "group relative flex w-full flex-col justify-center gap-0.5 rounded-lg px-2 text-left transition",
            live ? "py-1.5" : "h-8",
            on ? "bg-card shadow-edge ring-1 ring-border" : "hover:bg-foreground/[0.05]",
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            {agents.length ? (
              <Facepile agents={agents} working={working} size={18} max={2} ring="ring-sidebar group-hover:ring-[color-mix(in_oklab,var(--sidebar),var(--foreground)_5%)] group-data-[on=true]:ring-card" />
            ) : (
              <span className="grid size-[18px] shrink-0 place-items-center rounded-[30%] bg-muted text-faint" aria-hidden>
                <MarkMono className="size-2.5" />
              </span>
            )}
            <span className={cn("min-w-0 flex-1 truncate text-ui", unread || waits ? "font-semibold text-foreground" : on ? "font-medium text-foreground" : "text-foreground/85")}>{room.name}</span>
            <span title={WORK_MODES[rowMode].title} className={cn("shrink-0", room.workflow?.status === "waiting_user" ? "text-amber-ink" : "text-faint")}><ModeIcon className="size-3.5" /><span className="sr-only">{WORK_MODES[rowMode].title}</span></span>
            {unread ? (
              <span
                aria-hidden
                className={cn(
                  "tabular grid h-4.5 min-w-4.5 shrink-0 place-items-center rounded-full px-1 text-micro leading-none font-semibold",
                  waits ? "bg-amber text-amber-foreground" : "bg-foreground text-background",
                )}
              >
                {unread > 99 ? "99+" : unread}
              </span>
            ) : waits ? (
              <span className="size-2 shrink-0 rounded-full bg-amber" aria-hidden />
            ) : (
              <span className="tabular shrink-0 text-micro text-faint">{ago(room.updatedAt)}</span>
            )}
          </span>
          {live ? (
            <span className="flex min-w-0" style={{ paddingLeft: agents.length > 1 ? 40 : 26 }}>
              <LiveLine room={room} on={on} />
            </span>
          ) : null}
          <span className="sr-only">
            {agents.length ? `. In the room: ${names(agents.map((a) => a.label))}` : ""}
            {unread ? `. ${plural(unread, "new message", "new messages")}` : ""}
            {waits && room.running ? ". Agents are working" : ""}
          </span>
        </button>
    </div>
  );
}

/** The rooms as the list shows them, top to bottom (folded folders and a closed Working left out): what ⌥↑/⌥↓ step through. */
export const sidebarOrder = (rooms: RoomSummary[], current: string | null): RoomSummary[] => {
  const view = layoutRooms(rooms, current, useStore.getState().foldWorking);
  const folded = readFolded();
  const listed = view.grouped
    ? view.groups.flatMap((group) => (folded.has(group.key) ? [] : nestThreads(group.rooms).map(({ room }) => room)))
    : nestThreads(view.rooms).map(({ room }) => room);
  return [...listed, ...(local.get("sidebar.workingOpen") === "1" ? nestThreads(view.working).map(({ room }) => room) : [])];
};

function GroupHead({ group, open, onToggle, current, onProject, onNew, on }: { group: Group; open: boolean; onToggle: () => void; current: string | null; onProject?: () => void; onNew?: () => void; on?: boolean }) {
  const waiting = group.rooms.filter((r) => (r.waiting || r.workflow?.status === "waiting_user") && r.id !== current).length;
  // Folded or not, a group whose work went to Working says so: its rooms are not gone, they are busy.
  const working = group.busy > 0 || group.rooms.some(isBusy);
  return (
    <div className="group/head relative flex w-full items-center gap-0.5 pt-4 pb-1 pl-0.5">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? `Fold ${group.label}` : `Unfold ${group.label}`}
        onClick={onToggle}
        className="grid size-6 shrink-0 place-items-center rounded-md text-faint transition hover:bg-foreground/[0.05] hover:text-foreground"
      >
        <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
      </button>
      <button
        type="button"
        title={onProject ? `${group.title} — open the project` : group.title}
        aria-current={on ? "page" : undefined}
        onClick={onProject ?? onToggle}
        className={cn(
          "flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-left text-small font-medium text-muted-foreground transition hover:text-foreground",
          on && "text-foreground",
        )}
      >
        <span className="truncate">{group.label}</span>
        {!open && waiting ? (
          <span className="size-2 shrink-0 rounded-full bg-amber">
            <span className="sr-only">{plural(waiting, "room is waiting for you", "rooms are waiting for you")}</span>
          </span>
        ) : (!open || group.busy) && working ? (
          <span className="size-1.5 shrink-0 animate-breathe rounded-full bg-foreground" title={group.busy ? `${plural(group.busy, "room", "rooms")} in Working` : undefined}>
            <span className="sr-only">{group.busy ? `${plural(group.busy, "room", "rooms")} in Working` : "Agents are working"}</span>
          </span>
        ) : null}
      </button>
      {group.rooms.length ? <span className="tabular px-1 text-micro text-faint group-hover/head:hidden group-focus-within/head:hidden pointer-coarse:hidden">{group.rooms.length}</span> : null}
      {onNew ? (
        <Tip tip={`New chat in ${group.label}`}>
          <button
            type="button"
            onClick={onNew}
            aria-label={`New chat in ${group.label}`}
            className="hidden size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition group-hover/head:grid group-focus-within/head:grid hover:bg-foreground/[0.06] hover:text-foreground pointer-coarse:grid"
          >
            <PlusIcon className="size-3.5" />
          </button>
        </Tip>
      ) : null}
    </div>
  );
}

/**
 * Working: the rooms whose agents are busy and ask nothing of the human, folded into one bar over the sidebar's foot —
 * who is at work, and how many rooms. Open, it lists them with who works and for how long; each leaves on its own the
 * moment its run ends or it waits for the human.
 */
function WorkingShelf({ rooms, current }: { rooms: RoomSummary[]; current: string | null }) {
  const [open, setOpenState] = useState(() => local.get("sidebar.workingOpen") === "1");
  const setOpen = (next: boolean) => {
    setOpenState(next);
    local.set("sidebar.workingOpen", next ? "1" : null);
  };
  // Who is at work across them, each once.
  const agents = useMemo(() => {
    const seen = new Map<string, RoomAgent>();
    for (const room of rooms) {
      for (const w of room.working ?? []) {
        const agent = room.agents?.find((a) => a.id === w.agent);
        if (agent && !seen.has(agent.id)) seen.set(agent.id, agent as RoomAgent);
      }
    }
    return [...seen.values()];
  }, [rooms]);
  return (
    <section aria-label="Working" className="flex max-h-[45%] shrink-0 flex-col border-t border-border/70 px-2 pt-1.5 pb-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={open ? "Fold the rooms at work" : "Rooms whose agents are working and need nothing from you. Each comes back up when it finishes or needs you."}
        className="group/shelf flex h-8 w-full shrink-0 items-center gap-2 rounded-lg px-2 text-left transition hover:bg-foreground/[0.05]"
      >
        <span className="size-1.5 shrink-0 animate-breathe rounded-full bg-foreground" aria-hidden />
        <span className="text-small font-medium text-foreground/85">Working</span>
        <span className="tabular text-micro text-faint">{rooms.length}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {agents.length ? <Facepile agents={agents} working={new Set(agents.map((a) => a.id))} size={16} max={3} ring="ring-sidebar" /> : null}
          <ChevronRightIcon className={cn("size-3.5 text-faint transition-transform", open ? "rotate-90" : "-rotate-90")} aria-hidden />
        </span>
      </button>
      {open ? (
        <div className="scroll-thin -mx-2 flex min-h-0 flex-col gap-px overflow-y-auto px-2 pt-0.5">
          {nestThreads(rooms).map(({ room, depth }) => (
            <RoomRow key={room.id} room={room} on={room.id === current} depth={depth} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** A row of the sidebar's own: where to go, not a room. */
function NavRow({ icon: Icon, label, on, onClick, hint }: { icon: LucideIcon; label: string; on?: boolean; onClick: () => void; hint?: string }) {
  return (
    <button
      type="button"
      aria-current={on ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "group/nav flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-ui transition",
        on ? "bg-foreground/[0.07] font-medium text-foreground" : "text-foreground/80 hover:bg-foreground/[0.05] hover:text-foreground",
      )}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground group-hover/nav:text-foreground" />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {hint ? <Kbd className="opacity-0 transition group-hover/nav:opacity-100">{hint}</Kbd> : null}
    </button>
  );
}

export function Sidebar() {
  const rooms = useStore((s) => s.rooms);
  const route = useStore((s) => s.route);
  const go = useStore((s) => s.go);
  const openDialog = useStore((s) => s.openDialog);
  const device = useStore((s) => s.device);
  const { pref, cycle } = useTheme();
  const ThemeIcon = pref === "dark" ? MoonIcon : pref === "light" ? SunIcon : MonitorIcon;
  const foldWorking = useStore((s) => s.foldWorking);
  const [folded, setFolded] = useState<Set<string>>(readFolded);
  const current = route.kind === "room" ? route.id : null;
  const toggleFolder = (key: string) => {
    const next = new Set(folded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setFolded(next);
    local.set("sidebar.folded", next.size ? JSON.stringify([...next]) : null);
  };

  const view = useMemo(() => layoutRooms(rooms, current, foldWorking), [rooms, current, foldWorking]);
  const rows = (list: RoomSummary[]) => nestThreads(list).map(({ room, depth }) => <RoomRow key={room.id} room={room} on={room.id === current} depth={depth} />);

  return (
    <nav className="flex h-full w-full flex-col bg-sidebar text-foreground" aria-label="Sidebar">
      {route.kind === "settings" ? <>
        <div className="workspace-sidebar-head"><span>Settings</span></div>
        <nav aria-label="Settings sections" className="scroll-thin flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 pb-3">
          {SETTINGS_NAVIGATION.map(({ id, label, icon: Icon }) => <button
            key={id}
            type="button"
            aria-current={route.section === id ? "page" : undefined}
            onClick={() => go({ kind: "settings", section: id })}
            className={cn("flex min-h-11 shrink-0 items-center gap-2.5 rounded-lg px-3 text-left text-ui transition sm:min-h-9", route.section === id ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground")}
          ><Icon className="size-4 shrink-0" />{label}</button>)}
        </nav>
        <div className="shrink-0 px-3 pb-3 pt-1"><NavRow icon={ArrowLeftIcon} label="Conversations" onClick={() => go({ kind: "new" })} /></div>
      </> : <>
      <div className="workspace-sidebar-head"><span>Conversations</span></div>
      <div className="space-y-1 px-3 pb-2"><NavRow icon={SquarePenIcon} label="New conversation" on={route.kind === "new" || route.kind === "workspace"} onClick={() => go({ kind: "new", mode: "chat" })} /><NavRow icon={FoldersIcon} label="Projects" on={route.kind === "projects"} onClick={() => go({ kind: "projects" })} /></div>

      <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2 pb-3">
        {!rooms.length ? (
          <p className="px-3 py-2 text-small text-muted-foreground">Your conversations will appear here. Choose a mode when you start.</p>
        ) : !view.grouped && !view.rooms.length ? (
          <p className="px-3 py-2 text-small leading-relaxed text-muted-foreground">Every room is at work. Each comes back here when it finishes or needs you.</p>
        ) : view.grouped ? (
          view.groups.map((group) => {
            const open = !folded.has(group.key);
            return (
              <section key={group.key || "own"} aria-label={group.label} className="flex flex-col gap-px">
                <GroupHead
                  group={group}
                  open={open}
                  onToggle={() => toggleFolder(group.key)}
                  current={current}
                  {...(group.project ? { onProject: () => go({ kind: "project", hash: group.project! }), on: route.kind === "project" && route.hash === group.project } : {})}
                  {...(group.key !== CHATS && group.key !== OWN ? { onNew: () => go({ kind: "new", mode: "chat", dir: group.key }) } : {})}
                />
                {open ? rows(group.rooms) : null}
              </section>
            );
          })
        ) : (
          rows(view.rooms)
        )}
      </div>
      {view.working.length ? <WorkingShelf rooms={view.working} current={current} /> : null}
      </>}
      <div className="flex items-center gap-0.5 border-t border-border/70 px-2 py-1.5">
        <Tip tip={`Settings · ${keyLabel("settings")}`}>
          <Button
            variant="ghost"
            size="sm"
            aria-current={route.kind === "settings" ? "page" : undefined}
            className={cn("h-8 gap-2 text-small text-muted-foreground", route.kind === "settings" && "bg-accent text-foreground")}
            onClick={() => go({ kind: "settings", section: "general" })}
          >
            <Settings2Icon className="size-4" />
            Settings
          </Button>
        </Tip>
        <Tip tip="How it works">
          <Button variant="ghost" size="icon" className="ml-auto size-8 text-muted-foreground" aria-label="How it works" onClick={() => openDialog({ kind: "help" })}>
            <CircleHelpIcon className="size-4" />
          </Button>
        </Tip>
        <Tip tip={device ? "This device" : "Open on phone"}>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground"
            aria-label={device ? "This device" : "Open on phone"}
            onClick={() => openDialog({ kind: "phone" })}
          >
            <SmartphoneIcon className="size-4" />
          </Button>
        </Tip>
        <Tip tip={`${THEME_LABEL[pref]} — click to change`}>
          <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={THEME_LABEL[pref]} onClick={cycle}>
            <ThemeIcon className="size-4" />
          </Button>
        </Tip>
      </div>
    </nav>
  );
}
