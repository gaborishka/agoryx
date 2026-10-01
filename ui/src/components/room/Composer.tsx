import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  CornerDownLeftIcon,
  EyeIcon,
  FolderOpenIcon,
  GitBranchIcon,
  LoaderCircleIcon,
  PlayIcon,
  PlusIcon,
  Settings2Icon,
  ShieldCheckIcon,
  SquareIcon,
  UserPlusIcon,
  UsersIcon,
  WifiOffIcon,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Avatar } from "@/components/room/bits";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { local, Unauthorized } from "@/lib/api";
import { useRoomDiff } from "@/lib/changes";
import { keyLabel } from "@/lib/keys";
import { baseName, names as nameList, plural } from "@/lib/format";
import type { AgentModels, LimitSnapshot, RoomAgent, RoomState } from "@/lib/types";
import { useModels } from "@/lib/models";
import { ModelMenu } from "@/components/room/ModelMenu";
import { AttachButton, AttachmentList, useAttachments, withFiles } from "@/components/room/Attachments";
import { LimitFace, LimitsSection } from "@/components/room/Limits";
import { ink, participant } from "@/lib/room";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

const fail = (error: unknown) => {
  if (!(error instanceof Unauthorized)) toast.error(error instanceof Error ? error.message : String(error));
};

const dot = "size-2 shrink-0 rounded-full";

/** Notes that stand above the composer: the room is driven elsewhere, or an agent is being talked to directly. */
export function StatusBar() {
  const snap = useStore((s) => s.snap);
  if (!snap) return null;
  const st = snap.state;
  const native = st.agents.filter((a) => snap.presence?.[a.id] === "native");
  const rows = [];
  if (!snap.driven) {
    rows.push(
      <div key="ro" className="flex items-center gap-2.5 text-muted-foreground">
        <span className={cn(dot, "bg-faint")} />
        <span>View only — another agoryx process runs this room{snap.lockedBy ? ` (${snap.lockedBy})` : ""}.</span>
      </div>,
    );
  }
  for (const a of native) {
    const who = participant(st, a.id);
    rows.push(
      <div key={`n-${a.id}`} className="flex items-center gap-2.5 text-muted-foreground">
        <span className={cn(dot, "animate-breathe", who.tone === "codex" ? "bg-codex" : "bg-claude")} style={ink(who)} />
        <span>{a.label} is in a direct conversation in its own session — its room turn starts after that.</span>
      </div>,
    );
  }
  if (!rows.length) return null;
  return <div className="flex w-full flex-col gap-1.5 px-1 text-small">{rows}</div>;
}

export const autosize = (ta: HTMLTextAreaElement | null, max = 0.4) => {
  if (!ta) return;
  ta.style.height = "auto";
  const limit = Math.round(window.innerHeight * max);
  ta.style.height = `${Math.min(ta.scrollHeight, limit)}px`;
  // A scrollbar only once the text outgrows the limit, never for a pixel of rounding.
  ta.style.overflowY = ta.scrollHeight > limit + 1 ? "auto" : "hidden";
};

export function Composer() {
  const room = useStore((s) => s.snap?.state);
  const driven = useStore((s) => s.snap?.driven ?? false);
  const post = useStore((s) => s.post);
  const roomId = room?.id;
  const ta = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const files = useAttachments();

  useEffect(() => {
    if (!roomId) return;
    files.clear();
    setText(local.get(`draft.${roomId}`) ?? "");
    if (window.matchMedia("(pointer: fine)").matches) setTimeout(() => ta.current?.focus(), 30);
  }, [roomId]);
  useLayoutEffect(() => autosize(ta.current), [text]);
  const compose = useStore((s) => s.compose);
  useEffect(() => {
    if (!compose || !roomId) return;
    setText(compose.text);
    local.set(`draft.${roomId}`, compose.text);
    setTimeout(() => {
      const el = ta.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compose]);

  if (!room) return null;
  const change = (value: string) => {
    setText(value);
    local.set(`draft.${room.id}`, value || null);
  };
  const send = async () => {
    const body = text.trim();
    if ((!body && !files.items.length) || !driven || sending) return;
    setSending(true);
    try {
      await post("/messages", { text: withFiles(body, await files.upload()) });
      change("");
      files.clear();
    } catch (error) {
      fail(error);
    } finally {
      setSending(false);
      ta.current?.focus();
    }
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };
  const mention = (who: string) => {
    const el = ta.current;
    const tag = `@${who} `;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? start;
    const before = text.slice(0, start);
    const pad = before && !/\s$/.test(before) ? " " : "";
    change(`${before}${pad}${tag}${text.slice(end)}`);
    const pos = before.length + pad.length + tag.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };
  const names = nameList(room.agents.map((a) => a.label));
  const ready = Boolean(text.trim() || files.items.length);

  return (
    <div className="flex w-full flex-col gap-2">
      <RoomStrip />
      <form
        className={cn(
          "rounded-[22px] border border-input bg-card shadow-soft transition focus-within:border-human/45 focus-within:shadow-lift focus-within:ring-4 focus-within:ring-human/10",
          !driven && "opacity-60",
          files.over && "border-human/45 ring-4 ring-human/10",
        )}
        {...files.drop}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <AttachmentList items={files.items} onRemove={files.remove} className="px-3 pt-3" />
        <div className="flex items-end gap-1 py-1.5 pr-2 pl-2">
          <AttachButton onFiles={files.add} disabled={!driven} className="mb-1" />
          <textarea
            ref={ta}
            rows={1}
            value={text}
            disabled={!driven}
            onChange={(event) => change(event.target.value)}
            onKeyDown={onKey}
            onPaste={files.onPaste}
            placeholder={driven ? `Message ${names}…` : "Another process runs this room — view only"}
            aria-label="Message"
            aria-describedby="composer-keys"
            data-composer
            className="scroll-thin block max-h-[40vh] min-h-[44px] overflow-y-hidden flex-1 pl-1 resize-none bg-transparent py-2.5 text-body leading-relaxed outline-none placeholder:truncate placeholder:text-faint"
          />
          <Button
            type="submit"
            size="icon"
            variant={ready ? "default" : "ghost"}
            className={cn("mb-1 size-8 shrink-0 rounded-full", !ready && "text-faint")}
            disabled={!driven || sending || !ready}
            aria-label="Send"
            title="Send (Enter)"
          >
            {ready ? <ArrowUpIcon className="size-4" /> : <CornerDownLeftIcon className="size-4" />}
          </Button>
        </div>
      </form>
      <ToolRow driven={driven} mention={mention} />
    </div>
  );
}

/**
 * Above the composer, only while it has news: the run's state with its one action, and what the turns changed
 * (the folder itself is in the header). The working dots are the working voices' own colours.
 */
function RoomStrip() {
  const snap = useStore((s) => s.snap);
  const post = useStore((s) => s.post);
  const openFile = useStore((s) => s.openFile);
  const [busy, setBusy] = useState(false);
  const run = snap?.state.runs.at(-1);
  useEffect(() => setBusy(false), [run?.id, run?.status, run?.budget]);
  if (!snap) return null;
  const room = snap.state;
  // The pill counts what "Whole room" shows: the folder against where the room began, once a turn changed files.
  const changed = room.turns.some((t) => t.changes?.length);
  const workers = room.agents.filter((a) => snap.presence?.[a.id] === "working");
  const working = workers.map((a) => a.label);
  const act = (suffix: string) => {
    setBusy(true);
    post(suffix).catch((error) => {
      setBusy(false);
      fail(error);
    });
  };
  const active = snap.driven && run?.status === "active";
  const waiting = snap.driven && !active && (run?.endReason === "budget" || run?.endReason === "stopped");
  const folder = room.worktree ? baseName(room.worktree.repo) : baseName(room.workspace);
  if (!active && !waiting && !changed) return null;

  return (
    <div className="flex min-h-10 items-center gap-2 rounded-xl bg-secondary/60 py-1.5 pr-1.5 pl-3.5 text-small">
      <button
        type="button"
        onClick={() => openFile(null)}
        title={`${room.workspace} — files`}
        className="flex min-w-0 shrink items-center gap-2.5 font-mono text-small text-muted-foreground transition hover:text-foreground"
      >
        <span className="truncate">{folder}</span>
        {room.worktree ? (
          <span className="hidden min-w-0 items-center gap-1 truncate sm:flex">
            <GitBranchIcon className="size-3.5 shrink-0 opacity-70" />
            <span className="truncate">{room.worktree.branch}</span>
          </span>
        ) : null}
      </button>
      {active || waiting ? (
        <span className="flex min-w-0 flex-1 items-center justify-end gap-2 truncate text-small">
          {active && workers.length ? (
            <span className="flex shrink-0 -space-x-0.5">
              {workers.map((a) => {
                const who = participant(room, a.id);
                return <span key={a.id} className={cn(dot, "animate-breathe ring-2 ring-secondary", who.tone === "codex" ? "bg-codex" : "bg-claude")} style={ink(who)} />;
              })}
            </span>
          ) : (
            <span className={cn(dot, active ? "animate-breathe bg-foreground/50" : "bg-amber")} />
          )}
          <span className="truncate">
            {active
              ? working.length
                ? `${nameList(working)} ${working.length > 1 ? "are working" : "is working"}`
                : "Conversation in progress"
              : run!.endReason === "budget"
                ? `${plural(run!.used, "turn", "turns")} done — waiting for you`
                : "Stopped"}
            {active ? <span className="tabular text-faint"> · turn {run!.used}{run!.budget !== null ? ` of ${run!.budget}` : ""}</span> : null}
          </span>
        </span>
      ) : (
        <span className="flex-1" />
      )}
      {changed ? <ChangesPill room={room} /> : null}
      {active ? (
        <Button size="sm" variant="outline" className="h-7 rounded-md bg-card text-destructive hover:bg-destructive-soft hover:text-destructive" disabled={busy} onClick={() => act("/stop")}>
          <SquareIcon className="size-3 fill-current" />
          Stop
        </Button>
      ) : waiting ? (
        <Button size="sm" variant="outline" className="h-7 rounded-md bg-card" disabled={busy} onClick={() => act("/continue")}>
          <PlayIcon className="size-3 fill-current" />
          Continue
        </Button>
      ) : null}
    </div>
  );
}

function ChangesPill({ room }: { room: RoomState }) {
  const openChanges = useStore((s) => s.openChanges);
  const on = useStore((s) => s.panel === "diff" && s.changes.scope === "room");
  const diff = useRoomDiff(room).data;
  if (!diff?.changes.length) return null;
  let added = 0;
  let removed = 0;
  for (const c of diff.changes) {
    added += c.added ?? 0;
    removed += c.removed ?? 0;
  }
  return (
    <button
      type="button"
      title={`${plural(diff.changes.length, "file", "files")} changed in the folder — all the room’s changes`}
      aria-pressed={on}
      onClick={() => openChanges({ scope: "room" })}
      className={cn(
        "tabular inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 font-mono text-small transition hover:border-ring/50",
        on && "border-ring/50",
      )}
    >
      <span className="text-add-ink">+{added.toLocaleString("en-US")}</span>
      <span className="text-del-ink">−{removed.toLocaleString("en-US")}</span>
    </button>
  );
}

const ACCESS = [
  { id: "terminal", label: "As in the terminal", hint: "Claude with your settings, Codex in its own sandbox", icon: ShieldCheckIcon, settings: { access: "workspace", network: true } },
  { id: "offline", label: "No network", hint: "Can write in the folder, no network for commands", icon: WifiOffIcon, settings: { access: "workspace", network: false } },
  { id: "readonly", label: "Read-only", hint: "Agents change nothing in the folder", icon: EyeIcon, settings: { access: "readonly", network: false } },
] as const;

/** Below the composer: whom to address, what agents may do, and each agent's model — Claude Code's footer, for a room. */
function ToolRow({ driven, mention }: { driven: boolean; mention: (who: string) => void }) {
  const room = useStore((s) => s.snap?.state);
  const presence = useStore((s) => s.snap?.presence);
  const limits = useStore((s) => s.snap?.limits);
  const post = useStore((s) => s.post);
  const openDialog = useStore((s) => s.openDialog);
  const models = useModels();
  if (!room) return null;
  const mode =
    room.settings.access === "readonly" ? ACCESS[2] : room.settings.network ? ACCESS[0] : ACCESS[1];
  const Mode = mode.icon;
  const running = room.runs.at(-1)?.status === "active";
  const setMode = (next: (typeof ACCESS)[number]) => {
    if (next.id === mode.id) return;
    post("/settings", next.settings).catch(fail);
  };
  const quiet = quietButton;

  return (
    <div className="@container flex min-h-7 items-center gap-1 px-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7 rounded-lg text-muted-foreground hover:text-foreground" disabled={!driven} aria-label="Mention" title="Mention someone">
            <PlusIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[230px]">
          <DropdownMenuLabel className="text-meta font-normal text-muted-foreground">Mention — wakes only the one named</DropdownMenuLabel>
          {room.agents.map((a) => (
            <DropdownMenuItem key={a.id} onSelect={() => mention(a.id)}>
              <Avatar handle={a.id} size={18} />
              {a.label}
              <span className="ml-auto font-mono text-meta text-faint">@{a.id}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem onSelect={() => mention("all")}>
            <UsersIcon className="size-4" />
            Everyone
            <span className="ml-auto font-mono text-meta text-faint">@all</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => useStore.getState().openFile(null)}>
            <FolderOpenIcon className="size-4" />
            Working folder
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className={quiet} disabled={!driven} title={mode.hint}>
            <Mode className="size-3.5" />
            <span className="hidden @min-[40rem]:inline">{mode.label}</span>
            <ChevronDownIcon className="size-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[280px]">
          <DropdownMenuLabel className="text-meta font-normal text-muted-foreground">What agents can do</DropdownMenuLabel>
          {ACCESS.map((m) => (
            <DropdownMenuItem key={m.id} onSelect={() => setMode(m)} className="items-start">
              <m.icon className="mt-0.5 size-4" />
              <span className="flex flex-col">
                {m.label}
                <span className="text-meta text-muted-foreground">{m.hint}</span>
              </span>
              <CheckIcon className={cn("mt-0.5 ml-auto size-4", m.id === mode.id ? "opacity-100" : "opacity-0")} />
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => openDialog({ kind: "settings" })}>
            <Settings2Icon className="size-4" />
            All room settings…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* A hint that does not fit whole wraps onto a hidden second line, so none is cut mid-word; the empty first item lets even the first one go. */}
      <span id="composer-keys" className={cn("h-5 min-w-0 flex-1 flex-wrap items-center gap-x-2.5 overflow-hidden px-1.5 text-meta whitespace-nowrap text-faint", driven ? "hidden pointer-fine:@min-[40rem]:flex" : "hidden")}>
        <span aria-hidden className="-mr-2.5 h-5 w-0" />
        <span className="flex h-5 items-center gap-1"><Kbd>{keyLabel("send")}</Kbd> send</span>
        <span className="flex h-5 items-center gap-1"><Kbd>{keyLabel("newline")}</Kbd> new line</span>
      </span>
      {/* The agents, one pill each, on one line: a long roster scrolls rather than wraps. */}
      <div role="group" aria-label="Agents in the room" className="-my-0.5 ml-auto flex min-w-0 items-center gap-0.5 overflow-x-auto py-0.5 [scrollbar-width:none]">
        {room.agents.map((a) => (
          <AgentModel key={a.id} agent={a} models={models} limits={limits} disabled={!driven} working={presence?.[a.id] === "working"} />
        ))}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
          onClick={() => openDialog({ kind: "agents" })}
          title="The room's agents: add, remove, roles"
          aria-label="The room's agents"
        >
          <UserPlusIcon className="size-3.5" />
        </Button>
      </div>
      {running ? <LoaderCircleIcon className="ml-1 size-4 shrink-0 animate-spin text-muted-foreground" aria-label="Agents are working" /> : null}
    </div>
  );
}

const quietButton = "h-7 gap-1.5 rounded-lg px-2 text-small font-normal text-muted-foreground hover:text-foreground";

/** One agent in the footer: its face ringed by its limits, its name and effort — model, effort and limits in one menu. */
function AgentModel({ agent, models, limits, disabled, working }: { agent: RoomAgent; models: AgentModels | null; limits: LimitSnapshot[] | undefined; disabled: boolean; working: boolean }) {
  const room = useStore((s) => s.snap?.state);
  const post = useStore((s) => s.post);
  const openSession = useStore((s) => s.openSession);
  const openDialog = useStore((s) => s.openDialog);
  if (!room) return null;
  return (
    <ModelMenu
      agent={agent}
      seating={room}
      models={models}
      disabled={disabled}
      working={working}
      variant="seat"
      face={
        <LimitFace kind={agent.kind} limits={limits}>
          <Avatar handle={agent.id} size={20} badge />
        </LimitFace>
      }
      extra={<LimitsSection kind={agent.kind} limits={limits} />}
      onSet={(change) => post("/agent", { agent: agent.id, ...change }).catch(fail)}
      onSession={() => openSession(agent.id)}
      onManage={() => openDialog({ kind: "agents", agent: agent.id })}
    />
  );
}
