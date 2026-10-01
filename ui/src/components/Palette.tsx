import {
  BotIcon,
  CircleHelpIcon,
  FileIcon,
  GitCompareArrowsIcon,
  KeyboardIcon,
  type LucideIcon,
  MessageSquareTextIcon,
  MessagesSquareIcon,
  PaletteIcon,
  PanelRightIcon,
  PlusIcon,
  ReceiptIcon,
  RotateCcwIcon,
  ScaleIcon,
  Settings2Icon,
  SettingsIcon,
  SmartphoneIcon,
  SquareIcon,
  UserRoundIcon,
  UsersIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { panelTabs, TABS } from "@/components/panel/SidePanel";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from "@/components/ui/command";
import { api, roomPath } from "@/lib/api";
import { ago, baseName, unmark } from "@/lib/format";
import { keyLabel, type ShortcutId } from "@/lib/keys";
import { useLoad } from "@/lib/load";
import { ink, nameOf, participant, toneText } from "@/lib/room";
import { useStore } from "@/lib/store";
import { THEME_LABEL, useTheme } from "@/lib/theme";
import type { RoomState } from "@/lib/types";
import { cn } from "@/lib/utils";
import { sysLine } from "@/lib/system";

// Search over everything the page knows: actions, rooms, and in the open room its messages, its table and its
// workspace's file names. Filtering is ours (cmdk's fuzzy scorer is slow on a long room and ranks loosely):
// every word of the query must appear, as typed, in any order.

const LIMIT = 8;

const wordsOf = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);
const matches = (hay: string, words: string[]) => words.every((w) => hay.includes(w));
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A message as one line to quote from: fences out, Markdown's marks as `unmark` takes them. */
const flat = (text: string) => unmark(text.replace(/```[\w+-]*/g, " ")).replace(/\s+/g, " ").trim();

/** The part of `text` around the first word found, the words marked. */
function Snippet({ text, words, around = 48 }: { text: string; words: string[]; around?: number }) {
  const line = flat(text);
  const low = line.toLowerCase();
  const found = words.map((w) => low.indexOf(w)).filter((i) => i >= 0);
  const first = found.length ? Math.min(...found) : 0;
  const start = first > around ? line.lastIndexOf(" ", first - around) + 1 : 0;
  const cut = `${start ? "…" : ""}${line.slice(start)}`;
  if (!words.length) return <>{cut}</>;
  const parts = cut.split(new RegExp(`(${words.map(escape).join("|")})`, "gi"));
  return (
    <>
      {parts.map((part, i) =>
        i % 2 ? (
          <mark key={i} className="rounded-sm bg-amber-soft px-px text-foreground">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

type Hit<T> = { item: T; hay: string };

const TABLE_KIND = { question: "Question", option: "Option", settled: "Conclusion", fact: "Fact", step: "Step", shift: "Change of mind", note: "Argument" } as const;

/** What the table holds, each with the text a search looks in: its id and its words. */
const tableItems = (room: RoomState) => {
  const t = room.table;
  const list: Array<{ id: string; kind: keyof typeof TABLE_KIND; text: string }> = [
    ...t.questions.map((q) => ({ id: q.id, kind: "question" as const, text: q.text })),
    ...t.options.map((o) => ({ id: o.id, kind: "option" as const, text: o.body ? `${o.title} — ${o.body}` : o.title })),
    ...t.settled.map((s) => ({ id: s.id, kind: "settled" as const, text: s.text })),
    ...t.facts.map((f) => ({ id: f.id, kind: "fact" as const, text: f.text })),
    ...t.next.map((n) => ({ id: n.id, kind: "step" as const, text: n.text })),
    ...(t.shifts ?? []).map((c) => ({ id: c.id, kind: "shift" as const, text: c.text })),
    ...t.notes.map((n) => ({ id: n.id, kind: "note" as const, text: n.text })),
  ];
  return list.map((item) => ({ item, hay: `${item.id.toLowerCase()} ${item.text.toLowerCase()}` }));
};

/** The workspace's file names, asked for while the palette is open in a room (again after each ended turn). */
function useFiles(open: boolean, room: RoomState | undefined) {
  const ended = room?.turns.filter((t) => t.status !== "running").length ?? 0;
  const roomId = room?.id ?? "";
  const tree = useLoad(open && roomId ? `${roomId}:tree:${ended}` : null, () => api<{ files: string[] }>("GET", roomPath(roomId, "/tree")));
  return tree.data?.files ?? null;
}

function Keys({ id }: { id: ShortcutId }) {
  return <CommandShortcut className="font-mono tracking-normal">{keyLabel(id)}</CommandShortcut>;
}

interface Action {
  id: string;
  label: string;
  icon: LucideIcon;
  run: () => void;
  keywords?: string;
  hint?: ReactNode;
}

export function Palette() {
  const open = useStore((s) => s.paletteOpen);
  const setOpen = useStore((s) => s.setPaletteOpen);
  const rooms = useStore((s) => s.rooms);
  const room = useStore((s) => s.snap?.state);
  const driven = useStore((s) => s.snap?.driven ?? false);
  const panel = useStore((s) => s.panel);
  const view = useStore((s) => s.view);
  const device = useStore((s) => s.device);
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const words = wordsOf(query);
  const files = useFiles(open, room);
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const messages = useMemo(
    () =>
      (room?.messages ?? [])
        .filter((m) => m.kind !== "pass" && m.kind !== "system" && m.text.trim())
        // A decision is found and shown by the words the room shows it in.
        .map((m) => (m.kind === "decision" ? { ...m, text: sysLine(m) } : m))
        .map((m) => ({ item: m, hay: m.text.toLowerCase() }))
        .reverse(),
    [room?.messages],
  );
  const table = useMemo(() => (room ? tableItems(room) : []), [room?.table]); // eslint-disable-line react-hooks/exhaustive-deps

  const s = useStore.getState();
  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  const actions: Action[] = [{ id: "new", label: "New room", icon: PlusIcon, run: () => s.go({ kind: "new" }) }];
  if (room) {
    actions.push(
      view === "table"
        ? { id: "chat", label: "Conversation", icon: MessagesSquareIcon, run: () => s.setView("chat"), keywords: "view chat", hint: <Keys id="chat" /> }
        : { id: "table", label: "Table", icon: ScaleIcon, run: () => s.setView("table"), keywords: "view", hint: <Keys id="table" /> },
      { id: "panel", label: panel ? "Hide panel" : "Show panel", icon: PanelRightIcon, run: () => s.togglePanel(), hint: <Keys id="panel" /> },
      ...panelTabs().map((tab) => ({
        id: `tab-${tab}`,
        label: TABS[tab].label,
        icon: TABS[tab].icon,
        keywords: "panel",
        run: () => (tab === "session" ? s.openSession() : s.setPanel(tab)),
        hint: tab === "session" ? <Keys id="session" /> : <CommandShortcut>panel</CommandShortcut>,
      })),
      { id: "changes", label: "All changes in this room", icon: GitCompareArrowsIcon, run: () => s.openChanges({ scope: "room" }), keywords: "diff" },
      { id: "revert", label: "Revert folder to a checkpoint", icon: RotateCcwIcon, run: () => s.openDialog({ kind: "revert" }), keywords: "revert checkpoint undo rollback" },
      { id: "usage", label: "Room usage", icon: ReceiptIcon, run: () => s.openDialog({ kind: "usage" }), keywords: "usage cost spend tokens wakes" },
      { id: "ask", label: "Add a question to the table", icon: ScaleIcon, run: () => s.openDialog({ kind: "table-form", op: "ask" }) },
      { id: "agents", label: "The room's agents", icon: UsersIcon, run: () => s.openDialog({ kind: "agents" }), keywords: "agents roster role add remove" },
      { id: "settings", label: "Room settings", icon: SettingsIcon, run: () => s.openDialog({ kind: "settings" }) },
    );
    if (driven && room.runs.at(-1)?.status === "active") {
      actions.push({ id: "stop", label: "Stop agents", icon: SquareIcon, run: () => void s.post("/stop").catch(() => {}), hint: <Keys id="stop" /> });
    }
  }
  actions.push(
    { id: "prefs", label: "Settings", icon: Settings2Icon, run: () => s.go({ kind: "settings", section: "general" }), keywords: "settings preferences profile agents limits", hint: <Keys id="settings" /> },
    { id: "profile", label: "My profile", icon: UserRoundIcon, run: () => s.go({ kind: "settings", section: "profile" }), keywords: "profile about me" },
    { id: "roster", label: "Agents for new rooms", icon: BotIcon, run: () => s.go({ kind: "settings", section: "agents" }), keywords: "agents roster model" },
    { id: "theme", label: "Change theme", icon: PaletteIcon, run: theme.cycle, keywords: "theme dark light appearance", hint: <CommandShortcut>{THEME_LABEL[theme.pref]}</CommandShortcut> },
    { id: "phone", label: device ? "This device" : "Open on phone", icon: SmartphoneIcon, run: () => s.openDialog({ kind: "phone" }), keywords: "phone mobile qr device notifications pairing" },
    { id: "keys", label: "Keyboard shortcuts", icon: KeyboardIcon, run: () => s.openDialog({ kind: "keys" }), keywords: "shortcuts keys hotkeys", hint: <Keys id="keys" /> },
    { id: "help", label: "How it works", icon: CircleHelpIcon, run: () => s.openDialog({ kind: "help" }), keywords: "help guide" },
  );

  const searching = words.length > 0;
  const shownActions = searching ? actions.filter((a) => matches(`${a.label} ${a.keywords ?? ""}`.toLowerCase(), words)) : actions;
  const shownRooms = searching ? rooms.filter((r) => matches(r.name.toLowerCase(), words)) : rooms;
  const foundMessages: Hit<RoomState["messages"][number]>[] = searching ? messages.filter((h) => matches(h.hay, words)) : [];
  // An id typed as it is (“p2”, “Q1”) names one item: it and the table come before the messages.
  const asId = query.trim().toLowerCase();
  const foundTable = searching ? table.filter((h) => matches(h.hay, words)).sort((a, b) => Number(b.item.id.toLowerCase() === asId) - Number(a.item.id.toLowerCase() === asId)) : [];
  const tableFirst = foundTable[0]?.item.id.toLowerCase() === asId;
  // A name's own letters count first: “calc” finds calc.py before src/calc/…
  const foundFiles = searching && files ? files.filter((f) => matches(f.toLowerCase(), words)).sort((a, b) => Number(!matches(baseName(b).toLowerCase(), words)) - Number(!matches(baseName(a).toLowerCase(), words))) : [];

  const groups: ReactNode[] = [];
  if (shownActions.length) {
    groups.push(
      <CommandGroup key="actions" heading="Actions">
        {shownActions.map((a) => (
          <CommandItem key={a.id} value={`a:${a.id}`} onSelect={run(a.run)}>
            <a.icon />
            {a.label}
            {a.hint}
          </CommandItem>
        ))}
      </CommandGroup>,
    );
  }
  if (shownRooms.length) {
    groups.push(
      <CommandGroup key="rooms" heading="Rooms">
        {shownRooms.slice(0, searching ? LIMIT : undefined).map((r) => (
          <CommandItem key={r.id} value={`r:${r.id}`} onSelect={run(() => s.go({ kind: "room", id: r.id }))}>
            <MessagesSquareIcon />
            <span className="truncate">{r.name}</span>
            <CommandShortcut className="tabular tracking-normal">{r.running ? "working" : ago(r.updatedAt)}</CommandShortcut>
          </CommandItem>
        ))}
      </CommandGroup>,
    );
  }
  const found: ReactNode[] = [];
  if (room && foundMessages.length) {
    found.push(
      <CommandGroup key="messages" heading={`Messages · ${foundMessages.length}`}>
        {foundMessages.slice(0, LIMIT).map(({ item: m }) => {
          const who = participant(room, m.author);
          return (
            <CommandItem key={m.id} value={`m:${m.id}`} onSelect={run(() => s.goToRef(`m-${m.id}`))} className="items-start">
              <MessageSquareTextIcon className="mt-0.5" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className={cn("text-meta font-medium", toneText[who.tone])} style={ink(who)}>
                  {nameOf(room, m.author)}
                </span>
                <span className="line-clamp-2 text-small text-muted-foreground">
                  <Snippet text={m.text} words={words} />
                </span>
              </span>
              <CommandShortcut className="tabular mt-0.5 tracking-normal">{ago(m.ts)}</CommandShortcut>
            </CommandItem>
          );
        })}
      </CommandGroup>,
    );
  }
  if (room && foundTable.length) {
    found[tableFirst ? "unshift" : "push"](
      <CommandGroup key="table" heading={`Table · ${foundTable.length}`}>
        {foundTable.slice(0, LIMIT).map(({ item }) => (
          <CommandItem key={item.id} value={`t:${item.id}`} onSelect={run(() => s.goToRef(item.id))}>
            <span className="inline-flex h-5 min-w-8 shrink-0 items-center justify-center rounded-md bg-secondary px-1.5 font-mono text-micro font-semibold text-secondary-foreground ring-1 ring-primary/15">
              {item.id}
            </span>
            <span className="min-w-0 flex-1 truncate">
              <Snippet text={item.text} words={words} around={32} />
            </span>
            <CommandShortcut className="tracking-normal">{TABLE_KIND[item.kind]}</CommandShortcut>
          </CommandItem>
        ))}
      </CommandGroup>,
    );
  }
  groups.push(...found);
  if (room && foundFiles.length) {
    groups.push(
      <CommandGroup key="files" heading={`Files · ${foundFiles.length}`}>
        {foundFiles.slice(0, LIMIT).map((f) => (
          <CommandItem key={f} value={`f:${f}`} onSelect={run(() => s.openFile(f))}>
            <FileIcon />
            <span className="min-w-0 truncate font-mono text-small">
              <span className="text-muted-foreground">{f.includes("/") ? f.slice(0, f.lastIndexOf("/") + 1) : ""}</span>
              {baseName(f)}
            </span>
          </CommandItem>
        ))}
      </CommandGroup>,
    );
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Search and actions"
      description="Actions, rooms, and in a room its messages, table and files"
      className="rounded-2xl shadow-lift sm:max-w-xl"
      commandProps={{ shouldFilter: false, loop: true }}
    >
      <CommandInput value={query} onValueChange={setQuery} placeholder={room ? "Action, room, message, file…" : "Action or room…"} />
      <CommandList className="scroll-thin max-h-[min(60vh,440px)]">
        <CommandEmpty>Nothing found.</CommandEmpty>
        {groups.flatMap((group, i) => (i ? [<CommandSeparator key={`sep-${i}`} />, group] : [group]))}
      </CommandList>
    </CommandDialog>
  );
}
