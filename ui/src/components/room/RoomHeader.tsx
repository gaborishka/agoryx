import { ConversationControls } from "./ConversationControls";
import { isProtocolMode } from "@/lib/workflow";
import {
  EllipsisIcon,
  FolderIcon,
  GitPullRequestArrowIcon,
  FoldersIcon,
  GitBranchIcon,
  GitCompareArrowsIcon,
  HourglassIcon,
  HistoryIcon,
  LayoutPanelLeftIcon,
  MessagesSquareIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  ReceiptIcon,
  RotateCcwIcon,
  ScaleIcon,
  Settings2Icon,
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
import { baseName, clock as timeOf, names, secs, shortPath } from "@/lib/format";
import { ariaKeys, keyLabel } from "@/lib/keys";
import { ink, nameOf, participant, profileLine, tableCount, turnClock, turnLimit, waitingFor } from "@/lib/room";
import { useStore } from "@/lib/store";
import type { RoomAgent } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Avatar, Tip } from "./bits";
import { useShallow } from "zustand/react/shallow";
import { canOpenPr, OpenPr, PrChip } from "./Github";
import { t } from "@/lib/i18n";

function Presence({ a }: { a: RoomAgent }) {
  const now = useStore((s) => s.snap?.presence?.[a.id] ?? "idle");
  const turn = useStore((s) =>
    s.snap?.state.turns.find((t) => t.agent === a.id && t.status === "running"),
  );
  const room = useStore((s) => s.snap?.state);
  const ops = useStore((s) => s.snap?.ops);
  const openSession = useStore((s) => s.openSession);
  const profile = useStore((s) => s.snap?.profile);
  const tick = useNow(now === "working" && Boolean(turn));
  const who = participant(room, a.id);
  const tone = who.tone;
  const working = now === "working" && turn;
  const seen = profileLine(a, profile);
  // The limit the turn started with: a change to the setting applies from the next turn.
  const limit = working && room ? turnLimit(room, turn) : 0;
  const elapsed = working ? tick - new Date(turn.startedAt).getTime() : 0;
  const late = Boolean(working && limit && elapsed >= limit * 0.8);
  const clock = working ? (limit ? turnClock(elapsed, limit) : secs(elapsed)) : "";
  const brief = working && limit ? turnClock(elapsed, limit, true) : clock;
  // Whom it wrote to who has not written since: an agent may wait inside its turn, burning the turn's time.
  const waits = room && (now === "working" || now === "idle") ? waitingFor(room, a.id, ops) : null;
  const awaited = waits ? names(waits.who.map((h) => (h === room?.human.toLowerCase() ? "you" : nameOf(room, h)))) : "";
  const state = working
    ? `${a.label} is taking a turn in the room${limit ? ` — ${clock}: the room stops a turn at its limit` : ""}`
    : now === "native"
      ? `${a.label} is in a direct conversation in its own session; its room turn starts after that`
      : now === "queued"
        ? `${a.label} is queued for a turn`
        : waits
          ? `${a.label} is waiting for ${awaited}`
          : `${a.label} is waiting for something new in the conversation`;
  const wrote = waits ? room?.messages.find((m) => m.id === waits.since)?.ts : undefined;
  const asked = waits ? ` It wrote to ${awaited}${wrote ? ` at ${timeOf(wrote)}` : ""}, and ${waits.who.length > 1 ? "they have" : awaited === "you" ? "you have" : "it has"} not written since.` : "";
  const tip = `${seen ? `${state}. ${seen}` : state}.${asked} Click to open the session on the side.`;
  const short = working
    ? `working, ${clock}${waits ? `, waiting for ${awaited}` : ""}`
    : now === "native"
      ? "in own session"
      : now === "queued"
        ? "queued"
        : waits
          ? `waiting for ${awaited}`
          : "waiting";
  const busy = now !== "idle";
  return (
    <Tip tip={tip}>
      <button
        type="button"
        onClick={() => openSession(a.id, true)}
        aria-label={`${a.label}: ${short}. Open session`}
        style={ink(who)}
        className={cn(
          "inline-flex h-8 min-w-0 shrink-0 items-center gap-1.5 rounded-full p-1 text-small whitespace-nowrap transition",
          busy || waits ? "pr-2.5" : "",
          now === "idle"
            ? "hover:bg-accent"
            : tone === "codex"
              ? "bg-codex-soft text-codex ring-1 ring-codex/25 ring-inset"
              : "bg-claude-soft text-claude ring-1 ring-claude/25 ring-inset",
        )}
      >
        <Avatar handle={a.id} size={24} live={Boolean(working)} />
        {working ? (
          <span className={cn("tabular hidden @min-[44rem]:inline", late ? "font-medium text-amber-ink" : "")} data-turn-clock>
            <span className="@min-[58rem]:hidden">{brief}</span>
            <span className="hidden @min-[58rem]:inline">{clock}</span>
          </span>
        ) : null}
        {now === "native" ? <span className="hidden @min-[52rem]:inline">own session</span> : null}
        {now === "queued" ? <span className="hidden @min-[52rem]:inline">queued</span> : null}
        {waits ? (
          <span className={cn("flex items-center gap-1", now === "idle" ? "text-muted-foreground" : "opacity-80")} data-waiting>
            <HourglassIcon className="size-3 shrink-0" aria-hidden />
            <span className="hidden max-w-[9rem] truncate @min-[64rem]:inline">{awaited}</span>
          </span>
        ) : null}
      </button>
    </Tip>
  );
}

function Title() {
  const name = useStore((s) => s.snap?.state.name ?? "");
  const createdBy = useStore((s) => s.snap?.state.createdBy);
  const id = useStore((s) => s.snap?.state.id);
  const parent = useStore((s) => s.snap?.state.parent);
  const parentName = useStore((s) => s.rooms.find((room) => room.id === s.snap?.state.parent)?.name);
  const go = useStore((s) => s.go);
  const openThread = useStore((s) => s.openThread);
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
          className="h-7 w-full rounded-md border border-foreground/30 bg-card px-1.5 font-display text-[16px] font-semibold outline-none ring-3 ring-foreground/[0.07]"
        />
      </form>
    );
  }
  const title = (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title={createdBy ? `Rename. This room was opened from room “${createdBy.roomName}”: ${createdBy.label}` : "Rename"}
      className="-mx-1.5 min-w-0 truncate rounded-md px-1.5 text-left font-display text-[16px] leading-snug font-semibold hover:bg-accent"
    >
      {name}
    </button>
  );
  if (!parent) return title;
  // A thread: the room it came from, which opens with this thread beside it.
  return (
    <span className="flex min-w-0 items-center gap-1">
      <button
        type="button"
        title="The room this thread was started from"
        onClick={() => {
          go({ kind: "room", id: parent });
          if (id) openThread(id);
        }}
        className="max-w-[40%] shrink-0 truncate rounded-md px-1 text-small text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {parentName ?? parent}
      </button>
      <span className="shrink-0 text-faint">›</span>
      {title}
    </span>
  );
}

/** The global workspace bar owns the sidebar toggle on every page. */
export function NavButton() { return null; }

/** Conversation, shared table, and all structured sessions stay inside the same chat. */
function ViewSwitch() {
  const room = useStore((s) => s.snap?.state);
  const view = useStore((s) => s.view);
  const workspaceMode = useStore((s) => s.workspaceMode);
  const setView = useStore((s) => s.setView);
  if (!room) return null;
  const count = tableCount(room);
  const tab = (on: boolean) =>
    cn(
      "inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-small font-medium transition sm:px-3",
      on
        ? "bg-background text-foreground shadow-edge ring-1 ring-border/70"
        : "text-muted-foreground hover:text-foreground",
    );
  return (
    <div
      role="tablist"
      aria-label="Room view"
      className="flex w-fit max-w-full items-center gap-0.5 rounded-lg bg-muted p-0.5"
    >
      <Tip tip={<span>Conversation <Kbd>{keyLabel("chat")}</Kbd></span>}>
        <button
          type="button"
          role="tab"
          aria-selected={!isProtocolMode(workspaceMode) && view === "chat"}
          aria-label="Conversation"
          aria-keyshortcuts={ariaKeys("chat")}
          className={tab(!isProtocolMode(workspaceMode) && view === "chat")}
          onClick={() => setView("chat")}
        >
          <MessagesSquareIcon className="size-4" />
          <span className="inline">Conversation</span>
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
          <span className="inline">Table</span>
          {count ? (
            <span className="tabular grid h-4.5 min-w-4.5 place-items-center rounded-full bg-amber px-1 text-micro font-semibold text-amber-foreground">
              {count}
            </span>
          ) : null}
        </button>
      </Tip>
      <Tip tip="Sessions: start a mode or revisit any previous run in this chat">
        <button type="button" role="tab" aria-selected={isProtocolMode(workspaceMode) || view === "sessions"} aria-label="Sessions" className={tab(isProtocolMode(workspaceMode) || view === "sessions")} onClick={() => setView("sessions")}>
          <HistoryIcon className="size-4" /><span className="inline">Sessions</span>
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

/** Where the room works, under its name: its project, its folder and branch (or its own worktree), its pull request, and its mode. */
function Place() {
  const room = useStore((s) => s.snap?.state);
  const openFile = useStore((s) => s.openFile);
  const go = useStore((s) => s.go);
  const project = useStore(useShallow((s) => {
    const summary = s.rooms.find((entry) => entry.id === s.snap?.state.id);
    return summary?.projectHash ? { hash: summary.projectHash, name: summary.projectName } : null;
  }));
  const asked = useBranch(room?.id ?? "", (room?.turns.length ?? 0) + (room?.modeSince ?? 0));
  const branch = room?.repo ? (room.repo.branch ?? asked) : asked;
  if (!room) return null;
  if (room.mode === "chat") return null;
  const wt = room.worktree;
  const folder = wt ? wt.source : room.workspace;
  const tip = wt
    ? t.worktree.place(wt.branch, wt.base, room.workspace, room.agents.map((a) => a.label), wt.source)
    : `Working folder: ${room.workspace}${branch ? `, branch ${branch}` : ""}`;
  return (
    <div className="flex min-w-0 items-center gap-2 text-meta text-faint">
      {project ? (
        <button type="button" onClick={() => go({ kind: "project", hash: project.hash })} title="Open the project" className="max-w-[12rem] shrink-0 truncate font-medium text-muted-foreground transition hover:text-foreground">
          {project.name || baseName(folder)}
        </button>
      ) : null}
      <Tip tip={tip}>
        <button
          type="button"
          onClick={() => openFile(null)}
          className="flex w-fit max-w-full min-w-0 items-center gap-2 transition hover:text-muted-foreground"
        >
          <span className="hidden min-w-0 items-center gap-1 @min-[40rem]:flex">
            <FolderIcon className="size-3 shrink-0" />
            <span className="truncate">{wt ? baseName(folder) : shortPath(folder)}</span>
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
      <PrChip />
    </div>
  );
}

/** One button for the side panel; it opens on the tab shown last. The dot: an agent drives the room's browser. */
/** The room's project beside the conversation: its threads, library and usage. */
function OverviewToggle() {
  const on = useStore((s) => s.panel === "project");
  const togglePanel = useStore((s) => s.togglePanel);
  return (
    <Tip tip="The project: its threads, its library and what its rooms took">
      <Button
        variant="ghost"
        size="icon"
        className={cn("hidden size-8 text-muted-foreground @min-[36rem]:inline-flex", on && "bg-secondary text-secondary-foreground hover:bg-secondary")}
        aria-label="Project overview"
        aria-pressed={on}
        onClick={() => togglePanel("project")}
      >
        <FoldersIcon className="size-4.5" />
      </Button>
    </Tip>
  );
}

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
  const workspaceMode = useStore(s => s.workspaceMode);
  const room = useStore((s) => s.snap?.state);
  const openDialog = useStore((s) => s.openDialog);
  const openFile = useStore((s) => s.openFile);
  const openChanges = useStore((s) => s.openChanges);
  // A Work room is in its folder's project: its overview and settings are a click away from here.
  const projectHash = useStore((s) => s.rooms.find((entry) => entry.id === s.snap?.state.id)?.projectHash);
  const driven = useStore((s) => s.snap?.driven);
  /** Where "Open PR" was opened from: its button, or the menu (the only way to it on a narrow header). */
  const [pr, setPr] = useState<"button" | "menu" | null>(null);
  if (!room) return null;
  const prOpenable = room.mode !== "chat" && Boolean(room.repo) && canOpenPr(room, driven);
  return (
    <div className="@container/roomhead shrink-0">
    <header className="@container flex h-14 shrink-0 items-center gap-1 border-b border-border/70 bg-background/85 px-2 backdrop-blur @min-[36rem]:gap-1.5 sm:px-4">
      <NavButton />
      {/* The name keeps its room when a side panel narrows the header: the agents' clocks give way first. On a phone
          the pull request moves into the menu, so nothing runs past the screen's edge. */}
      <div className="flex min-w-[min(10rem,30cqw)] flex-1 flex-col justify-center gap-0.5 pl-1">
        <Title />
        <Place />
      </div>
      <div className={cn("hidden min-w-0 shrink items-center gap-0.5", !isProtocolMode(workspaceMode) && "@min-[36rem]:flex")}>
        {room.agents.map((a) => (
          <Presence key={a.id} a={a} />
        ))}
      </div>
      {room.mode !== "chat" ? (
        <OpenPr className="hidden @min-[36rem]:inline-flex" open={pr !== null} setOpen={(open) => setPr(open ? "button" : null)} fromMenu={pr === "menu"} />
      ) : null}
      <div className="hidden @min-[48rem]/roomhead:block"><ViewSwitch /></div>
      <span className="mx-1 hidden h-5 w-px bg-border @min-[36rem]:block" />
      {projectHash ? <OverviewToggle /> : null}
      {room.mode !== "chat" ? <TerminalToggle /> : null}
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
        {/* Focus going back to "More" would close the pull request's popover the moment the menu opens it. */}
        <DropdownMenuContent align="end" className="w-64" onCloseAutoFocus={(event) => pr === "menu" && event.preventDefault()}>
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
          {prOpenable ? (
            <DropdownMenuItem
              disabled={room.turns.some((turn) => turn.status === "running")}
              onSelect={() => setPr("menu")}
            >
              <GitPullRequestArrowIcon />
              Open pull request
            </DropdownMenuItem>
          ) : null}
          {room.mode !== "chat" ? <DropdownMenuItem onSelect={() => openChanges({ scope: "room" })}>
            <GitCompareArrowsIcon />
            All room changes
          </DropdownMenuItem> : null}
          <DropdownMenuItem onSelect={() => openFile(null)}>
            <FolderIcon />
            {room.mode === "chat" ? "Conversation files" : "Working folder files"}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openDialog({ kind: "mode" })}>
            <MessagesSquareIcon />
            {room.mode === "chat" ? "Switch to Work…" : "Switch to Chat…"}
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
          {projectHash ? (
            <>
              <DropdownMenuItem onSelect={() => useStore.getState().setPanel("project")}>
                <FoldersIcon />
                Project overview
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openDialog({ kind: "project", hash: projectHash })}>
                <Settings2Icon />
                Project settings…
              </DropdownMenuItem>
            </>
          ) : null}
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
    <ConversationControls />
    <div className="flex shrink-0 items-center border-b border-border/70 bg-background px-3 py-2 sm:px-5 @min-[48rem]/roomhead:hidden"><ViewSwitch /></div>
    </div>
  );
}
