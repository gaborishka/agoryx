import {
  AlertTriangleIcon,
  AppWindowIcon,
  BanIcon,
  BrainIcon,
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
import { useState } from "react";
import { rawUrl } from "@/components/md/Markdown";
import { Player } from "@/components/md/Media";
import { AUDIO_EXT, baseName, DIAGRAM_EXT, ext, IMAGE_EXT, plural, TABLE_EXT, VIDEO_EXT, VISUAL_EXT } from "@/lib/format";
import { nameOf } from "@/lib/room";
import { useStore } from "@/lib/store";
import type { Activity, DocRevision, TurnState } from "@/lib/types";
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

export function ActivityRow({ a }: { a: Activity }) {
  const Icon = ICON[a.kind] ?? DotIcon;
  const fail = a.status === "fail" || a.kind === "error";
  const wrap = WRAP.has(a.kind);
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
        <span
          className={cn(
            "block text-small leading-6 text-muted-foreground",
            wrap ? "whitespace-pre-wrap break-words" : "truncate font-mono text-meta",
            a.kind === "thinking" && "italic",
            fail && "text-destructive",
          )}
          title={a.label}
        >
          {label}
        </span>
        {a.detail && fail ? <span className="mt-0.5 block whitespace-pre-wrap break-words font-mono text-meta text-destructive/80">{a.detail.slice(0, 500)}</span> : null}
      </span>
    </li>
  );
}

export function ActivityList({ items, className }: { items: Activity[]; className?: string }) {
  return (
    <ol className={cn("relative before:absolute before:top-2 before:bottom-3 before:left-[9.5px] before:w-px before:bg-border", className)}>
      {items.map((a) => (
        <ActivityRow key={a.id} a={a} />
      ))}
    </ol>
  );
}

const chip =
  "inline-flex h-7 max-w-full items-center gap-1.5 rounded-lg border border-border bg-card px-2 text-xs text-muted-foreground transition hover:border-input hover:bg-accent hover:text-foreground";

const CARD_KIND: Array<[Set<string>, LucideIcon, string]> = [
  [TABLE_EXT, Table2Icon, "Таблиця"],
  [DIAGRAM_EXT, NetworkIcon, "Діаграма"],
  [new Set(["pdf"]), FileTextIcon, "PDF"],
  [new Set(["html", "htm"]), AppWindowIcon, "Сторінка"],
];

/**
 * What a turn made that is worth seeing — a plot, a page, a clip — shown right away,
 * unless the message already embeds or links it.
 */
function Made({ turn, text, compact }: { turn: TurnState; text?: string; compact?: boolean }) {
  const rawBase = useStore((s) => s.snap?.rawBase);
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
        const url = rawUrl(rawBase, f);
        if (IMAGE_EXT.has(e)) {
          return (
            <button key={f} type="button" title={f} onClick={() => openFile(f)} className="group flex max-w-[260px] flex-col gap-1 text-left">
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
            onClick={() => openFile(f)}
            className="flex max-w-[260px] items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2 text-left transition hover:border-input hover:bg-accent hover:shadow-soft"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-secondary text-primary">
              <Icon className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block truncate font-mono text-meta text-foreground">{baseName(f)}</span>
              <span className="block text-micro text-muted-foreground">{label} · відкрити</span>
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
          ще {files.length - shown.length}
        </button>
      ) : null}
    </div>
  );
}

export function TurnBar({ turn, docs, compact, text }: { turn?: TurnState; docs?: DocRevision[]; compact?: boolean; text?: string }) {
  const [all, setAll] = useState(false);
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
          <Tip tip="Що агент робив цей хід — у панелі «Зміни»">
            <button type="button" className={cn(chip, shown?.acts && "bg-accent text-foreground")} onClick={() => openChanges({ scope: "turn", turn: turn.id, acts: true })}>
              <ListIcon className="size-3.5" />
              {plural(acts, "дія", "дії", "дій")}
            </button>
          </Tip>
        ) : null}
        {shownDocs.map((r) => (
          <Tip key={r.seq} tip="Правка спільного документа — показати, що змінилося">
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
              tip={`Що саме цей хід змінив у ${c.path}${alongside.length ? ` — тим часом цей файл редагували й інші: ${alongside.join(", ")}, тож зміна не лише цього ходу` : ""}`}
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
            +{plural(hidden, "файл", "файли", "файлів")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
