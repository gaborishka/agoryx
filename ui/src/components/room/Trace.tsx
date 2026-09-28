import {
  AlertTriangleIcon,
  BanIcon,
  BrainIcon,
  ChevronRightIcon,
  DotIcon,
  FileTextIcon,
  FilePenLineIcon,
  FileSearchIcon,
  GlobeIcon,
  type LucideIcon,
  NotebookPenIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { baseName, plural } from "@/lib/format";
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
            "block text-[13px] leading-6 text-muted-foreground",
            wrap ? "whitespace-pre-wrap break-words" : "truncate font-mono text-[12px]",
            a.kind === "thinking" && "italic",
            fail && "text-destructive",
          )}
          title={a.label}
        >
          {label}
        </span>
        {a.detail && fail ? <span className="mt-0.5 block whitespace-pre-wrap break-words font-mono text-[11.5px] text-destructive/80">{a.detail.slice(0, 500)}</span> : null}
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

export function TurnBar({ turn, docs }: { turn?: TurnState; docs?: DocRevision[] }) {
  const [open, setOpen] = useState(false);
  const openDialog = useStore((s) => s.openDialog);
  const openDocRevision = useStore((s) => s.openDocRevision);
  const docPaths = new Set((docs ?? []).map((r) => r.path));
  const changes = (turn?.changes ?? []).filter((c) => !docPaths.has(c.path));
  const files = turn?.changes?.length ? [] : (turn?.files ?? []).filter((f) => !docPaths.has(f));
  const acts = turn?.activity.length ?? 0;
  if (!acts && !docs?.length && !changes.length && !files.length) return null;
  return (
    <div className="mt-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {acts ? (
          <button type="button" className={cn(chip, open && "bg-accent text-foreground")} onClick={() => setOpen(!open)} aria-expanded={open}>
            <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
            {plural(acts, "дія", "дії", "дій")}
          </button>
        ) : null}
        {docs?.map((r) => (
          <Tip key={r.seq} tip="Правка спільного документа — показати, що змінилося">
            <button type="button" className={cn(chip, "border-primary/25")} onClick={() => openDocRevision(r.seq)}>
              <FileTextIcon className="size-3.5 text-primary" />
              <span className="truncate">{baseName(r.path)}</span>
              <Stats added={r.added} removed={r.removed} deleted={r.deleted} />
            </button>
          </Tip>
        ))}
        {changes.map((c) => (
          <Tip key={c.path} tip={`Що саме цей хід змінив у ${c.path}`}>
            <button type="button" className={chip} onClick={() => turn && openDialog({ kind: "turn-diff", turnId: turn.id, path: c.path })}>
              <FilePenLineIcon className="size-3.5" />
              <span className="truncate font-mono text-[11.5px]">{baseName(c.path)}</span>
              <Stats added={c.added} removed={c.removed} deleted={c.status === "D"} binary={c.added === null} isNew={c.status === "A"} />
            </button>
          </Tip>
        ))}
        {files.map((f) => (
          <button key={f} type="button" className={chip} title={f} onClick={() => openDialog({ kind: "file", path: f })}>
            <NotebookPenIcon className="size-3.5" />
            <span className="truncate font-mono text-[11.5px]">{baseName(f)}</span>
          </button>
        ))}
      </div>
      <AnimatePresence initial={false}>
        {open && turn ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
            className="overflow-hidden"
          >
            <ActivityList items={turn.activity} className="mt-2.5 rounded-xl border border-border bg-muted/40 px-3 pt-2.5 pb-1" />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
