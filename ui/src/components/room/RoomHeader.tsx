import {
  EllipsisIcon,
  FileTextIcon,
  FolderIcon,
  GitBranchIcon,
  LayoutPanelLeftIcon,
  MenuIcon,
  MessagesSquareIcon,
  ScaleIcon,
  SettingsIcon,
  TerminalIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import { participant, tableCount } from "@/lib/room";
import { useStore } from "@/lib/store";
import type { RoomAgent } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Tip } from "./bits";

function Presence({ a }: { a: RoomAgent }) {
  const now = useStore((s) => s.snap?.presence?.[a.id] ?? "idle");
  const turn = useStore((s) =>
    s.snap?.state.turns.find((t) => t.agent === a.id && t.status === "running"),
  );
  const room = useStore((s) => s.snap?.state);
  const openDialog = useStore((s) => s.openDialog);
  const tick = useNow(now === "working" && Boolean(turn));
  const tone = participant(room, a.id).tone;
  const working = now === "working" && turn;
  const tip = working
    ? `${a.label} зараз робить хід у кімнаті`
    : now === "native"
      ? `З ${a.label} зараз розмовляють напряму, у власній сесії; хід у кімнаті почнеться після цього`
      : now === "queued"
        ? `${a.label} у черзі на хід`
        : `${a.label} чекає на нове в розмові`;
  return (
    <Tip tip={tip}>
      <button
        type="button"
        onClick={() => openDialog({ kind: "sessions" })}
        className={cn(
          "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px] transition",
          now === "idle"
            ? "border-border text-muted-foreground hover:bg-accent"
            : tone === "codex"
              ? "border-codex/30 bg-codex-soft text-codex"
              : "border-claude/30 bg-claude-soft text-claude",
        )}
      >
        <span
          className={cn(
            "size-1.5 rounded-full",
            now === "idle"
              ? "bg-faint"
              : tone === "codex"
                ? "bg-codex"
                : "bg-claude",
            now !== "idle" && "animate-breathe",
          )}
        />
        <b className="font-semibold">{a.label}</b>
        {working ? (
          <span className="tabular hidden opacity-80 md:inline">
            працює · {secs(tick - new Date(turn.startedAt).getTime())}
          </span>
        ) : null}
        {now === "native" ? (
          <span className="hidden opacity-80 md:inline">у своїй сесії</span>
        ) : null}
        {now === "queued" ? (
          <span className="hidden opacity-80 md:inline">у черзі</span>
        ) : null}
      </button>
    </Tip>
  );
}

function Title() {
  const name = useStore((s) => s.snap?.state.name ?? "");
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
          aria-label="Назва кімнати"
          onBlur={() => void commit()}
          onKeyDown={(event) => event.key === "Escape" && setEditing(false)}
          className="h-8 w-full rounded-lg border border-ring/50 bg-card px-2 text-[15px] font-semibold outline-none ring-3 ring-ring/15"
        />
      </form>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Перейменувати"
      className="-mx-1.5 min-w-0 truncate rounded-lg px-1.5 py-0.5 text-left text-[15px] font-semibold tracking-tight hover:bg-accent"
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
      aria-label="Кімнати"
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
      "inline-flex h-8 items-center gap-1.5 rounded-[9px] px-2.5 text-[13px] font-medium transition sm:px-3",
      on
        ? "bg-card text-foreground shadow-soft ring-1 ring-border"
        : "text-muted-foreground hover:text-foreground",
    );
  return (
    <div
      role="tablist"
      aria-label="Вигляд кімнати"
      className="flex shrink-0 items-center gap-0.5 rounded-xl bg-muted p-1"
    >
      <button
        type="button"
        role="tab"
        aria-selected={view === "chat"}
        className={tab(view === "chat")}
        onClick={() => setView("chat")}
      >
        <MessagesSquareIcon className="size-4" />
        <span className="hidden sm:inline">Розмова</span>
      </button>
      <Tip tip="Стіл: питання, варіанти, аргументи й рішення — вибір, розкладений по поличках">
        <button
          type="button"
          role="tab"
          aria-selected={view === "table"}
          className={tab(view === "table")}
          onClick={() => setView("table")}
        >
          <ScaleIcon className="size-4" />
          <span className="hidden sm:inline">Стіл</span>
          {count ? (
            <span className="tabular grid h-4.5 min-w-4.5 place-items-center rounded-full bg-amber px-1 text-[10.5px] font-semibold text-white dark:text-background">
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
  const openDialog = useStore((s) => s.openDialog);
  const branch = useBranch(room?.id ?? "", room?.turns.length ?? 0);
  if (!room) return null;
  const wt = room.worktree;
  const folder = wt ? wt.source : room.workspace;
  const tip = wt
    ? `Worktree кімнати: гілка ${wt.branch} від ${wt.base}, тека ${room.workspace}. Claude і Codex працюють у ньому разом; ${wt.source} лишається як є.`
    : `Робоча тека: ${room.workspace}${branch ? `, гілка ${branch}` : ""}`;
  return (
    <Tip tip={tip}>
      <button
        type="button"
        onClick={() => openDialog({ kind: "files" })}
        className="flex w-fit max-w-full min-w-0 items-center gap-1.5 text-[11px] text-faint hover:text-muted-foreground"
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
          <span className="shrink-0 rounded bg-secondary px-1 text-[10px] font-medium text-secondary-foreground">
            worktree
          </span>
        ) : null}
      </button>
    </Tip>
  );
}

export function RoomHeader() {
  const room = useStore((s) => s.snap?.state);
  const panel = useStore((s) => s.panel);
  const togglePanel = useStore((s) => s.togglePanel);
  const openDialog = useStore((s) => s.openDialog);
  if (!room) return null;
  const toggle = (on: boolean) =>
    cn(
      "h-8 gap-1.5 rounded-lg px-2.5 text-[13px] text-muted-foreground",
      on && "bg-secondary text-secondary-foreground hover:bg-secondary",
    );
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/70 bg-background/85 px-3 backdrop-blur sm:px-4">
      <NavButton />
      <div className="flex min-w-0 flex-1 flex-col justify-center leading-tight">
        <Title />
        <Place />
      </div>
      <ViewSwitch />
      <div className="hidden items-center gap-1.5 md:flex">
        {room.agents.map((a) => (
          <Presence key={a.id} a={a} />
        ))}
      </div>
      <span className="mx-1 hidden h-5 w-px bg-border md:block" />
      <Tip
        tip={
          room.settings.doc
            ? `Спільний документ: ${room.settings.doc}`
            : "Спільний документ кімнати"
        }
      >
        <Button
          variant="ghost"
          className={toggle(panel === "doc")}
          aria-label="Документ"
          aria-pressed={panel === "doc"}
          onClick={() => togglePanel("doc")}
        >
          <FileTextIcon className="size-4" />
          <span className="hidden md:inline">Документ</span>
        </Button>
      </Tip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground"
            aria-label="Ще"
          >
            <EllipsisIcon className="size-4.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuItem
            onSelect={() => openDialog({ kind: "sessions" })}
            className="items-start gap-2.5 py-2"
          >
            <TerminalIcon className="mt-0.5" />
            <span className="flex flex-col">
              Сесії агентів
              <small className="text-xs text-muted-foreground">
                Відкрити розмову в Claude Code чи Codex
              </small>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openDialog({ kind: "files" })}>
            <FolderIcon />
            Файли робочої теки
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openDialog({ kind: "settings" })}>
            <SettingsIcon />
            Налаштування кімнати
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => useStore.getState().setPaletteOpen(true)}
          >
            <LayoutPanelLeftIcon />
            Усі дії
            <span className="ml-auto text-xs text-faint">⌘K</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
