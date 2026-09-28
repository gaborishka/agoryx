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
  RotateCcwIcon,
  ShieldAlertIcon,
  SignpostIcon,
  ThumbsUpIcon,
  UndoIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { Markdown, rawUrl } from "@/components/md/Markdown";
import { LiveFrame } from "@/components/md/LiveFrame";
import { ext, FRAME_EXT, IMAGE_EXT, plural, workspaceRel } from "@/lib/format";
import { useStore } from "@/lib/store";
import type { TableOp, TableOption, TableState } from "@/lib/types";
import { cn } from "@/lib/utils";

export const TC_KIND: Record<TableOp["op"], string> = {
  ask: "Питання",
  propose: "Пропозиція",
  object: "Заперечення",
  support: "Підтримка",
  evidence: "Доказ",
  fact: "Факт",
  settle: "Узгоджено",
  next: "Наступний крок",
  done: "Виконано",
  withdraw: "Відкликано",
  decide: "Рішення",
  reopen: "Відкрито знову",
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
  done: CheckIcon,
  withdraw: UndoIcon,
  decide: GavelIcon,
  reopen: RotateCcwIcon,
};

export const KIND_TONE: Record<TableOp["op"], string> = {
  ask: "text-amber",
  propose: "text-primary",
  object: "text-destructive",
  support: "text-add-ink",
  evidence: "text-codex",
  fact: "text-fact",
  settle: "text-primary",
  next: "text-muted-foreground",
  done: "text-add-ink",
  withdraw: "text-muted-foreground",
  decide: "text-primary",
  reopen: "text-amber",
};

export function Kind({ op }: { op: TableOp["op"] }) {
  const Icon = KIND_ICON[op];
  return (
    <span className={cn("inline-flex items-center gap-1 text-[11px] font-semibold tracking-wide uppercase", KIND_TONE[op])}>
      <Icon className="size-3.5" />
      {TC_KIND[op]}
    </span>
  );
}

export function RefChip({ id, className }: { id: string; className?: string }) {
  const goToRef = useStore((s) => s.goToRef);
  return (
    <button
      type="button"
      onClick={() => goToRef(id)}
      title="Показати на столі"
      className={cn(
        "inline-flex h-5 items-center rounded-md bg-secondary px-1.5 font-mono text-[11px] font-semibold text-secondary-foreground ring-1 ring-primary/15 transition hover:bg-primary hover:text-primary-foreground",
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
  const pill = "inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] font-medium";
  if (o.status === "chosen") return <span className={cn(pill, "bg-primary text-primary-foreground")}>Обрано</span>;
  if (o.status === "withdrawn") return <span className={cn(pill, "bg-muted text-muted-foreground")}>Відкликано</span>;
  const q = o.q ? table.questions.find((x) => x.id === o.q) : null;
  if (q?.status === "decided") return <span className={cn(pill, "bg-muted text-muted-foreground")}>Не обрано</span>;
  const { sup, obj, ev } = noteCounts(table, o.id);
  if (!sup && !obj && !ev) return <span className="text-[11px] text-faint">відкрито</span>;
  return (
    <span className="tabular inline-flex items-center gap-2 text-[11.5px] font-medium">
      {sup ? (
        <span className="text-add-ink" title={plural(sup, "підтримка", "підтримки", "підтримок")}>
          ✓ {sup}
        </span>
      ) : null}
      {obj ? (
        <span className="text-destructive" title={plural(obj, "заперечення", "заперечення", "заперечень")}>
          ✕ {obj}
        </span>
      ) : null}
      {ev ? (
        <span className="text-codex" title={plural(ev, "доказ", "докази", "доказів")}>
          ◆ {ev}
        </span>
      ) : null}
    </span>
  );
}

export function FilePreview({ file }: { file: string }) {
  const rawBase = useStore((s) => s.snap?.rawBase);
  const openDialog = useStore((s) => s.openDialog);
  const kind = ext(file);
  if (rawBase && IMAGE_EXT.has(kind)) {
    return (
      <button type="button" className="mt-2 block overflow-hidden rounded-lg border border-border bg-paper" onClick={() => openDialog({ kind: "file", path: file })} title={file}>
        <img src={rawUrl(rawBase, file)} alt={file} loading="lazy" className="max-h-72 max-w-full object-contain" />
      </button>
    );
  }
  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-border bg-paper">
      {rawBase && FRAME_EXT.has(kind) ? <LiveFrame src={rawUrl(rawBase, file)} title={file} initial={280} max={640} /> : null}
      <button type="button" onClick={() => openDialog({ kind: "file", path: file })} className="flex w-full items-center gap-2 border-t border-border px-2.5 py-1.5 text-left text-xs first:border-t-0 hover:bg-accent">
        <FileIcon className="size-3.5 text-muted-foreground" />
        <span className="truncate font-mono">{file}</span>
        <span className="ml-auto text-muted-foreground">переглянути</span>
      </button>
    </div>
  );
}

export function NoteSource({ source }: { source: string }) {
  const workspace = useStore((s) => s.snap?.state.workspace);
  const openDialog = useStore((s) => s.openDialog);
  if (/^https?:\/\//.test(source)) {
    return (
      <a href={source} target="_blank" rel="noopener noreferrer" className="truncate text-xs text-primary underline decoration-primary/30 underline-offset-2">
        {source.replace(/^https?:\/\//, "")}
      </a>
    );
  }
  const rel = workspaceRel(source, workspace);
  if (rel && IMAGE_EXT.has(ext(rel))) return <FilePreview file={rel} />;
  if (rel) {
    return (
      <button type="button" onClick={() => openDialog({ kind: "file", path: rel })} className="truncate font-mono text-xs text-primary hover:underline">
        {rel}
      </button>
    );
  }
  return <span className="text-xs text-muted-foreground">{source}</span>;
}

const card = "rounded-xl border border-border bg-card px-3 py-2.5 shadow-[0_1px_0_rgb(0_0_0/0.02)]";

function Clamp({ children, long }: { children: ReactNode; long: boolean }) {
  const [open, setOpen] = useState(!long);
  return (
    <div className="relative mt-1.5">
      <div className={cn(!open && "max-h-44 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]")}>{children}</div>
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className="mt-1 text-xs font-medium text-primary hover:underline">
          Показати повністю
        </button>
      ) : null}
    </div>
  );
}

function OptionActions({ id }: { id: string }) {
  const openDialog = useStore((s) => s.openDialog);
  const driven = useStore((s) => s.snap?.driven);
  if (!driven) return null;
  const btn = "h-7 rounded-lg px-2.5 text-xs font-medium transition";
  return (
    <div className="mt-2.5 flex flex-wrap gap-1.5">
      <button type="button" className={cn(btn, "text-muted-foreground hover:bg-accent hover:text-foreground")} onClick={() => openDialog({ kind: "table-form", op: "support", target: id })}>
        Підтримати
      </button>
      <button type="button" className={cn(btn, "text-muted-foreground hover:bg-accent hover:text-foreground")} onClick={() => openDialog({ kind: "table-form", op: "object", target: id })}>
        Заперечити
      </button>
      <button type="button" className={cn(btn, "bg-secondary text-secondary-foreground hover:bg-primary hover:text-primary-foreground")} onClick={() => openDialog({ kind: "table-form", op: "decide", target: id })}>
        Обрати
      </button>
    </div>
  );
}

const optionTitle = (table: TableState, id: string) => {
  const o = table.options.find((x) => x.id === id);
  return o ? `«${o.title}»` : "";
};

export function OpCard({ o }: { o: TableOp }) {
  const table = useStore((s) => s.snap?.state.table);
  if (!table) return null;
  switch (o.op) {
    case "propose": {
      const opt: TableOption = table.options.find((x) => x.id === o.id) ?? { id: o.id ?? "?", q: o.q ?? null, title: o.title, body: o.body, file: o.file, by: o.by, seq: 0, status: "open" };
      const q = opt.q ? table.questions.find((x) => x.id === opt.q) : null;
      const open = opt.status === "open" && q?.status !== "decided";
      const long = (opt.body?.length ?? 0) > 600 || /```|!\[/.test(opt.body ?? "");
      return (
        <div className={cn(card, "border-l-[3px] border-l-primary/60", opt.status === "withdrawn" && "opacity-60")}>
          <div className="flex flex-wrap items-center gap-2">
            <Kind op="propose" />
            <RefChip id={opt.id} />
            {q ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                до <RefChip id={q.id} />
              </span>
            ) : null}
            <span className="ml-auto">
              <Standing table={table} o={opt} />
            </span>
          </div>
          <div className="mt-1.5 font-semibold text-pretty">{opt.title}</div>
          {opt.body ? (
            <Clamp long={long}>
              <Markdown text={opt.body} source={`o:${opt.id}`} className="text-[14px]" />
            </Clamp>
          ) : null}
          {opt.file ? <FilePreview file={opt.file} /> : null}
          {open ? <OptionActions id={opt.id} /> : null}
        </div>
      );
    }
    case "ask": {
      const q = table.questions.find((x) => x.id === o.id) ?? { id: o.id ?? "?", text: o.text, status: "open" as const };
      const options = table.options.filter((x) => x.q === q.id);
      const decision = q.status === "decided" ? table.decisions.filter((d) => d.q === q.id).pop() : null;
      return (
        <div className={cn(card, "border-l-[3px] border-l-amber/70")}>
          <div className="flex flex-wrap items-center gap-2">
            <Kind op="ask" />
            <RefChip id={q.id} />
            <span className="ml-auto text-[11.5px] text-muted-foreground">
              {decision ? <span className="font-medium text-primary">Вирішено: {decision.option}</span> : options.length ? plural(options.length, "варіант", "варіанти", "варіантів") : "чекає варіантів"}
            </span>
          </div>
          <div className="mt-1.5 font-semibold text-pretty">{q.text}</div>
          {options.length ? (
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
            <Kind op={o.op} />
            <span className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              до <RefChip id={o.target} /> <span className="truncate">{optionTitle(table, o.target)}</span>
            </span>
          </div>
          <div className="mt-1.5 text-[14px] text-pretty">{o.text}</div>
          {o.source ? (
            <div className="mt-1.5 flex min-w-0">
              <NoteSource source={o.source} />
            </div>
          ) : null}
        </div>
      );
    }
    case "fact":
    case "settle":
    case "next": {
      const list = o.op === "fact" ? table.facts : o.op === "settle" ? table.settled : table.next;
      const done = o.op === "next" && list.find((x) => x.id === o.id)?.done;
      return (
        <div className={cn(card, "flex items-baseline gap-2.5 py-2")}>
          <Kind op={o.op} />
          <span className={cn("min-w-0 flex-1 text-[14px]", done && "text-muted-foreground line-through")}>{o.text}</span>
          {done ? <span className="text-[11px] font-medium text-add-ink">виконано</span> : null}
        </div>
      );
    }
    case "decide":
      return (
        <div className={cn(card, "flex items-baseline gap-2.5 border-primary/30 bg-secondary/60 py-2")}>
          <Kind op="decide" />
          <span className="min-w-0 flex-1 text-[14px]">
            <RefChip id={o.target} /> {optionTitle(table, o.target)}
            {o.note ? <span className="text-muted-foreground"> — {o.note}</span> : null}
          </span>
        </div>
      );
    default: {
      const text =
        o.op === "done"
          ? table.next.find((x) => x.id === o.target)?.text
          : (table.options.find((x) => x.id === o.target)?.title ?? table.questions.find((x) => x.id === o.target)?.text);
      return (
        <div className={cn(card, "flex items-baseline gap-2.5 py-2")}>
          <Kind op={o.op} />
          <span className="min-w-0 flex-1 text-[14px]">
            <RefChip id={o.target} /> {text}
          </span>
        </div>
      );
    }
  }
}

function OptionChip({ o }: { o: TableOption }) {
  const goToRef = useStore((s) => s.goToRef);
  return (
    <button
      type="button"
      onClick={() => goToRef(o.id)}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1 text-left text-xs hover:bg-accent",
        o.status === "chosen" && "border-primary/40 bg-secondary text-secondary-foreground",
        o.status === "withdrawn" && "opacity-55 line-through",
      )}
    >
      <b className="font-mono text-[11px]">{o.id}</b>
      <span className="truncate">{o.title}</span>
    </button>
  );
}

// A turn that makes many moves keeps the ones a reader must see and folds the rest into one line.
const KEY_OPS = new Set<TableOp["op"]>(["ask", "propose", "object", "decide"]);
const FOLD_AFTER = 4;
const TC_MANY: Record<TableOp["op"], [string, string, string]> = {
  ask: ["питання", "питання", "питань"],
  propose: ["пропозиція", "пропозиції", "пропозицій"],
  object: ["заперечення", "заперечення", "заперечень"],
  decide: ["рішення", "рішення", "рішень"],
  support: ["підтримка", "підтримки", "підтримок"],
  evidence: ["доказ", "докази", "доказів"],
  fact: ["факт", "факти", "фактів"],
  settle: ["узгоджене", "узгоджені", "узгоджених"],
  next: ["крок", "кроки", "кроків"],
  done: ["виконано", "виконано", "виконано"],
  withdraw: ["відкликано", "відкликано", "відкликано"],
  reopen: ["відкрито знову", "відкрито знову", "відкрито знову"],
};

/** A turn's table moves in one line: what kinds, how many, and a way to open them. */
function OpSummary({ ops, onOpen }: { ops: TableOp[]; onOpen: () => void }) {
  const setView = useStore((s) => s.setView);
  const counts = new Map<TableOp["op"], number>();
  for (const o of ops) counts.set(o.op, (counts.get(o.op) ?? 0) + 1);
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5 rounded-xl border border-border bg-muted/50 px-2.5 py-2 text-[12.5px]">
      <span className="font-medium text-muted-foreground">На столі:</span>
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
          показати
        </button>
        <button type="button" onClick={() => setView("table")} className="rounded-md px-1.5 py-0.5 font-medium text-primary hover:bg-accent">
          на Столі →
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
          Ще {summary} · <span className="text-primary">показати</span>
        </button>
      ) : foldable && all ? (
        <button type="button" onClick={() => setAll(false)} className="self-start rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
          Згорнути дрібні ходи
        </button>
      ) : null}
    </div>
  );
}
