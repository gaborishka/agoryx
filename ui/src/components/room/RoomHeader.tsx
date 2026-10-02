import {
  EllipsisIcon,
  FolderIcon,
  GitBranchIcon,
  GitCompareArrowsIcon,
  LayoutPanelLeftIcon,
  MenuIcon,
  MessagesSquareIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  ReceiptIcon,
  RotateCcwIcon,
  ScaleIcon,
  SettingsIcon,
  SquareTerminalIcon,
  TerminalIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Driver, TABS } from "@/components/panel/SidePanel";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useNow } from "@/hooks/use-now";
import { api, roomPath, Unauthorized } from "@/lib/api";
import { baseName, secs, shortPath } from "@/lib/format";
import { ariaKeys, keyLabel } from "@/lib/keys";
import { ink, participant, profileLine, tableCount } from "@/lib/room";
import { useStore } from "@/lib/store";
import type { RoomAgent } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Tip } from "./bits";
import { t } from "@/lib/i18n";

function Presence({ a }: { a: RoomAgent }) {
  const now = useStore((s) => s.snap?.presence?.[a.id] ?? "idle");
  const turn = useStore((s) =>
    s.snap?.state.turns.find((t) => t.agent === a.id && t.status === "running"),
  );
  const room = useStore((s) => s.snap?.state);
  const openSession = useStore((s) => s.openSession);
  const profile = useStore((s) => s.snap?.profile);
  const tick = useNow(now === "working" && Boolean(turn));
  const who = participant(room, a.id);
  const tone = who.tone;
  const working = now === "working" && turn;
  const seen = profileLine(a, profile);
  const state = working
    ? `${a.label} is taking a turn in the room`
    : now === "native"
      ? `${a.label} is in a direct conversation in its own session; its room turn starts after that`
      : now === "queued"
        ? `${a.label} is queued for a turn`
        : `${a.label} is waiting for something new in the conversation`;
  const tip = `${seen ? `${state}. ${seen}` : state}. Click to open the session on the side.`;
  const short = working ? "working" : now === "native" ? "in own session" : now === "queued" ? "queued" : "waiting";
  return (
    <Tip tip={tip}>
      <button
        type="button"
        onClick={() => openSession(a.id, true)}
        aria-label={`${a.label}: ${short}. Open session`}
        style={ink(who)}
        className={cn(
          "inline-flex h-7 min-w-0 shrink items-center gap-1.5 rounded-full border px-2.5 text-small transition",
          now === "idle"
            ? "border-border text-muted-foreground hover:bg-accent"
            : tone === "codex"
              ? "border-codex/30 bg-codex-soft text-codex"
              : "border-claude/30 bg-claude-soft text-claude",
        )}
      >
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            now === "idle"
              ? tone === "codex"
                ? "bg-codex/50"
                : "bg-claude/50"
              : tone === "codex"
                ? "bg-codex"
                : "bg-claude",
            now !== "idle" && "animate-breathe",
          )}
        />
        <b className="truncate font-semibold">{a.label}</b>
        {working ? (
          <span className="tabular hidden shrink-0 opacity-80 @min-[52rem]:inline">
            working · {secs(tick - new Date(turn.startedAt).getTime())}
          </span>
        ) : null}
        {now === "native" ? (
          <span className="hidden shrink-0 opacity-80 @min-[52rem]:inline">in own session</span>
        ) : null}
        {now === "queued" ? (
          <span className="hidden shrink-0 opacity-80 @min-[52rem]:inline">queued</span>
        ) : null}
      </button>
    </Tip>
  );
}

function Title() {
  const name = useStore((s) => s.snap?.state.name ?? "");
  const createdBy = useStore((s) => s.snap?.state.createdBy);
  const post = useStore((s) => s.post);
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  const commit = async () => {
    if (!editing) return;
    setEditing(false);
    const next = (input.current?.value ?? "").replace(/\s+/g, " ").trim();
    if (!next || next === name) return;
    try {
      await post("/rename", { name: next });
    } catch (error) {
      if (!(error instanceof Unauthorized))
        toast.error(error instanceof Error ? error.message : String(error));
    }
  };
  if (editing) {
    return (
      <form
        className="min-w-0 flex-1"
        onSubmit={(event) => {
          event.preventDefault();
          void commit();
        }}
      >
        <input
          ref={input}
          defaultValue={name}
          maxLength={120}
          spellCheck={false}
          aria-label="Room name"
          onBlur={() => void commit()}
          onKeyDown={(event) => event.key === "Escape" && setEditing(false)}
          className="h-8 w-full rounded-lg border border-ring/50 bg-card px-2 font-display text-lead font-[650] outline-none ring-3 ring-ring/15"
        />
      </form>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title={createdBy ? `Rename. This room was opened from room “${createdBy.roomName}”: ${createdBy.label}` : "Rename"}
      className="-mx-1.5 min-w-0 truncate rounded-lg px-1.5 py-0.5 text-left font-display text-lead leading-tight font-[650] hover:bg-accent"
    >
      {name}
    </button>
  );
}

export function NavButton() {
  const setNavOpen = useStore((s) => s.setNavOpen);
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-8 lg:hidden"
      aria-label="Rooms"
      onClick={() => setNavOpen(true)}
    >
      <MenuIcon className="size-4.5" />
    </Button>
  );
}

/** The room is two views of one thing: the conversation, and the table it produced. */
function ViewSwitch() {
  const room = useStore((s) => s.snap?.state);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  if (!room) return null;
  const count = tableCount(room);
  const tab = (on: boolean) =>
    cn(
      "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-small font-medium transition sm:px-3",
      on
        ? "bg-card text-foreground shadow-soft ring-1 ring-border"
        : "text-muted-foreground hover:text-foreground",
    );
  return (
    <div
      role="tablist"
      aria-label="Room view"
      className="flex shrink-0 items-center gap-0.5 rounded-xl bg-muted p-1"
    >
      <Tip tip={<span>Conversation <Kbd>{keyLabel("chat")}</Kbd></span>}>
        <button
          type="button"
          role="tab"
          aria-selected={view === "chat"}
          aria-label="Conversation"
          aria-keyshortcuts={ariaKeys("chat")}
          className={tab(view === "chat")}
          onClick={() => setView("chat")}
        >
          <MessagesSquareIcon className="size-4" />
          <span className="hidden @min-[50rem]:inline">Conversation</span>
        </button>
      </Tip>
      <Tip tip={<span>Table: questions, options, arguments and decisions — the choice laid out piece by piece <Kbd>{keyLabel("table")}</Kbd></span>}>
        <button
          type="button"
          role="tab"
          aria-selected={view === "table"}
          aria-label={count ? `Table, ${count} open` : "Table"}
          aria-keyshortcuts={ariaKeys("table")}
          className={tab(view === "table")}
          onClick={() => setView("table")}
        >
          <ScaleIcon className="size-4" />
          <span className="hidden @min-[50rem]:inline">Table</span>
          {count ? (
            <span className="tabular grid h-4.5 min-w-4.5 place-items-center rounded-full bg-amber px-1 text-micro font-semibold text-amber-foreground">
              {count}
            </span>
          ) : null}
        </button>
      </Tip>
    </div>
  );
}

/** The branch the room's folder is on, asked again after every turn: agents may commit or switch. */
function useBranch(roomId: string, turns: number): string | null {
  const [branch, setBranch] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<{ git: { branch: string | null; head: string | null } | null }>(
      "GET",
      roomPath(roomId, "/git"),
    )
      .then(
        (reply) =>
          live &&
          setBranch(reply.git ? (reply.git.branch ?? reply.git.head) : null),
      )
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [roomId, turns]);
  return branch;
}

/** Where the room works: its folder, and in git its branch and whether it is the room's own worktree. */
function Place() {
  const room = useStore((s) => s.snap?.state);
  const openFile = useStore((s) => s.openFile);
  const branch = useBranch(room?.id ?? "", room?.turns.length ?? 0);
  if (!room) return null;
  const wt = room.worktree;
  const folder = wt ? wt.source : room.workspace;
  const tip = wt
    ? t.worktree.place(wt.branch, wt.base, room.workspace, room.agents.map((a) => a.label), wt.source)
    : `Working folder: ${room.workspace}${branch ? `, branch ${branch}` : ""}`;
  return (
    <Tip tip={tip}>
      <button
        type="button"
        onClick={() => openFile(null)}
        className="flex w-fit max-w-full min-w-0 items-center gap-1.5 text-micro text-faint hover:text-muted-foreground"
      >
        <span className="truncate font-mono">
          {wt ? baseName(folder) : shortPath(folder)}
        </span>
        {branch ? (
          <span className="flex min-w-0 items-center gap-1">
            <GitBranchIcon className="size-3 shrink-0" />
            <span className="max-w-[180px] truncate font-mono">{branch}</span>
          </span>
        ) : null}
        {wt ? (
          <span className="shrink-0 rounded bg-secondary px-1 text-micro font-medium text-secondary-foreground">
            {t.worktree.label}
          </span>
        ) : null}
      </button>
    </Tip>
  );
}

/** One button for the side panel; it opens on the tab shown last. The dot: an agent drives the room's browser. */
function PanelToggle() {
  const panel = useStore((s) => s.panel);
  const lastTab = useStore((s) => s.lastTab);
  const togglePanel = useStore((s) => s.togglePanel);
  const Icon = panel ? PanelRightCloseIcon : PanelRightOpenIcon;
  return (
    <Tip
      tip={
        <span>
          {panel ? "Hide panel" : `Panel: ${TABS[lastTab].label.toLowerCase()}, sessions, changes, files`} <Kbd>{keyLabel("panel")}</Kbd>
        </span>
      }
    >
      <Button
        variant="ghost"
        size="icon"
        className={cn("size-8 text-muted-foreground", panel && "bg-secondary text-secondary-foreground hover:bg-secondary")}
        aria-label="Panel"
        data-panel-toggle
        aria-keyshortcuts={ariaKeys("panel")}
        aria-pressed={Boolean(panel)}
        onClick={() => togglePanel()}
      >
        <span className="relative">
          <Icon className="size-4.5" />
          {panel === "browser" ? null : <Driver />}
        </span>
      </Button>
    </Tip>
  );
}

/** The room's terminals under it: shown or hidden (they run on while hidden). */
function TerminalToggle() {
  const open = useStore((s) => s.terminalOpen);
  const setOpen = useStore((s) => s.setTerminalOpen);
  return (
    <Tip
      tip={
        <span>
          {open ? "Hide the terminal" : "Terminal in the room's folder"} <Kbd>{keyLabel("terminal")}</Kbd>
        </span>
      }
    >
      <Button
        variant="ghost"
        size="icon"
        className={cn("hidden size-8 text-muted-foreground sm:inline-flex", open && "bg-secondary text-secondary-foreground hover:bg-secondary")}
        aria-label="Terminal"
        aria-keyshortcuts={ariaKeys("terminal")}
        aria-pressed={open}
        onClick={() => setOpen(!open)}
      >
        <SquareTerminalIcon className="size-4.5" />
      </Button>
    </Tip>
  );
}

export function RoomHeader() {
  const room = useStore((s) => s.snap?.state);
  const openDialog = useStore((s) => s.openDialog);
  const openFile = useStore((s) => s.openFile);
  const openChanges = useStore((s) => s.openChanges);
  if (!room) return null;
  return (
    <header className="@container flex h-14 shrink-0 items-center gap-2 border-b border-border/70 bg-background/85 px-3 backdrop-blur sm:px-4">
      <NavButton />
      {/* The name keeps its room when a side panel narrows the header: the agents' chips give way first. */}
      <div className="flex min-w-[min(10rem,40cqw)] flex-1 flex-col justify-center leading-tight">
        <Title />
        <Place />
      </div>
      <ViewSwitch />
      <div className="hidden min-w-0 shrink items-center gap-1.5 @min-[36rem]:flex">
        {room.agents.map((a) => (
          <Presence key={a.id} a={a} />
        ))}
      </div>
      <span className="mx-0.5 hidden h-5 w-px bg-border @min-[36rem]:block" />
      <TerminalToggle />
      <PanelToggle />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground"
            aria-label="More"
          >
            <EllipsisIcon className="size-4.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuItem
            onSelect={() => useStore.getState().openSession()}
            className="items-start gap-2.5 py-2"
          >
            <TerminalIcon className="mt-0.5" />
            <span className="flex flex-col">
              Agent sessions
              <small className="text-xs text-muted-foreground">
                Everything agents did in their own sessions; {t.model.and}
              </small>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openChanges({ scope: "room" })}>
            <GitCompareArrowsIcon />
            All room changes
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openFile(null)}>
            <FolderIcon />
            Working folder files
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openDialog({ kind: "revert" })}>
            <RotateCcwIcon />
            Revert folder…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openDialog({ kind: "usage" })}>
            <ReceiptIcon />
            Room costs
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openDialog({ kind: "settings" })}>
            <SettingsIcon />
            Room settings
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => useStore.getState().setPaletteOpen(true)}
          >
            <LayoutPanelLeftIcon />
            All actions
            <span className="ml-auto font-mono text-xs text-faint">{keyLabel("palette")}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
