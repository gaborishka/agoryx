import { ChevronRightIcon, CircleHelpIcon, Settings2Icon, MonitorIcon, MoonIcon, PlusIcon, SearchIcon, SmartphoneIcon, SunIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { MarkMono, Wordmark } from "@/components/brand/Mark";
import { Avatar, Tip } from "@/components/room/bits";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { local } from "@/lib/api";
import { waitingReason } from "@/lib/attention";
import { keyLabel, withMod } from "@/lib/keys";
import { ago, baseName, names, plural, roomPreviewParts, shortPath } from "@/lib/format";
import { ink, toneText } from "@/lib/room";
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
  { id: "waiting", label: "Waiting for you" },
  { id: "working", label: "Working" },
];

/** Rooms in a folder Agoryx made for them (no folder of the human's) are grouped together. */
const OWN = "";

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

/** The room's agents: one avatar, or two overlapping (those at work first; the rest are named to screen readers); at work they pulse. */
function Faces({ agents, working }: { agents: RoomAgent[]; working: Set<string> }) {
  if (!agents.length) {
    return (
      <span className="grid size-8 place-items-center rounded-[30%] bg-muted text-faint ring-1 ring-border ring-inset" aria-hidden>
        <MarkMono className="size-4" />
      </span>
    );
  }
  if (agents.length === 1) {
    const only = agents[0]!;
    return (
      <span className="grid size-8 place-items-center">
        <Avatar handle={only.id} roster={agents} size={26} live={working.has(only.id)} />
      </span>
    );
  }
  const shown = [...agents].sort((a, b) => Number(working.has(b.id)) - Number(working.has(a.id))).slice(0, 2);
  return (
    <span className="relative block size-8" aria-hidden>
      <Avatar handle={shown[1]!.id} roster={agents} size={20} live={working.has(shown[1]!.id)} className="absolute top-0 left-0" />
      <span className="absolute right-0 bottom-0 rounded-[34%] ring-2 ring-sidebar group-data-[on=true]:ring-card">
        <Avatar handle={shown[0]!.id} roster={agents} size={20} live={working.has(shown[0]!.id)} />
      </span>
    </span>
  );
}

/** What the room does now: who works and for how long, that it waits for the human, or its last line. */
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
      <span className="flex min-w-0 overflow-hidden text-meta text-foreground/80">
        <span className="truncate">
          {names(who)} {who.length > 1 ? "are working" : "is working"}
        </span>
        <span className="shrink-0 whitespace-pre">
          {" · "}
          <Elapsed since={since} />
        </span>
      </span>
    );
  }
  const { who, text } = roomPreviewParts(room.lastMessage);
  const look = room.lastMessage?.look;
  return (
    <span className="truncate text-meta text-muted-foreground">
      {who ? (
        <>
          <span className={look ? cn("font-medium", toneText[look.kind]) : undefined} style={ink(look)}>
            {who}
          </span>
          {": "}
        </>
      ) : null}
      {text}
    </span>
  );
}

function RoomRow({ room, on }: { room: RoomSummary; on: boolean }) {
  const go = useStore((s) => s.go);
  const agents = (room.agents ?? []) as RoomAgent[];
  const working = new Set((room.working ?? []).map((w) => w.agent));
  const unread = on ? 0 : (room.unread ?? 0);
  const waits = Boolean(room.waiting) && !on;
  return (
    <button
      type="button"
      title={room.workspace}
      data-on={on}
      aria-current={on ? "page" : undefined}
      onClick={() => go({ kind: "room", id: room.id })}
      className={cn(
        "group grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5 rounded-xl px-2.5 py-2 text-left transition",
        on ? "bg-card shadow-edge ring-1 ring-border" : "hover:bg-foreground/[0.05]",
      )}
    >
      <span className="row-span-2 flex">
        <Faces agents={agents} working={working} />
      </span>
      <span className={cn("truncate text-ui", unread || waits ? "font-semibold" : "font-medium")}>{room.name}</span>
      <span className="tabular text-micro text-faint">{ago(room.updatedAt)}</span>
      <LiveLine room={room} on={on} />
      <span className="flex justify-end">
        {unread ? (
          <span
            aria-hidden
            className={cn(
              "tabular grid h-4.5 min-w-4.5 place-items-center rounded-full px-1 text-micro leading-none font-semibold",
              waits ? "bg-amber text-amber-foreground" : "bg-foreground text-background",
            )}
          >
            {unread > 99 ? "99+" : unread}
          </span>
        ) : waits ? (
          <span className="size-2 rounded-full bg-amber" />
        ) : null}
      </span>
      <span className="sr-only">
        {agents.length ? `. In the room: ${names(agents.map((a) => a.label))}` : ""}
        {unread ? `. ${plural(unread, "new message", "new messages")}` : ""}
        {waits && room.running ? ". Agents are working" : ""}
      </span>
    </button>
  );
}

interface Group {
  key: string;
  label: string;
  title: string;
  rooms: RoomSummary[];
}

/** Rooms by the folder they work in, the most recently active folder first (the rooms come sorted so). */
const groupRooms = (rooms: RoomSummary[]): Group[] => {
  const groups = new Map<string, Group>();
  for (const room of rooms) {
    const key = room.folder ?? OWN;
    let group = groups.get(key);
    if (!group) {
      group = { key, rooms: [], ...(key === OWN ? { label: "New folders", title: "Folders Agoryx created for rooms" } : { label: baseName(key), title: key }) };
      groups.set(key, group);
    }
    group.rooms.push(room);
  }
  const list = [...groups.values()];
  // Two folders of one name: say which is which.
  for (const group of list) {
    if (group.key !== OWN && list.some((other) => other !== group && other.label === group.label)) group.label = shortPath(group.key);
  }
  return list;
};

/** A room the filter shows; the open room never counts as waiting. */
const passes = (room: RoomSummary, filter: Filter, current: string | null) =>
  filter === "waiting" ? Boolean(room.waiting) && room.id !== current : filter === "working" ? room.running : true;

/** Grouped only when the rooms work in more than one folder; decided on all rooms, so a filter does not reshape the list. */
const isGrouped = (rooms: RoomSummary[]) => new Set(rooms.map((r) => r.folder ?? OWN)).size > 1;

/** The rooms as the list shows them, top to bottom (filtered, folded folders left out): what ⌥↑/⌥↓ step through. */
export const sidebarOrder = (rooms: RoomSummary[], current: string | null): RoomSummary[] => {
  const shown = rooms.filter((r) => passes(r, readFilter(), current));
  if (!isGrouped(rooms)) return shown;
  const folded = readFolded();
  return groupRooms(shown).flatMap((group) => (folded.has(group.key) ? [] : group.rooms));
};

function GroupHead({ group, open, onToggle, current }: { group: Group; open: boolean; onToggle: () => void; current: string | null }) {
  const waiting = group.rooms.filter((r) => r.waiting && r.id !== current).length;
  const working = group.rooms.some((r) => r.running);
  return (
    <button
      type="button"
      title={group.title}
      aria-expanded={open}
      onClick={onToggle}
      className="flex w-full items-center gap-1.5 rounded-lg px-2.5 pt-2.5 pb-1 text-left text-meta font-medium text-muted-foreground transition hover:text-foreground"
    >
      <ChevronRightIcon className={cn("size-3.5 shrink-0 text-faint transition-transform", open && "rotate-90")} />
      <span className="truncate">{group.label}</span>
      <span className="tabular text-micro text-faint">{group.rooms.length}</span>
      {!open && waiting ? (
        <span className="ml-auto size-2 shrink-0 rounded-full bg-amber">
          <span className="sr-only">{plural(waiting, "room is waiting for you", "rooms are waiting for you")}</span>
        </span>
      ) : !open && working ? (
        <span className="ml-auto size-2 shrink-0 animate-breathe rounded-full bg-foreground/60">
          <span className="sr-only">Agents are working</span>
        </span>
      ) : null}
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
  const row = (room: RoomSummary) => <RoomRow key={room.id} room={room} on={room.id === current} />;

  return (
    <nav className="flex h-full w-full flex-col bg-sidebar text-foreground" aria-label="Rooms">
      <div className="flex h-14 shrink-0 items-center px-4">
        <button type="button" className="rounded-md" aria-label="Agoryx — new room" onClick={() => go({ kind: "new" })}>
          <Wordmark className="text-[21px]" />
        </button>
      </div>
      <div className="flex gap-1.5 px-3 pb-3">
        <Button
          variant="default"
          aria-current={route.kind === "new" ? "page" : undefined}
          className="h-9 flex-1 justify-start gap-2 rounded-xl text-ui shadow-soft"
          onClick={() => go({ kind: "new" })}
        >
          <PlusIcon className="size-4" />
          New room
        </Button>
        <Tip tip={<span>Search and actions <Kbd>{withMod("K")}</Kbd></span>}>
          <Button variant="outline" size="icon" className="size-9 rounded-xl bg-card shadow-none" aria-label="Search and actions" onClick={() => setPaletteOpen(true)}>
            <SearchIcon className="size-4" />
          </Button>
        </Tip>
      </div>
      {rooms.length ? (
        <div className="flex flex-wrap gap-1 px-3 pb-2" role="group" aria-label="Which rooms to show">
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
                  "inline-flex h-6.5 items-center gap-1 rounded-full px-2 text-meta font-medium transition",
                  active ? "bg-foreground/[0.07] text-foreground" : "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground",
                )}
              >
                {label}
                {id !== "all" && count ? (
                  <span className={cn("tabular text-micro", id === "waiting" ? "font-semibold text-amber-ink" : "text-faint")}>{count}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3">
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
              <section key={group.key || "own"} aria-label={group.label} className="flex flex-col gap-0.5">
                <GroupHead group={group} open={open} onToggle={() => toggleFolder(group.key)} current={current} />
                {open ? group.rooms.map(row) : null}
              </section>
            );
          })
        ) : (
          shown.map(row)
        )}
      </div>
      <div className="flex items-center gap-1 border-t border-border/70 px-2 py-2">
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
