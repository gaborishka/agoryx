import {
  BadgeCheckIcon,
  CheckIcon,
  CircleHelpIcon,
  FileIcon,
  FlagIcon,
  GavelIcon,
  LightbulbIcon,
  type LucideIcon,
  MicroscopeIcon,
  PencilIcon,
  RefreshCcwIcon,
  RotateCcwIcon,
  ScanEyeIcon,
  ShieldAlertIcon,
  SignpostIcon,
  ThumbsUpIcon,
  Trash2Icon,
  UndoIcon,
} from "lucide-react";
import { useState } from "react";
import { Clamp } from "@/components/common/Clamp";
import { Avatar, Name } from "@/components/room/bits";
import { Markdown, rawUrl } from "@/components/md/Markdown";
import { LiveFrame } from "@/components/md/LiveFrame";
import { ext, FRAME_EXT, IMAGE_EXT, plural, workspaceRel } from "@/lib/format";
import { useStore } from "@/lib/store";
import type { TableNote, TableOp, TableOption, TableState } from "@/lib/types";
import { cn } from "@/lib/utils";

export const TC_KIND: Record<TableOp["op"], string> = {
  ask: "Question",
  propose: "Proposal",
  object: "Objection",
  support: "Endorsement",
  evidence: "Evidence",
  fact: "Fact",
  settle: "Settled",
  next: "Next step",
  review: "Check asked for",
  done: "Done",
  withdraw: "Withdrawn",
  decide: "Decision",
  reopen: "Reopened",
  concede: "Changes their mind",
  edit: "Rewritten",
  delete: "Deleted",
};

export const KIND_ICON: Record<TableOp["op"], LucideIcon> = {
  ask: CircleHelpIcon,
  propose: LightbulbIcon,
  object: ShieldAlertIcon,
  support: ThumbsUpIcon,
  evidence: MicroscopeIcon,
  fact: FlagIcon,
  settle: BadgeCheckIcon,
  next: SignpostIcon,
  review: ScanEyeIcon,
  done: CheckIcon,
  withdraw: UndoIcon,
  decide: GavelIcon,
  reopen: RotateCcwIcon,
  concede: RefreshCcwIcon,
  edit: PencilIcon,
  delete: Trash2Icon,
};

export const KIND_TONE: Record<TableOp["op"], string> = {
  ask: "text-amber",
  propose: "text-primary",
  object: "text-destructive",
  support: "text-add-ink",
  evidence: "text-codex",
  fact: "text-fact",
  settle: "text-meet-ink",
  next: "text-muted-foreground",
  review: "text-codex",
  done: "text-add-ink",
  withdraw: "text-muted-foreground",
  decide: "text-meet-ink",
  reopen: "text-amber",
  concede: "text-shift",
  edit: "text-muted-foreground",
  delete: "text-muted-foreground",
};

export function Kind({ op, label }: { op: TableOp["op"]; label?: string }) {
  const Icon = KIND_ICON[op];
  return (
    <span className={cn("inline-flex items-center gap-1 text-micro font-semibold", KIND_TONE[op])}>
      <Icon className="size-3.5" />
      {label ?? TC_KIND[op]}
    </span>
  );
}

export function RefChip({ id, className }: { id: string; className?: string }) {
  const goToRef = useStore((s) => s.goToRef);
  return (
    <button
      type="button"
      onClick={() => goToRef(id)}
      title="Show on the table"
      className={cn(
        "inline-flex h-5 items-center rounded-md bg-secondary px-1.5 font-mono text-micro font-semibold text-secondary-foreground ring-1 ring-primary/15 transition hover:bg-primary hover:text-primary-foreground",
        className,
      )}
    >
      {id}
    </button>
  );
}

export const noteCounts = (table: TableState, id: string) => {
  const notes = table.notes.filter((n) => n.target === id);
  return {
    sup: notes.filter((n) => n.kind === "support").length,
    obj: notes.filter((n) => n.kind === "object").length,
    ev: notes.filter((n) => n.kind === "evidence").length,
  };
};

export function Standing({ table, o }: { table: TableState; o: TableOption }) {
  const pill = "inline-flex h-5 items-center gap-1 rounded-full px-2 text-micro font-medium";
  if (o.status === "chosen") return <span className={cn(pill, "bg-meet text-background")}>Chosen</span>;
  if (o.status === "withdrawn") return <span className={cn(pill, "bg-muted text-muted-foreground")}>Withdrawn</span>;
  const q = o.q ? table.questions.find((x) => x.id === o.q) : null;
  if (q && q.status !== "open") return <span className={cn(pill, "bg-muted text-muted-foreground")}>{q.status === "decided" ? "Not chosen" : "Question closed"}</span>;
  const { sup, obj, ev } = noteCounts(table, o.id);
  if (!sup && !obj && !ev) return <span className="text-micro text-faint">open</span>;
  return (
    <span className="tabular inline-flex items-center gap-2 text-meta font-medium">
      {sup ? (
        <span className="text-add-ink" title={plural(sup, "endorsement", "endorsements")}>
          ✓ {sup}
        </span>
      ) : null}
      {obj ? (
        <span className="text-destructive" title={plural(obj, "objection", "objections")}>
          ✕ {obj}
        </span>
      ) : null}
      {ev ? (
        <span className="text-codex" title={plural(ev, "piece of evidence", "pieces of evidence")}>
          ◆ {ev}
        </span>
      ) : null}
    </span>
  );
}

export function FilePreview({ file }: { file: string }) {
  const rawBase = useStore((s) => s.snap?.rawBase);
  const openFile = useStore((s) => s.openFile);
  const kind = ext(file);
  if (rawBase && IMAGE_EXT.has(kind)) {
    return (
      <button type="button" className="mt-2 block overflow-hidden rounded-lg border border-border bg-paper" onClick={() => openFile(file)} title={file}>
        <img src={rawUrl(rawBase, file)} alt={file} loading="lazy" className="max-h-72 max-w-full object-contain" />
      </button>
    );
  }
  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-border bg-paper">
      {rawBase && FRAME_EXT.has(kind) ? <LiveFrame src={rawUrl(rawBase, file)} title={file} initial={280} max={640} /> : null}
      <button type="button" onClick={() => openFile(file)} className="flex w-full items-center gap-2 border-t border-border px-2.5 py-1.5 text-left text-xs first:border-t-0 hover:bg-accent">
        <FileIcon className="size-3.5 text-muted-foreground" />
        <span className="truncate font-mono">{file}</span>
        <span className="ml-auto text-muted-foreground">view</span>
      </button>
    </div>
  );
}

/** An argument on the table: who made it, where it comes from, what it says. */
export function NoteItem({ n }: { n: TableNote }) {
  return (
    <div id={`ti-${n.id}`} className="scroll-mt-24 rounded-xl bg-card px-3 py-2 ring-1 ring-border/60">
      <div className="mb-0.5 flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
        <Avatar handle={n.by} size={16} />
        <Name handle={n.by} className="font-medium" />
        {n.source ? <NoteSource source={n.source} /> : null}
      </div>
      <Clamp max={120} more="More">
        <Markdown text={n.text} className="text-ui text-foreground" />
      </Clamp>
    </div>
  );
}

export function NoteSource({ source }: { source: string }) {
  const workspace = useStore((s) => s.snap?.state.workspace);
  const openFile = useStore((s) => s.openFile);
  if (/^https?:\/\//.test(source)) {
    return (
      <a href={source} target="_blank" rel="noopener noreferrer" className="truncate text-xs text-primary underline decoration-primary/30 underline-offset-2">
        {source.replace(/^https?:\/\//, "")}
      </a>
    );
  }
  const rel = workspaceRel(source.split(/[?#]/)[0], workspace);
  if (rel && IMAGE_EXT.has(ext(rel))) return <FilePreview file={rel} />;
  if (rel) {
    return (
      <button type="button" onClick={() => openFile(rel)} className="truncate font-mono text-xs text-primary hover:underline">
        {rel}
      </button>
    );
  }
  return <span className="text-xs text-muted-foreground">{source}</span>;
}

const card = "rounded-xl border border-border bg-card px-3 py-2.5 shadow-edge";

function OptionActions({ id }: { id: string }) {
  const openDialog = useStore((s) => s.openDialog);
  const driven = useStore((s) => s.snap?.driven);
  if (!driven) return null;
  const btn = "h-7 rounded-lg px-2.5 text-xs font-medium transition";
  return (
    <div className="mt-2.5 flex flex-wrap gap-1.5">
      <button type="button" className={cn(btn, "text-muted-foreground hover:bg-accent hover:text-foreground")} onClick={() => openDialog({ kind: "table-form", op: "support", target: id })}>
        Endorse
      </button>
      <button type="button" className={cn(btn, "text-muted-foreground hover:bg-accent hover:text-foreground")} onClick={() => openDialog({ kind: "table-form", op: "object", target: id })}>
        Object
      </button>
      <button type="button" className={cn(btn, "bg-secondary text-secondary-foreground hover:bg-primary hover:text-primary-foreground")} onClick={() => openDialog({ kind: "table-form", op: "decide", target: id })}>
        Choose
      </button>
    </div>
  );
}

const optionTitle = (table: TableState, id: string) => {
  const o = table.options.find((x) => x.id === id);
  if (o) return `“${o.title}”`;
  const step = table.next.find((x) => x.id === id);
  return step ? `“${step.text}”` : "";
};

export function OpCard({ o }: { o: TableOp }) {
  const table = useStore((s) => s.snap?.state.table);
  if (!table) return null;
  switch (o.op) {
    case "propose": {
      const found = table.options.find((x) => x.id === o.id);
      const opt: TableOption = found ?? { id: o.id ?? "?", q: o.q ?? null, title: o.title, body: o.body, file: o.file, by: o.by, seq: 0, status: "open" };
      const q = opt.q ? table.questions.find((x) => x.id === opt.q) : null;
      // Deleted since: the card keeps what was proposed, struck out, with nothing left to act on.
      const gone = !found;
      const open = !gone && opt.status === "open" && (!q || q.status === "open");
      return (
        <div className={cn(card, "border-l-[3px] border-l-primary/60", (opt.status === "withdrawn" || gone) && "opacity-60")}>
          <div className="flex flex-wrap items-center gap-2">
            <Kind op="propose" />
            <RefChip id={opt.id} />
            {q ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                to <RefChip id={q.id} />
              </span>
            ) : null}
            <span className="ml-auto">{gone ? <span className="text-micro font-medium text-muted-foreground">deleted</span> : <Standing table={table} o={opt} />}</span>
          </div>
          <div className={cn("mt-1.5 font-semibold text-pretty", gone && "line-through")}>{opt.title}</div>
          {opt.body ? (
            <Clamp max={176} more="Show all" className="mt-1.5">
              <Markdown text={opt.body} source={`o:${opt.id}`} className="text-ui" />
            </Clamp>
          ) : null}
          {opt.file ? <FilePreview file={opt.file} /> : null}
          {open ? <OptionActions id={opt.id} /> : null}
        </div>
      );
    }
    case "ask": {
      const found = table.questions.find((x) => x.id === o.id);
      const q = found ?? { id: o.id ?? "?", text: o.text, status: "open" as const };
      const options = table.options.filter((x) => x.q === q.id);
      const decision = q.status === "decided" ? table.decisions.filter((d) => d.q === q.id).pop() : null;
      const answer = q.status === "answered" && "answer" in q ? q.answer : undefined;
      return (
        <div className={cn(card, "border-l-[3px] border-l-amber/70")}>
          <div className="flex flex-wrap items-center gap-2">
            <Kind op="ask" />
            <RefChip id={q.id} />
            <span className="ml-auto text-meta text-muted-foreground">
              {!found ? (
                "deleted"
              ) : decision ? (
                <span className="font-medium text-meet-ink">Decided: {decision.option}</span>
              ) : answer ? (
                <span className="font-medium text-primary">Answered: {answer}</span>
              ) : options.length ? plural(options.length, "option", "options") : "waiting for options"}
            </span>
          </div>
          <div className={cn("mt-1.5 font-semibold text-pretty", !found && "text-muted-foreground line-through")}>{q.text}</div>
          {found && options.length ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {options.map((x) => (
                <OptionChip key={x.id} o={x} />
              ))}
            </div>
          ) : null}
        </div>
      );
    }
    case "object":
    case "support":
    case "evidence": {
      const tone = o.op === "object" ? "border-l-destructive/60" : o.op === "support" ? "border-l-add-ink/50" : "border-l-codex/60";
      return (
        <div className={cn(card, "border-l-[3px]", tone)}>
          <div className="flex flex-wrap items-center gap-2">
            {/* An objection to a step is what its check found. */}
            <Kind op={o.op} label={o.op === "object" && o.target.startsWith("X") ? "Finding" : undefined} />
            <span className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              on <RefChip id={o.target} /> <span className="truncate">{optionTitle(table, o.target)}</span>
            </span>
          </div>
          <div className="mt-1.5 text-ui text-pretty">{o.text}</div>
          {o.source ? (
            <div className="mt-1.5 flex min-w-0">
              <NoteSource source={o.source} />
            </div>
          ) : null}
        </div>
      );
    }
    case "concede":
      return (
        <div className={cn(card, "border-l-[3px] border-l-shift/70 bg-shift-soft/40")}>
          <div className="flex flex-wrap items-center gap-2">
            <Kind op="concede" />
            {o.target ? (
              <span className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                on <RefChip id={o.target} /> <span className="truncate">{optionTitle(table, o.target)}</span>
              </span>
            ) : null}
          </div>
          <div className="mt-1.5 text-ui text-pretty">{o.text}</div>
        </div>
      );
    case "settle":
      if (o.q) {
        return (
          <div className={cn(card, "border-l-[3px] border-l-primary/60")}>
            <div className="flex flex-wrap items-center gap-2">
              <Kind op="settle" />
              <span className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                {table.questions.find((x) => x.id === o.q)?.many ? "recommendation for" : "answer to"} <RefChip id={o.q} /> <span className="truncate">{table.questions.find((x) => x.id === o.q)?.text}</span>
              </span>
            </div>
            <div className="mt-1.5 text-ui font-medium text-pretty">{o.text}</div>
          </div>
        );
      }
      return <ItemCard o={o} table={table} />;
    case "fact":
    case "next":
      return <ItemCard o={o} table={table} />;
    case "decide":
      return (
        <div className={cn(card, "flex items-baseline gap-2.5 border-primary/30 bg-secondary/60 py-2")}>
          <Kind op="decide" />
          <span className="min-w-0 flex-1 text-ui">
            <RefChip id={o.target} /> {optionTitle(table, o.target)}
            {o.note ? <span className="text-muted-foreground"> — {o.note}</span> : null}
          </span>
        </div>
      );
    case "edit": {
      const changed = [
        o.many !== undefined ? (o.many ? "any number of options can be chosen" : "one option is chosen") : "",
        o.q ? `moved to ${o.q}` : "",
        o.body !== undefined ? "new description" : "",
        o.file !== undefined ? (o.file ? `preview ${o.file}` : "no preview") : "",
      ].filter(Boolean);
      return (
        <div className={cn(card, "flex items-baseline gap-2.5 py-2")}>
          <Kind op="edit" />
          <span className="min-w-0 flex-1 text-ui">
            <RefChip id={o.target} /> {o.title ?? o.text ?? ""}
            {changed.length ? <span className="text-muted-foreground"> — {changed.join(", ")}</span> : null}
          </span>
        </div>
      );
    }
    case "delete":
      return (
        <div className={cn(card, "flex items-baseline gap-2.5 py-2")}>
          <Kind op="delete" />
          <span className="min-w-0 flex-1 text-ui text-muted-foreground">
            <span className="font-mono text-micro font-semibold">{o.target}</span> <span className="line-through">{o.was}</span>
          </span>
        </div>
      );
    default: {
      const text =
        o.op === "done" || o.op === "review"
          ? table.next.find((x) => x.id === o.target)?.text
          : (table.options.find((x) => x.id === o.target)?.title ?? table.questions.find((x) => x.id === o.target)?.text ?? table.facts.find((x) => x.id === o.target)?.text ?? table.settled.find((x) => x.id === o.target)?.text);
      return (
        <div className={cn(card, "flex items-baseline gap-2.5 py-2")}>
          <Kind op={o.op} />
          <span className="min-w-0 flex-1 text-ui">
            <RefChip id={o.target} /> {text}
          </span>
        </div>
      );
    }
  }
}

function ItemCard({ o, table }: { o: Extract<TableOp, { op: "fact" | "settle" | "next" }>; table: TableState }) {
  const list = o.op === "fact" ? table.facts : o.op === "settle" ? table.settled : table.next;
  const done = o.op === "next" && list.find((x) => x.id === o.id)?.done;
  const withdrawn = o.op === "fact" && list.find((x) => x.id === o.id)?.withdrawn;
  return (
    <div className={cn(card, "flex items-baseline gap-2.5 py-2")}>
      <Kind op={o.op} />
      <span className={cn("min-w-0 flex-1 text-ui", (done || withdrawn) && "text-muted-foreground line-through")}>{o.text}</span>
      {o.op === "next" && o.target ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-micro text-muted-foreground">
          on <RefChip id={o.target} />
        </span>
      ) : null}
      {done ? <span className="text-micro font-medium text-add-ink">done</span> : null}
      {withdrawn ? <span className="text-micro font-medium text-muted-foreground">withdrawn</span> : null}
    </div>
  );
}

function OptionChip({ o }: { o: TableOption }) {
  const goToRef = useStore((s) => s.goToRef);
  return (
    <button
      type="button"
      onClick={() => goToRef(o.id)}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1 text-left text-xs hover:bg-accent",
        o.status === "chosen" && "border-meet/35 bg-meet-soft text-foreground",
        o.status === "withdrawn" && "opacity-55 line-through",
      )}
    >
      <b className="font-mono text-micro">{o.id}</b>
      <span className="truncate">{o.title}</span>
    </button>
  );
}

// A turn that makes many moves keeps the ones a reader must see and folds the rest into one line.
const KEY_OPS = new Set<TableOp["op"]>(["ask", "propose", "object", "decide", "concede"]);
const FOLD_AFTER = 4;
const TC_MANY: Record<TableOp["op"], [string, string]> = {
  ask: ["question", "questions"],
  propose: ["proposal", "proposals"],
  object: ["objection", "objections"],
  decide: ["decision", "decisions"],
  support: ["endorsement", "endorsements"],
  evidence: ["piece of evidence", "pieces of evidence"],
  fact: ["fact", "facts"],
  settle: ["settled point", "settled points"],
  next: ["step", "steps"],
  review: ["check asked for", "checks asked for"],
  done: ["done", "done"],
  withdraw: ["withdrawn", "withdrawn"],
  reopen: ["reopened", "reopened"],
  concede: ["change of mind", "changes of mind"],
  edit: ["rewritten", "rewritten"],
  delete: ["deleted", "deleted"],
};

/** A turn's table moves in one line: what kinds, how many, and a way to open them. */
function OpSummary({ ops, onOpen }: { ops: TableOp[]; onOpen: () => void }) {
  const setView = useStore((s) => s.setView);
  const counts = new Map<TableOp["op"], number>();
  for (const o of ops) counts.set(o.op, (counts.get(o.op) ?? 0) + 1);
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5 rounded-xl border border-border bg-muted/50 px-2.5 py-2 text-small">
      <span className="font-medium text-muted-foreground">On the table:</span>
      {[...counts].map(([op, n]) => {
        const Icon = KIND_ICON[op];
        return (
          <span key={op} className={cn("inline-flex items-center gap-1 font-medium", KIND_TONE[op])}>
            <Icon className="size-3.5" />
            {plural(n, ...TC_MANY[op])}
          </span>
        );
      })}
      <span className="ml-auto flex items-center gap-1">
        <button type="button" onClick={onOpen} className="rounded-md px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
          show
        </button>
        <button type="button" onClick={() => setView("table")} className="rounded-md px-1.5 py-0.5 font-medium text-primary hover:bg-accent">
          Go to table
        </button>
      </span>
    </div>
  );
}

export function OpCards({ ops, compact }: { ops?: TableOp[]; compact?: boolean }) {
  const [all, setAll] = useState(false);
  if (!ops?.length) return null;
  if (compact && !all) return <OpSummary ops={ops} onOpen={() => setAll(true)} />;
  const foldable = ops.length > FOLD_AFTER;
  const shown = foldable && !all ? ops.filter((o) => KEY_OPS.has(o.op)) : ops;
  const folded = foldable && !all ? ops.filter((o) => !KEY_OPS.has(o.op)) : [];
  const counts = new Map<TableOp["op"], number>();
  for (const o of folded) counts.set(o.op, (counts.get(o.op) ?? 0) + 1);
  const summary = [...counts].map(([op, n]) => plural(n, ...TC_MANY[op])).join(", ");
  return (
    <div className="mt-2.5 flex flex-col gap-2">
      {shown.map((o, i) => (
        <OpCard key={`${o.id ?? o.op}-${i}`} o={o} />
      ))}
      {folded.length ? (
        <button type="button" onClick={() => setAll(true)} className="self-start rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
          Also {summary} · <span className="text-primary">show</span>
        </button>
      ) : foldable && all ? (
        <button type="button" onClick={() => setAll(false)} className="self-start rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
          Collapse minor moves
        </button>
      ) : null}
    </div>
  );
}
