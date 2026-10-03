import { PanelLeftIcon, ChevronRightIcon, FoldersIcon, CircleHelpIcon, type LucideIcon, Settings2Icon, MonitorIcon, MoonIcon, PlusIcon, SearchIcon, SmartphoneIcon, SquarePenIcon, SunIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { MarkMono, Wordmark } from "@/components/brand/Mark";
import { Facepile, Tip } from "@/components/room/bits";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { local } from "@/lib/api";
import { waitingReason } from "@/lib/attention";
import { keyLabel } from "@/lib/keys";
import { ago, baseName, names, plural, roomPreviewParts, shortPath } from "@/lib/format";
import { nestThreads } from "@/lib/room";
import { useStore } from "@/lib/store";
import { THEME_LABEL, useTheme } from "@/lib/theme";
import type { RoomAgent, RoomSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The room list shows where the human is needed: who works in each room and for how long, which rooms wait,
 * and how much was said since the human last looked. It only changes what the human sees; nothing reaches
 * the agents. Unread counts and «waits» come from the daemon (attention.json's seen cursor, the same one the
 * tray and the Dock read); the filter and the folded folders are this browser's.
 */

type Filter = "all" | "waiting" | "working";
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "waiting", label: "For you" },
  { id: "working", label: "Working" },
];

/** Rooms in a folder Agoryx made for them (no folder of the human's) are grouped together. */
const OWN = "";
const CHATS = "::chats";
const groupKey = (room: RoomSummary) => room.mode === "chat" ? CHATS : room.folder ?? OWN;

const readFolded = (): Set<string> => {
  try {
    const list: unknown = JSON.parse(local.get("sidebar.folded") ?? "[]");
    return new Set(Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
};

const readFilter = (): Filter => {
  const saved = local.get("sidebar.filter");
  return saved === "waiting" || saved === "working" ? saved : "all";
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
  const go = useStore((s) => s.go);
  const agents = (room.agents ?? []) as RoomAgent[];
  const working = new Set((room.working ?? []).map((w) => w.agent));
  const unread = on ? 0 : (room.unread ?? 0);
  const waits = Boolean(room.waiting) && !on;
  const live = (waits || working.size > 0);
  const indent = Math.min(depth, 3);
  return (
    <div className="relative" style={indent ? { paddingLeft: `${indent * 1.125}rem` } : undefined}>
      {indent ? <span aria-hidden className="absolute top-0 bottom-0 w-px bg-border" style={{ left: `${indent * 1.125 - 0.5}rem` }} /> : null}
        <button
          type="button"
          title={room.lastMessage ? lastLine(room) : room.mode === "chat" ? "Chat · no project" : depth ? `Thread · ${room.branch ?? room.workspace}` : room.workspace}
          data-on={on}
          data-thread={depth ? room.parent : undefined}
          aria-current={on ? "page" : undefined}
          onClick={() => go({ kind: "room", id: room.id })}
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

interface Group {
  key: string;
  label: string;
  title: string;
  rooms: RoomSummary[];
  /** A folder's group: its project, by hash (the head opens the project's page). */
  project?: string;
}

/** Rooms by the folder they work in, the most recently active folder first (the rooms come sorted so). */
const groupRooms = (rooms: RoomSummary[]): Group[] => {
  const groups = new Map<string, Group>();
  for (const room of rooms) {
    const key = groupKey(room);
    let group = groups.get(key);
    if (!group) {
      group = { key, rooms: [], ...(key === CHATS ? { label: "Chats", title: "Conversations without a project" } : key === OWN ? { label: "New folders", title: "Folders Agoryx created for rooms" } : { label: baseName(key), title: key }) };
      groups.set(key, group);
    }
    group.rooms.push(room);
    if (key !== CHATS && key !== OWN && room.projectHash) {
      group.project = room.projectHash;
      if (room.projectName) group.label = room.projectName;
    }
  }
  const list = [...groups.values()];
  // Two folders of one name: say which is which.
  for (const group of list) {
    if (group.key !== OWN && group.key !== CHATS && list.some((other) => other !== group && other.label === group.label) && group.label === baseName(group.key)) group.label = shortPath(group.key);
  }
  return list;
};

/** A room the filter shows; the open room never counts as waiting. */
const passes = (room: RoomSummary, filter: Filter, current: string | null) =>
  filter === "waiting" ? Boolean(room.waiting) && room.id !== current : filter === "working" ? room.running : true;

/**
 * Grouped when the rooms work in more than one folder, or when one of them works in a folder of the human's (its head
 * opens the project); decided on all rooms, so a filter does not reshape the list.
 */
const isGrouped = (rooms: RoomSummary[]) => new Set(rooms.map(groupKey)).size > 1 || rooms.some((room) => room.projectHash && room.folder);

/** The rooms as the list shows them, top to bottom (filtered, folded folders left out): what ⌥↑/⌥↓ step through. */
export const sidebarOrder = (rooms: RoomSummary[], current: string | null): RoomSummary[] => {
  const shown = rooms.filter((r) => passes(r, readFilter(), current));
  if (!isGrouped(rooms)) return nestThreads(shown).map(({ room }) => room);
  const folded = readFolded();
  return groupRooms(shown).flatMap((group) => (folded.has(group.key) ? [] : nestThreads(group.rooms).map(({ room }) => room)));
};

function GroupHead({ group, open, onToggle, current, onProject, onNew, on }: { group: Group; open: boolean; onToggle: () => void; current: string | null; onProject?: () => void; onNew?: () => void; on?: boolean }) {
  const waiting = group.rooms.filter((r) => r.waiting && r.id !== current).length;
  const working = group.rooms.some((r) => r.running);
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
        ) : !open && working ? (
          <span className="size-1.5 shrink-0 animate-breathe rounded-full bg-foreground">
            <span className="sr-only">Agents are working</span>
          </span>
        ) : null}
      </button>
      <span className="tabular px-1 text-micro text-faint group-hover/head:hidden group-focus-within/head:hidden pointer-coarse:hidden">{group.rooms.length}</span>
      {onNew ? (
        <Tip tip={`New room in ${group.label}`}>
          <button
            type="button"
            onClick={onNew}
            aria-label={`New room in ${group.label}`}
            className="hidden size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition group-hover/head:grid group-focus-within/head:grid hover:bg-foreground/[0.06] hover:text-foreground pointer-coarse:grid"
          >
            <PlusIcon className="size-3.5" />
          </button>
        </Tip>
      ) : null}
    </div>
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
  const setPaletteOpen = useStore((s) => s.setPaletteOpen);
  const device = useStore((s) => s.device);
  const setNavCollapsed = useStore((s) => s.setNavCollapsed);
  const setNavOpen = useStore((s) => s.setNavOpen);
  const { pref, cycle } = useTheme();
  const ThemeIcon = pref === "dark" ? MoonIcon : pref === "light" ? SunIcon : MonitorIcon;
  const [filter, setFilterState] = useState<Filter>(readFilter);
  const [folded, setFolded] = useState<Set<string>>(readFolded);
  const current = route.kind === "room" ? route.id : null;

  const setFilter = (next: Filter) => {
    setFilterState(next);
    local.set("sidebar.filter", next === "all" ? null : next);
  };
  const toggleFolder = (key: string) => {
    const next = new Set(folded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setFolded(next);
    local.set("sidebar.folded", next.size ? JSON.stringify([...next]) : null);
  };

  const counts = useMemo(
    () => ({ all: rooms.length, waiting: rooms.filter((r) => r.waiting && r.id !== current).length, working: rooms.filter((r) => r.running).length }),
    [rooms, current],
  );
  const shown = rooms.filter((r) => passes(r, filter, current));
  const grouped = isGrouped(rooms);
  const rows = (list: RoomSummary[]) => nestThreads(list).map(({ room, depth }) => <RoomRow key={room.id} room={room} on={room.id === current} depth={depth} />);

  return (
    <nav className="flex h-full w-full flex-col bg-sidebar text-foreground" aria-label="Rooms">
      <div className="flex h-12 shrink-0 items-center pr-2 pl-4">
        <button type="button" className="rounded-md" aria-label="Agoryx — new room" onClick={() => go({ kind: "new" })}>
          <Wordmark className="text-[20px]" />
        </button>
        <Tip tip="Hide sidebar">
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto size-8 text-muted-foreground"
            aria-label="Hide sidebar"
            onClick={() => {
              if (window.matchMedia("(min-width: 1024px)").matches) setNavCollapsed(true);
              else setNavOpen(false);
            }}
          >
            <PanelLeftIcon className="size-4.5" />
          </Button>
        </Tip>
      </div>
      <div className="flex flex-col gap-px px-2 pt-1 pb-3">
        <NavRow icon={SquarePenIcon} label="New room" on={route.kind === "new"} onClick={() => go({ kind: "new" })} />
        <NavRow icon={SearchIcon} label="Search" hint={keyLabel("palette")} onClick={() => setPaletteOpen(true)} />
        <NavRow icon={FoldersIcon} label="Projects" on={route.kind === "projects"} onClick={() => go({ kind: "projects" })} />
      </div>
      {rooms.length ? (
        <div className="mx-3 mb-1 grid grid-cols-3 rounded-lg bg-foreground/[0.045] p-0.5" role="group" aria-label="Which rooms to show">
          {FILTERS.map(({ id, label }) => {
            const count = counts[id];
            const active = filter === id;
            return (
              <button
                key={id}
                type="button"
                aria-pressed={active}
                onClick={() => setFilter(id)}
                className={cn(
                  "inline-flex h-6.5 min-w-0 items-center justify-center gap-1 rounded-md px-1.5 text-meta font-medium transition",
                  active ? "bg-background text-foreground shadow-edge ring-1 ring-border/70" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span className="truncate">{label}</span>
                {id !== "all" && count ? (
                  <span className={cn("tabular text-micro", id === "waiting" ? "font-semibold text-amber-ink" : "text-faint")}>{count}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2 pb-3">
        {!rooms.length ? (
          <p className="px-3 py-2 text-small text-muted-foreground">No rooms yet.</p>
        ) : !shown.length ? (
          <p className="px-3 py-2 text-small text-muted-foreground">
            {filter === "waiting" ? "No room is waiting for you." : "No one is working right now."}{" "}
            <button type="button" className="font-medium text-foreground underline underline-offset-2" onClick={() => setFilter("all")}>
              Show all
            </button>
          </p>
        ) : grouped ? (
          groupRooms(shown).map((group) => {
            const open = !folded.has(group.key);
            return (
              <section key={group.key || "own"} aria-label={group.label} className="flex flex-col gap-px">
                <GroupHead
                  group={group}
                  open={open}
                  onToggle={() => toggleFolder(group.key)}
                  current={current}
                  {...(group.project ? { onProject: () => go({ kind: "project", hash: group.project! }), on: route.kind === "project" && route.hash === group.project } : {})}
                  {...(group.key !== CHATS && group.key !== OWN ? { onNew: () => go({ kind: "new", dir: group.key }) } : {})}
                />
                {open ? rows(group.rooms) : null}
              </section>
            );
          })
        ) : (
          rows(shown)
        )}
      </div>
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
