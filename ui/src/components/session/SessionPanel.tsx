import {
  AlertTriangleIcon,
  BanIcon,
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CopyIcon,
  DotIcon,
  FilePenLineIcon,
  FileSearchIcon,
  GlobeIcon,
  ListChecksIcon,
  type LucideIcon,
  MinimizeIcon,
  SearchIcon,
  SquareIcon,
  SquareTerminalIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { memo, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Patch } from "@/components/code/Code";
import { EmptyState, ErrorNote, Loading } from "@/components/common/states";
import { Markdown } from "@/components/md/Markdown";
import { Avatar, Stats, Tip } from "@/components/room/bits";
import { ModelMenu } from "@/components/room/ModelMenu";
import { Button } from "@/components/ui/button";
import { api, roomPath, Unauthorized } from "@/lib/api";
import { clock, fullDate } from "@/lib/format";
import { ink, participant } from "@/lib/room";
import { useStore } from "@/lib/store";
import type { ActivityKind, RoomAgent, TranscriptDiff, TranscriptEntry, TranscriptImage, TranscriptTodo, TranscriptTool } from "@/lib/types";
import { copyText } from "@/lib/copy";
import { useModels } from "@/lib/models";
import { cn } from "@/lib/utils";

/**
 * An agent's own session, read from the CLI's own session file: what Claude Code or Codex would show in
 * the terminal — messages, thinking, every tool call with what went in and came out, edits as diffs, todos.
 * Agoryx only reads it; the session stays the agent's.
 */

const POLL_MS = 2000;
/** Older pages and live updates together; the oldest go first past this. */
const KEEP = 3000;

interface SessionReply {
  agent: string;
  sessionId: string | null;
  file: string | null;
  entries: TranscriptEntry[];
  start: number;
  end: number;
  size: number;
}

type Reply = SessionReply | { unchanged: true; size: number };

const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Entries are keyed by what the session file calls them: a newer read of the same one replaces it in place. */
const merge = (old: TranscriptEntry[], next: TranscriptEntry[], where: "before" | "after"): TranscriptEntry[] => {
  const fresh = new Map(next.map((e) => [e.id, e]));
  const kept = old.map((e) => fresh.get(e.id) ?? e);
  const seen = new Set(old.map((e) => e.id));
  const added = next.filter((e) => !seen.has(e.id));
  const all = where === "before" ? [...added, ...kept] : [...kept, ...added];
  return all.length > KEEP ? all.slice(all.length - KEEP) : all;
};

// --- fetching ----------------------------------------------------------------------------

interface SessionView {
  loading: boolean;
  error: string | null;
  sessionId: string | null;
  file: string | null;
  entries: TranscriptEntry[];
  /** Where the oldest shown entry starts in the file; 0: the whole session is shown. */
  start: number;
  size: number;
  older: boolean;
}

const EMPTY: SessionView = { loading: true, error: null, sessionId: null, file: null, entries: [], start: 0, size: 0, older: false };

function useSession(roomId: string, agent: string, sessionId: string | undefined) {
  const [view, setView] = useState<SessionView>(EMPTY);
  const sizeRef = useRef(0);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    sizeRef.current = 0;
    setView(EMPTY);
    const base = `${roomPath(roomId, "/session")}?agent=${encodeURIComponent(agent)}`;
    const tick = async () => {
      try {
        const known = sizeRef.current;
        const reply = await api<Reply>("GET", known ? `${base}&size=${known}` : base);
        if (!alive) return;
        if ("unchanged" in reply) {
          setView((v) => (v.loading || v.error ? { ...v, loading: false, error: null } : v));
        } else {
          const shrank = reply.size < known;
          sizeRef.current = reply.size;
          setView((v) => {
            const fresh = shrank || !known || v.sessionId !== reply.sessionId;
            return {
              loading: false,
              error: null,
              sessionId: reply.sessionId,
              file: reply.file,
              entries: fresh ? reply.entries : merge(v.entries, reply.entries, "after"),
              start: fresh ? reply.start : Math.min(v.start, reply.start),
              size: reply.size,
              older: false,
            };
          });
        }
      } catch (error) {
        if (!alive || error instanceof Unauthorized) return;
        setView((v) => ({ ...v, loading: false, error: errText(error) }));
      }
      if (alive && document.visibilityState !== "hidden") timer = setTimeout(tick, POLL_MS);
      else if (alive) timer = setTimeout(tick, POLL_MS * 5);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
    // A new session for the agent (resumed elsewhere, reset) is read from the start.
  }, [roomId, agent, sessionId]);

  const loadOlder = useCallback(async (from: number) => {
    if (!from) return;
    setView((v) => ({ ...v, older: true }));
    try {
      const reply = await api<Reply>("GET", `${roomPath(roomId, "/session")}?agent=${encodeURIComponent(agent)}&end=${from}`);
      if ("unchanged" in reply) return;
      setView((v) => ({ ...v, older: false, entries: merge(v.entries, reply.entries, "before"), start: reply.start }));
    } catch (error) {
      setView((v) => ({ ...v, older: false }));
      if (!(error instanceof Unauthorized)) toast.error(errText(error));
    }
  }, [roomId, agent]);

  return { view, loadOlder };
}

// --- header: whose session, model and effort -----------------------------------------------

function AgentTabs({ agents, current }: { agents: RoomAgent[]; current: string }) {
  const openSession = useStore((s) => s.openSession);
  const presence = useStore((s) => s.snap?.presence);
  const room = useStore((s) => s.snap?.state);
  return (
    <div role="tablist" aria-label="Whose session" className="scroll-thin flex gap-1 overflow-x-auto">
      {agents.map((a) => {
        const on = a.id === current;
        const now = presence?.[a.id] ?? "idle";
        return (
          <button
            key={a.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => openSession(a.id)}
            style={on ? ink(participant(room, a.id)) : undefined}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-2 rounded-lg px-2.5 text-small transition",
              on ? "bg-secondary font-semibold text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Avatar handle={a.id} size={18} live={now === "working"} />
            {a.label}
            {now !== "idle" ? <span className={cn("size-1.5 rounded-full", now === "native" ? "bg-amber" : "bg-primary")} aria-hidden /> : null}
          </button>
        );
      })}
    </div>
  );
}

function ResumeLine({ command }: { command: string }) {
  const code = useRef<HTMLElement>(null);
  const openTerminal = useStore((s) => s.openTerminal);
  return (
    <div className="flex items-center gap-1 rounded-lg border border-border bg-code py-0.5 pr-0.5 pl-2.5">
      <TerminalIcon className="size-3.5 shrink-0 text-faint" />
      <code ref={code} className="scroll-thin min-w-0 flex-1 overflow-x-auto font-mono text-meta whitespace-nowrap">
        {command}
      </code>
      <Button size="icon" variant="ghost" className="size-7 shrink-0" aria-label="Copy command" title="Copy" onClick={() => void copyText(command, code.current)}>
        <CopyIcon className="size-3.5" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="size-7 shrink-0"
        aria-label="Continue in a terminal"
        title="Continue in a terminal: the command is typed into a new room terminal, Enter is yours"
        onClick={() => openTerminal(command)}
      >
        <SquareTerminalIcon className="size-3.5" />
      </Button>
    </div>
  );
}

// --- entries -----------------------------------------------------------------------------

const ICON: Record<ActivityKind, LucideIcon> = {
  command: TerminalIcon,
  edit: FilePenLineIcon,
  read: FileSearchIcon,
  search: SearchIcon,
  web: GlobeIcon,
  browser: GlobeIcon,
  tool: WrenchIcon,
  thinking: BrainIcon,
  note: DotIcon,
  denied: BanIcon,
  error: AlertTriangleIcon,
};


/** Rendered once it first scrolls near the view: a long session has many diffs. */
function Near({ children, minHeight }: { children: ReactNode; minHeight: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver((items) => items.some((i) => i.isIntersecting) && setSeen(true), { rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return (
    <div ref={ref} style={seen ? undefined : { minHeight }}>
      {seen ? children : null}
    </div>
  );
}

const diffStats = (diffs: TranscriptDiff[]) => {
  let added = 0;
  let removed = 0;
  for (const d of diffs) {
    for (const line of d.patch.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) added++;
      else if (line.startsWith("-") && !line.startsWith("---")) removed++;
    }
  }
  return { added, removed };
};

function Images({ images }: { images: TranscriptImage[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {images.map((img, i) =>
        img.src ? (
          <a key={i} href={img.src} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-border">
            <img src={img.src} alt={img.path ?? "image"} className="max-h-40 max-w-full object-contain" />
          </a>
        ) : (
          <span key={i} className="rounded-md border border-border px-2 py-1 font-mono text-meta text-muted-foreground">
            {img.path ?? "image"}
          </span>
        ),
      )}
    </div>
  );
}

function Todos({ todos }: { todos: TranscriptTodo[] }) {
  return (
    <ul className="flex flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2">
      {todos.map((t, i) => {
        const Icon = t.status === "completed" ? CheckIcon : t.status === "in_progress" ? CircleDotIcon : SquareIcon;
        return (
          <li key={i} className="flex items-start gap-2 text-small">
            <Icon className={cn("mt-0.5 size-3.5 shrink-0", t.status === "completed" ? "text-add-ink" : t.status === "in_progress" ? "text-primary" : "text-faint")} />
            <span className={cn(t.status === "completed" && "text-muted-foreground line-through", t.status === "in_progress" && "font-medium")}>{t.text}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Block({ label, text, fail }: { label: string; text: string; fail?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-meta font-medium text-faint">{label}</span>
      <pre
        className={cn(
          "scroll-thin max-h-72 overflow-auto rounded-lg border border-border bg-code px-2.5 py-2 font-mono text-meta leading-[1.55] whitespace-pre-wrap break-words",
          fail && "border-destructive/30 text-destructive",
        )}
      >
        {text}
      </pre>
    </div>
  );
}

function ToolEntry({ e }: { e: TranscriptTool }) {
  const Icon = ICON[e.category] ?? WrenchIcon;
  const fail = e.status === "fail";
  const hasDiff = Boolean(e.diffs?.length);
  const stats = useMemo(() => (hasDiff ? diffStats(e.diffs!) : null), [hasDiff, e.diffs]);
  const small = hasDiff && e.diffs!.reduce((n, d) => n + d.patch.length, 0) < 8000;
  const [open, setOpen] = useState(false);
  const body = Boolean(e.input || e.output || hasDiff);
  const showDiff = hasDiff && (open || small);
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        disabled={!body}
        onClick={() => setOpen(!open)}
        aria-expanded={body ? open : undefined}
        className={cn("group/tool flex min-w-0 items-start gap-2 rounded-md text-left", body && "cursor-pointer")}
      >
        <span
          className={cn(
            "mt-[2px] grid size-[18px] shrink-0 place-items-center rounded-md bg-card ring-1 ring-border",
            fail && "text-destructive ring-destructive/40",
            e.status === "running" && "text-primary ring-primary/40",
          )}
        >
          <Icon className={cn("size-3", e.status === "running" && "animate-pulse")} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 text-small font-semibold">{e.tool}</span>
            {e.title && e.title !== e.tool ? (
              <span className={cn("truncate font-mono text-meta text-muted-foreground", fail && "text-destructive")} title={e.title}>
                {e.title}
              </span>
            ) : null}
            {stats ? <Stats added={stats.added} removed={stats.removed} /> : null}
          </span>
          {e.detail ? <span className="block truncate text-meta text-faint">{e.detail}</span> : null}
        </span>
        {body ? (
          <ChevronRightIcon className={cn("mt-1 size-3.5 shrink-0 text-faint transition group-hover/tool:text-foreground", open && "rotate-90")} />
        ) : null}
      </button>
      {e.todos?.length ? (
        <div className="pl-[26px]">
          <Todos todos={e.todos} />
        </div>
      ) : null}
      {showDiff ? (
        <div className="pl-[26px]">
          <Near minHeight={80}>
            <Patch patch={e.diffs!.map((d) => d.patch).join("\n")} className="text-meta" />
          </Near>
        </div>
      ) : null}
      {open ? (
        <div className="flex flex-col gap-2 pl-[26px]">
          {e.input ? <Block label="Input" text={e.input} /> : null}
          {e.output ? <Block label={fail ? "Error" : "Output"} text={e.output} fail={fail} /> : null}
        </div>
      ) : null}
      {e.images?.length ? (
        <div className="pl-[26px]">
          <Images images={e.images} />
        </div>
      ) : null}
    </div>
  );
}

function Collapsed({ text, label, icon: Icon, italic }: { text: string; label: string; icon: LucideIcon; italic?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex items-center gap-2 text-left text-small text-muted-foreground hover:text-foreground">
        <Icon className="size-3.5 shrink-0" />
        <span className="shrink-0 font-medium">{label}</span>
        {!open ? <span className={cn("truncate text-faint", italic && "italic")}>{text.replace(/\s+/g, " ").slice(0, 160)}</span> : null}
        <ChevronDownIcon className={cn("ml-auto size-3.5 shrink-0 transition", !open && "-rotate-90")} />
      </button>
      {open ? (
        <div className={cn("scroll-thin max-h-[28rem] overflow-auto border-l-2 border-border pl-3 text-small leading-relaxed whitespace-pre-wrap text-muted-foreground", italic && "italic")}>
          {text}
        </div>
      ) : null}
    </div>
  );
}

const SYSTEM: Record<Extract<TranscriptEntry, { kind: "system" }>["code"], { label: string; icon: LucideIcon }> = {
  compacted: { label: "Context compacted", icon: MinimizeIcon },
  interrupted: { label: "Interrupted", icon: BanIcon },
  error: { label: "Error", icon: AlertTriangleIcon },
};

const Entry = memo(function Entry({ e, human }: { e: TranscriptEntry; human: string }) {
  switch (e.kind) {
    case "user":
      if (e.agoryx) return <Collapsed text={e.text} label="Turn from Agoryx" icon={CircleDashedIcon} />;
      return (
        <div className="flex flex-col items-end gap-1.5">
          <span className="text-micro text-faint" title={e.at ? fullDate(e.at) : undefined}>
            {human} {e.at ? clock(e.at) : ""}
          </span>
          {e.text ? <div className="max-w-[92%] rounded-2xl rounded-tr-md bg-secondary px-3.5 py-2 text-ui leading-relaxed whitespace-pre-wrap break-words">{e.text}</div> : null}
          {e.images?.length ? <Images images={e.images} /> : null}
        </div>
      );
    case "assistant":
      if (e.pass) {
        return (
          <span className="text-small text-faint">
            passes{e.text ? ` — ${e.text}` : " — nothing to add"}
          </span>
        );
      }
      return (
        <div className={cn("min-w-0 text-ui", e.commentary && "text-muted-foreground")}>
          <Markdown text={e.text} />
        </div>
      );
    case "thinking":
      return <Collapsed text={e.text} label="Thinking" icon={BrainIcon} italic />;
    case "tool":
      return <ToolEntry e={e} />;
    case "system": {
      const s = SYSTEM[e.code];
      return (
        <div className={cn("flex items-center gap-2 py-1 text-meta text-faint", e.code === "error" && "text-destructive")}>
          <span className="h-px flex-1 bg-border" />
          <s.icon className="size-3.5" />
          <span className="max-w-[80%] truncate" title={e.text}>
            {s.label}
            {e.text ? ` — ${e.text}` : ""}
          </span>
          <span className="h-px flex-1 bg-border" />
        </div>
      );
    }
  }
});

// --- the panel ----------------------------------------------------------------------------

function Transcript({ roomId, agent, sessionId, human }: { roomId: string; agent: RoomAgent; sessionId: string | undefined; human: string }) {
  const { view, loadOlder } = useSession(roomId, agent.id, sessionId);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const first = useRef(true);

  useEffect(() => {
    first.current = true;
    atBottom.current = true;
  }, [agent.id]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (anchor.current) {
      // Older entries went in above: keep what was on screen where it was.
      el.scrollTop = anchor.current.top + (el.scrollHeight - anchor.current.height);
      anchor.current = null;
      return;
    }
    if (atBottom.current || first.current) {
      el.scrollTop = el.scrollHeight;
      if (view.entries.length) first.current = false;
    }
  }, [view.entries]);

  const older = () => {
    const el = scroller.current;
    if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop };
    void loadOlder(view.start);
  };

  const running = useStore((s) => s.snap?.presence?.[agent.id] ?? "idle");

  let body: ReactNode;
  if (view.loading) {
    body = <Loading className="p-4" />;
  } else if (view.error && !view.entries.length) {
    body = <ErrorNote className="m-4">{view.error}</ErrorNote>;
  } else if (!view.sessionId) {
    body = <Empty>{agent.label} hasn’t had a turn in this room yet — the session appears after the first one.</Empty>;
  } else if (!view.file) {
    body = <Empty>The session file isn’t on this computer: the CLI keeps sessions elsewhere or has already removed it.</Empty>;
  } else if (!view.entries.length) {
    body = <Empty>Nothing in the session yet.</Empty>;
  } else {
    body = (
      <div className="flex flex-col gap-4 px-4 pt-3 pb-6">
        {view.start > 0 ? (
          <Button variant="ghost" size="sm" className="self-center text-muted-foreground" disabled={view.older} onClick={older}>
            {view.older ? "Loading…" : "Show earlier"}
          </Button>
        ) : (
          <span className="self-center text-meta text-faint">Start of session</span>
        )}
        {view.entries.map((e) => (
          <Entry key={e.id} e={e} human={human} />
        ))}
        {running === "working" || running === "native" ? (
          <span className="flex items-center gap-2 text-meta text-primary">
            <span className="size-1.5 animate-pulse rounded-full bg-primary" />
            {running === "native" ? "Talking directly in the session" : "Turn in progress"}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div
      ref={scroller}
      className="scroll-thin min-h-0 flex-1 overflow-y-auto"
      onScroll={(event) => {
        const el = event.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
    >
      {body}
    </div>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <EmptyState icon={ListChecksIcon} text={children} />;

export function SessionPanel() {
  const snap = useStore((s) => s.snap);
  const chosen = useStore((s) => s.sessionAgent);
  const models = useModels();
  const post = useStore((s) => s.post);
  if (!snap) return null;
  const st = snap.state;
  const agent = st.agents.find((a) => a.id === chosen) ?? st.agents[0];
  if (!agent) return <Empty>The room has no agents.</Empty>;
  const session = st.sessions[agent.id];
  const command = snap.resume?.[agent.id];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-2.5 border-b border-border/70 px-3 py-2.5">
        <AgentTabs agents={st.agents} current={agent.id} />
        <div className="flex flex-wrap items-center gap-1.5">
          <ModelMenu
            variant="field"
            side="bottom"
            align="start"
            agent={agent}
            seating={st}
            models={models}
            disabled={!snap.driven}
            className="max-w-[75%]"
            onSet={(change) => void post("/agent", { agent: agent.id, ...change }).catch((error) => !(error instanceof Unauthorized) && toast.error(errText(error)))}
          />
          <Tip tip="The change applies from the next turn: the live session restarts with the new model, and the conversation in it stays the same.">
            <span className="text-meta text-faint">from the next turn</span>
          </Tip>
        </div>
        {command ? <ResumeLine command={command} /> : null}
        {session ? (
          <span className="truncate text-meta text-faint" title={session.sessionId}>
            session <span className="font-mono">{session.sessionId}</span>
          </span>
        ) : null}
      </div>
      <Transcript key={agent.id} roomId={st.id} agent={agent} sessionId={session?.sessionId} human={st.human} />
    </div>
  );
}
