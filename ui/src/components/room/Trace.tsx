import { workspaceAt } from "@agora/room-mode";
import {
  AlertTriangleIcon,
  AppWindowIcon,
  BanIcon,
  BrainIcon,
  ChevronRightIcon,
  DotIcon,
  FileTextIcon,
  FilePenLineIcon,
  FileSearchIcon,
  GlobeIcon,
  ListIcon,
  type LucideIcon,
  NetworkIcon,
  NotebookPenIcon,
  SearchIcon,
  Table2Icon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { useId, useMemo, useState } from "react";
import { rawUrl } from "@/components/md/Markdown";
import { Player } from "@/components/md/Media";
import { AUDIO_EXT, baseName, DIAGRAM_EXT, ext, IMAGE_EXT, plural, TABLE_EXT, VIDEO_EXT, VISUAL_EXT } from "@/lib/format";
import { nameOf } from "@/lib/room";
import { useStore } from "@/lib/store";
import { useTurnActivity } from "@/lib/turn-activity";
import type { Activity, DocRevision, TranscriptTool, TurnState } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Stats, Tip } from "./bits";

const ICON: Record<Activity["kind"], LucideIcon> = {
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

const WRAP = new Set<Activity["kind"]>(["thinking", "note", "error", "denied"]);

function DetailBlock({ label, text, fail }: { label: string; text: string; fail?: boolean }) {
  return <div className="mt-2 min-w-0"><span className="text-meta font-medium text-faint">{label}</span><pre className={cn("scroll-thin mt-1 max-h-72 overflow-auto rounded-lg border border-border bg-code px-2.5 py-2 font-mono text-meta leading-relaxed whitespace-pre-wrap break-words", fail && "border-destructive/30 text-destructive")}>{text}</pre></div>;
}

export function ActivityRow({ a, tool, loading, error, inspect }: { a: Activity; tool?: TranscriptTool; loading?: boolean; error?: string; inspect?: () => void }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const Icon = ICON[a.kind] ?? DotIcon;
  const fail = a.status === "fail" || a.kind === "error";
  const wrap = WRAP.has(a.kind);
  const expandable = !wrap || Boolean(tool && (tool.input || tool.output || tool.diffs?.length || tool.todos?.length));
  const label = wrap && a.label.length > 600 ? `${a.label.slice(0, 600)}…` : a.label;
  return (
    <li className="group/act relative flex gap-2.5 pl-0.5">
      <span
        className={cn(
          "relative z-10 mt-[3px] grid size-[18px] shrink-0 place-items-center rounded-md bg-card ring-1 ring-border",
          fail && "text-destructive ring-destructive/40",
          a.kind === "denied" && "text-amber ring-amber/40",
          a.status === "running" && "text-primary ring-primary/40",
        )}
      >
        <Icon className={cn("size-3", a.status === "running" && "animate-pulse")} />
      </span>
      <span className="min-w-0 flex-1 pb-1.5">
        {expandable ? <button
          type="button"
          onClick={() => { setOpen(!open); if (!open) inspect?.(); }}
          aria-expanded={open}
          aria-controls={id}
          className={cn(
            "flex w-full min-w-0 items-start gap-1.5 text-left text-small leading-6 text-muted-foreground hover:text-foreground",
            wrap ? "whitespace-pre-wrap break-words" : "truncate font-mono text-meta",
            a.kind === "thinking" && "italic",
            fail && "text-destructive",
          )}
          title={a.label}
        >
          <span className={cn("min-w-0 flex-1", !wrap && "truncate")}>{label}</span>
          <ChevronRightIcon className={cn("mt-1.5 size-3 shrink-0 text-faint transition", open && "rotate-90")} />
        </button> : <span className={cn("block text-small leading-6 whitespace-pre-wrap break-words text-muted-foreground", a.kind === "thinking" && "italic", fail && "text-destructive")} title={a.label}>{label}</span>}
        {a.detail && fail ? <span className="mt-0.5 block whitespace-pre-wrap break-words font-mono text-meta text-destructive/80">{a.detail.slice(0, 500)}</span> : null}
        {open && expandable ? <div id={id} className="pb-2">
          {tool ? <>
            {tool.category === "command" ? <DetailBlock label="Command" text={tool.input || tool.title} /> : tool.input ? <DetailBlock label="Input" text={tool.input} /> : null}
            {tool.output !== undefined ? <DetailBlock label={tool.status === "fail" ? "Error" : "Output"} text={tool.output} fail={tool.status === "fail"} /> : <p className="mt-2 text-meta text-faint">{tool.status === "running" ? "Running — output is not available yet." : "Completed with no text output."}</p>}
            {tool.diffs?.length ? <DetailBlock label="Changes" text={tool.diffs.map((d) => d.patch).join("\n")} /> : null}
            {tool.todos?.length ? <DetailBlock label="Plan" text={tool.todos.map((t) => `${t.status}: ${t.text}`).join("\n")} /> : null}
          </> : <>
            <DetailBlock label="Action" text={a.label} />
            {inspect && !WRAP.has(a.kind) ? <p role="status" className={cn("mt-2 text-meta text-faint", error && "text-destructive")}>{loading ? "Loading input and output…" : error ?? "Input and output for this action are not available in this session page."}</p> : null}
          </>}
        </div> : null}
      </span>
    </li>
  );
}

export function ActivityList({ items, turn, className, id }: { items: Activity[]; turn?: TurnState; className?: string; id?: string }) {
  const roomId = useStore((s) => s.snap?.state.id);
  const openSession = useStore((s) => s.openSession);
  const [requested, setRequested] = useState(false);
  const { view, older, retry } = useTurnActivity(roomId, turn, requested);
  const tools = useMemo(() => new Map(view.entries.map((e) => [e.id, e])), [view.entries]);
  return (
    <ol id={id} className={cn("relative before:absolute before:top-2 before:bottom-3 before:left-[9.5px] before:w-px before:bg-border", className)}>
      {items.map((a) => (
        <ActivityRow key={a.id} a={a} tool={tools.get(a.id)} loading={view.loading} error={view.error} inspect={turn ? () => setRequested(true) : undefined} />
      ))}
      {requested && turn ? <li className="flex flex-wrap items-center gap-3 py-1 pl-[28px] text-meta text-muted-foreground">
        {view.error ? <button type="button" onClick={retry} className="hover:text-foreground">Retry loading details</button> : null}
        {view.start > 0 && items.some((a) => !tools.has(a.id) && !WRAP.has(a.kind)) ? <button type="button" disabled={view.loading} onClick={() => void older()} className="hover:text-foreground disabled:opacity-50">{view.loading ? "Loading…" : "Load older session entries"}</button> : null}
        <button type="button" onClick={() => openSession(turn.agent, false)} className="hover:text-foreground">Open agent's session</button>
      </li> : null}
    </ol>
  );
}

const chip =
  "inline-flex h-7 max-w-full items-center gap-1.5 rounded-lg border border-border bg-card px-2 text-xs text-muted-foreground transition hover:border-input hover:bg-accent hover:text-foreground";

const CARD_KIND: Array<[Set<string>, LucideIcon, string]> = [
  [TABLE_EXT, Table2Icon, "Table"],
  [DIAGRAM_EXT, NetworkIcon, "Diagram"],
  [new Set(["pdf"]), FileTextIcon, "PDF"],
  [new Set(["html", "htm"]), AppWindowIcon, "Page"],
];

/**
 * What a turn made that is worth seeing — a plot, a page, a clip — shown right away,
 * unless the message already embeds or links it.
 */
function Made({ turn, text, compact }: { turn: TurnState; text?: string; compact?: boolean }) {
  const rawBase = useStore((s) => s.snap?.rawBase);
  const room = useStore((s) => s.snap?.state);
  const historical = room && workspaceAt(room, turn.seq) !== room.workspace;
  const openFile = useStore((s) => s.openFile);
  const [broken, setBroken] = useState<Set<string>>(new Set());
  const [more, setMore] = useState(false);
  if (!rawBase) return null;
  const deleted = (f: string) => turn.changes?.some((c) => c.status === "D" && (c.path === f || c.path.endsWith(`/${f}`)));
  const files = (turn.files ?? []).filter((f) => VISUAL_EXT.has(ext(f)) && !text?.includes(f) && !deleted(f) && !broken.has(f));
  if (!files.length) return null;
  const cap = more ? Infinity : compact ? 3 : 8;
  // Hiding a single file behind "one more" saves nothing.
  const shown = files.length > cap + 1 ? files.slice(0, cap) : files;
  const hide = (f: string) => setBroken((prev) => new Set(prev).add(f));
  return (
    <div className="mt-2.5 flex flex-wrap items-start gap-2">
      {shown.map((f) => {
        const e = ext(f);
        const url = rawUrl(rawBase, historical ? `~at/${turn.seq}/${f}` : f);
        if (IMAGE_EXT.has(e)) {
          return (
            <button key={f} type="button" title={f} onClick={() => historical ? window.open(rawUrl(rawBase, `~at/${turn.seq}/${f}`), "_blank", "noopener") : openFile(f)} className="group flex max-w-[260px] flex-col gap-1 text-left">
              <img
                src={url}
                alt={f}
                loading="lazy"
                onError={() => hide(f)}
                className={cn("rounded-lg border border-border bg-paper object-cover transition group-hover:shadow-soft", compact ? "h-24" : "h-36", "max-w-full")}
              />
              <span className="truncate font-mono text-micro text-muted-foreground">{baseName(f)}</span>
            </button>
          );
        }
        if (VIDEO_EXT.has(e) || AUDIO_EXT.has(e)) {
          return (
            <div key={f} className="flex max-w-[360px] flex-col gap-1">
              <Player url={url} kind={VIDEO_EXT.has(e) ? "video" : "audio"} title={f} className={VIDEO_EXT.has(e) ? (compact ? "max-h-28" : "max-h-48") : "w-[300px]"} />
              <span className="truncate font-mono text-micro text-muted-foreground">{baseName(f)}</span>
            </div>
          );
        }
        const [, Icon, label] = CARD_KIND.find(([set]) => set.has(e)) ?? CARD_KIND[0]!;
        return (
          <button
            key={f}
            type="button"
            title={f}
            onClick={() => historical ? window.open(rawUrl(rawBase, `~at/${turn.seq}/${f}`), "_blank", "noopener") : openFile(f)}
            className="flex max-w-[260px] items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2 text-left transition hover:border-input hover:bg-accent hover:shadow-soft"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-secondary text-primary">
              <Icon className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block truncate font-mono text-meta text-foreground">{baseName(f)}</span>
              <span className="block text-micro text-muted-foreground">{label} · open</span>
            </span>
          </button>
        );
      })}
      {shown.length < files.length ? (
        <button
          type="button"
          onClick={() => setMore(true)}
          className="flex h-12 items-center rounded-xl border border-dashed border-border px-3 text-meta text-muted-foreground transition hover:border-input hover:bg-accent hover:text-foreground"
        >
          {files.length - shown.length} more
        </button>
      ) : null}
    </div>
  );
}

export function TurnBar({ turn, docs, compact, text }: { turn?: TurnState; docs?: DocRevision[]; compact?: boolean; text?: string }) {
  const [all, setAll] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsId = useId();
  const openChanges = useStore((s) => s.openChanges);
  const openFile = useStore((s) => s.openFile);
  // The chip whose turn and file the panel shows now.
  const shown = useStore((s) => (s.panel === "diff" && s.changes.scope === "turn" && s.changes.turn === turn?.id ? s.changes : null));
  const openDocRevision = useStore((s) => s.openDocRevision);
  const room = useStore((s) => s.snap?.state);
  const docPaths = new Set((docs ?? []).map((r) => r.path));
  const changes = (turn?.changes ?? []).filter((c) => !docPaths.has(c.path));
  const files = turn?.changes?.length ? [] : (turn?.files ?? []).filter((f) => !docPaths.has(f));
  const acts = turn?.activity.length ?? 0;
  if (!acts && !docs?.length && !changes.length && !files.length) return null;
  const total = (docs?.length ?? 0) + changes.length + files.length;
  const cap = compact && !all && total > 4 ? 3 : Infinity;
  const shownDocs = (docs ?? []).slice(0, cap);
  const shownChanges = changes.slice(0, Math.max(0, cap - shownDocs.length));
  const shownFiles = files.slice(0, Math.max(0, cap - shownDocs.length - shownChanges.length));
  const hidden = total - shownDocs.length - shownChanges.length - shownFiles.length;
  return (
    <div className="mt-2.5">
      {turn ? <Made turn={turn} text={text} compact={compact} /> : null}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 first:mt-0">
        {acts && turn ? (
          <Tip tip="Expand what the agent did here; each action opens its input and output">
            <button type="button" className={cn(chip, actionsOpen && "bg-accent text-foreground")} aria-expanded={actionsOpen} aria-controls={actionsId} onClick={() => setActionsOpen(!actionsOpen)}>
              <ListIcon className="size-3.5" />
              {plural(acts, "action", "actions")}
              <ChevronRightIcon className={cn("size-3 transition", actionsOpen && "rotate-90")} />
            </button>
          </Tip>
        ) : null}
        {shownDocs.map((r) => (
          <Tip key={r.seq} tip="Edit to the shared document — show what changed">
            <button type="button" className={cn(chip, "border-primary/25")} onClick={() => openDocRevision(r.seq)}>
              <FileTextIcon className="size-3.5 text-primary" />
              <span className="truncate">{baseName(r.path)}</span>
              <Stats added={r.added} removed={r.removed} deleted={r.deleted} />
            </button>
          </Tip>
        ))}
        {shownChanges.map((c) => {
          const alongside = (c.with ?? []).map((handle) => nameOf(room, handle));
          return (
            <Tip
              key={c.path}
              tip={`What this turn changed in ${c.path}${alongside.length ? ` — ${alongside.join(", ")} also edited this file meanwhile, so the change isn’t only this turn’s` : ""}`}
            >
              <button
                type="button"
                className={cn(chip, shown?.path === c.path && "border-input bg-accent text-foreground")}
                onClick={() => turn && openChanges({ scope: "turn", turn: turn.id, path: c.path })}
              >
                <FilePenLineIcon className="size-3.5" />
                <span className="truncate font-mono text-meta">{baseName(c.path)}</span>
                <Stats added={c.added} removed={c.removed} deleted={c.status === "D"} binary={c.added === null} isNew={c.status === "A"} />
                {alongside.length ? <span className="text-muted-foreground">+ {alongside.join(", ")}</span> : null}
              </button>
            </Tip>
          );
        })}
        {shownFiles.map((f) => (
          <button key={f} type="button" className={chip} title={f} onClick={() => openFile(f)}>
            <NotebookPenIcon className="size-3.5" />
            <span className="truncate font-mono text-meta">{baseName(f)}</span>
          </button>
        ))}
        {hidden > 0 ? (
          <button type="button" className={cn(chip, "text-primary")} onClick={() => setAll(true)}>
            +{plural(hidden, "file", "files")}
          </button>
        ) : null}
      </div>
      {actionsOpen && turn ? <ActivityList id={actionsId} items={turn.activity} turn={turn} className="mt-3" /> : null}
    </div>
  );
}
