import {
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleHelpIcon,
  FootprintsIcon,
  GavelIcon,
  LightbulbIcon,
  MicroscopeIcon,
  PinIcon,
  PlusIcon,
  ScaleIcon,
  ShieldAlertIcon,
  ThumbsUpIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Avatar, Name, Tip } from "@/components/room/bits";
import { Clamp } from "@/components/room/Clamp";
import { Markdown } from "@/components/md/Markdown";
import { Button } from "@/components/ui/button";
import { plural } from "@/lib/format";
import { participant, refAnchor } from "@/lib/room";
import { type TableFormOp, useStore } from "@/lib/store";
import type { RoomState, TableNote, TableOption, TableQuestion, TableState } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FilePreview, NoteSource, noteCounts, RefChip } from "./OpCard";

const NOTE: Record<TableNote["kind"], { label: string; cls: string; mark: string; Icon: typeof CheckIcon }> = {
  object: { label: "Заперечення", cls: "border-l-destructive/60 bg-destructive-soft/60", mark: "text-destructive", Icon: ShieldAlertIcon },
  support: { label: "Підтримка", cls: "border-l-add-ink/50 bg-add/50", mark: "text-add-ink", Icon: ThumbsUpIcon },
  evidence: { label: "Доказ", cls: "border-l-codex/50 bg-codex-soft/70", mark: "text-codex", Icon: MicroscopeIcon },
};
const ORDER = { object: 0, evidence: 1, support: 2 } as const;
const band = { claude: "before:bg-claude", codex: "before:bg-codex", human: "before:bg-human", sys: "before:bg-border" } as const;

/** Where an option stands, in one word a reader can act on. */
function verdict(table: TableState, o: TableOption, decided: boolean) {
  if (o.status === "chosen") return { label: "Обрано", cls: "bg-primary text-primary-foreground" };
  if (o.status === "withdrawn") return { label: "Відкликано", cls: "bg-muted text-muted-foreground" };
  if (decided) return { label: "Не обрано", cls: "bg-muted text-muted-foreground" };
  const { sup, obj } = noteCounts(table, o.id);
  if (sup && obj) return { label: "Суперечка", cls: "bg-amber-soft text-amber" };
  if (obj) return { label: "Оскаржено", cls: "bg-destructive-soft text-destructive" };
  if (sup) return { label: "Підтримано", cls: "bg-add text-add-ink" };
  return { label: "Без відгуків", cls: "bg-muted text-muted-foreground" };
}

type Stance = "author" | "for" | "against" | "split" | "evidence";
const STANCE: Record<Stance, { word: string; cls: string }> = {
  author: { word: "пропонує", cls: "text-muted-foreground" },
  for: { word: "за", cls: "text-add-ink" },
  against: { word: "проти", cls: "text-destructive" },
  split: { word: "за і проти", cls: "text-amber" },
  evidence: { word: "доказ", cls: "text-codex" },
};

/** Each participant's position on an option: the edges between agents, made visible. */
function stances(table: TableState, o: TableOption) {
  const by = new Map<string, Set<TableNote["kind"]>>();
  for (const n of table.notes) {
    if (n.target !== o.id) continue;
    const set = by.get(n.by) ?? new Set();
    set.add(n.kind);
    by.set(n.by, set);
  }
  const out: Array<[string, Stance]> = [[o.by, "author"]];
  for (const [who, kinds] of by) {
    if (who === o.by && !kinds.has("object")) continue;
    const s: Stance = kinds.has("support") && kinds.has("object") ? "split" : kinds.has("object") ? "against" : kinds.has("support") ? "for" : "evidence";
    if (who === o.by) out[0] = [who, s];
    else out.push([who, s]);
  }
  return out;
}

function Meter({ table, o }: { table: TableState; o: TableOption }) {
  const { sup, obj, ev } = noteCounts(table, o.id);
  const total = sup + obj + ev;
  if (!total) return <div className="h-1.5 rounded-full bg-muted" />;
  return (
    <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full">
      {sup ? <span className="bg-add-ink/80" style={{ flexGrow: sup }} /> : null}
      {ev ? <span className="bg-codex/80" style={{ flexGrow: ev }} /> : null}
      {obj ? <span className="bg-destructive/80" style={{ flexGrow: obj }} /> : null}
    </div>
  );
}

function Note({ n }: { n: TableNote }) {
  const k = NOTE[n.kind];
  return (
    <div id={`ti-${n.id}`} className={cn("scroll-mt-24 rounded-lg border-l-2 px-2.5 py-2", k.cls)}>
      <div className="mb-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <k.Icon className={cn("size-3.5", k.mark)} />
        <span className={cn("font-semibold", k.mark)}>{k.label}</span>
        <span>·</span>
        <Name handle={n.by} className="font-medium" />
        {n.source ? <NoteSource source={n.source} /> : null}
      </div>
      <Clamp max={132} fade="from-transparent" more="Далі">
        <Markdown text={n.text} className="text-[13.5px]" />
      </Clamp>
    </div>
  );
}

function Notes({ notes }: { notes: TableNote[] }) {
  const [all, setAll] = useState(false);
  if (!notes.length) return null;
  const shown = all ? notes : notes.slice(0, 2);
  return (
    <div className="flex flex-col gap-1.5">
      {shown.map((n) => (
        <Note key={n.id} n={n} />
      ))}
      {notes.length > 2 ? (
        <button type="button" onClick={() => setAll(!all)} className="self-start rounded-md px-1.5 py-1 text-[12.5px] font-medium text-primary hover:bg-accent">
          {all ? "Згорнути аргументи" : `Ще ${plural(notes.length - 2, "аргумент", "аргументи", "аргументів")}`}
        </button>
      ) : null}
    </div>
  );
}

function Actions({ id }: { id: string }) {
  const openDialog = useStore((s) => s.openDialog);
  const driven = useStore((s) => s.snap?.driven);
  if (!driven) return null;
  const form = (op: TableFormOp) => () => openDialog({ kind: "table-form", op, target: id });
  const icon = "size-8 rounded-lg";
  return (
    <div className="flex items-center gap-1 border-t border-border/70 px-3 py-2.5">
      <Button size="sm" className="h-8 rounded-lg px-3 text-[12.5px]" onClick={form("decide")}>
        <CheckIcon className="size-3.5" />
        Обрати
      </Button>
      <span className="flex-1" />
      <Tip tip="Підтримати: чому це добрий варіант">
        <Button size="icon" variant="ghost" className={cn(icon, "text-add-ink hover:bg-add")} aria-label="Підтримати" onClick={form("support")}>
          <ThumbsUpIcon className="size-4" />
        </Button>
      </Tip>
      <Tip tip="Заперечити: що з ним не так">
        <Button size="icon" variant="ghost" className={cn(icon, "text-destructive hover:bg-destructive-soft")} aria-label="Заперечити" onClick={form("object")}>
          <ShieldAlertIcon className="size-4" />
        </Button>
      </Tip>
      <Tip tip="Додати доказ: вимір, тест, посилання">
        <Button size="icon" variant="ghost" className={cn(icon, "text-codex hover:bg-codex-soft")} aria-label="Доказ" onClick={form("evidence")}>
          <MicroscopeIcon className="size-4" />
        </Button>
      </Tip>
    </div>
  );
}

function OptionCard({ o, table, room, decided }: { o: TableOption; table: TableState; room: RoomState; decided: boolean }) {
  const notes = table.notes.filter((n) => n.target === o.id).sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.seq - b.seq);
  const v = verdict(table, o, decided);
  const faded = o.status === "withdrawn" || (decided && o.status !== "chosen");
  const who = stances(table, o);
  return (
    <article
      id={`opt-${o.id}`}
      className={cn(
        "relative flex min-w-0 scroll-mt-24 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-soft before:absolute before:inset-x-0 before:top-0 before:h-[3px]",
        band[participant(room, o.by).tone],
        o.status === "chosen" && "border-primary/60 ring-2 ring-primary/20",
        faded && "opacity-65 saturate-50",
      )}
    >
      <div className="flex flex-1 flex-col gap-2.5 p-4 pt-5">
        <header className="flex items-center gap-2">
          <RefChip id={o.id} />
          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", v.cls)}>{v.label}</span>
        </header>
        <h4 className={cn("text-[15.5px] leading-snug font-semibold text-balance", o.status === "withdrawn" && "line-through decoration-faint")}>{o.title}</h4>
        {o.body ? (
          <Clamp max={150} more="Детальніше">
            <Markdown text={o.body} source={`o:${o.id}`} className="text-[13.5px] text-foreground/90" />
          </Clamp>
        ) : null}
        {o.file ? <FilePreview file={o.file} /> : null}
      </div>
      <div className="flex flex-col gap-2.5 border-t border-border/70 bg-muted/35 px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {who.map(([handle, s]) => (
            <span key={handle} className="inline-flex items-center gap-1 text-[12px]">
              <Avatar handle={handle} size={18} />
              <Name handle={handle} className="font-medium" />
              <span className={cn("font-medium", STANCE[s].cls)}>{STANCE[s].word}</span>
            </span>
          ))}
        </div>
        <Meter table={table} o={o} />
        <Notes notes={notes} />
      </div>
      {o.status === "open" && !decided ? <Actions id={o.id} /> : null}
    </article>
  );
}

function AddOption({ q }: { q: string }) {
  const openDialog = useStore((s) => s.openDialog);
  const driven = useStore((s) => s.snap?.driven);
  if (!driven) return null;
  return (
    <button
      type="button"
      onClick={() => openDialog({ kind: "table-form", op: "propose", q })}
      className="mt-3 flex h-10 w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-input text-[13px] text-muted-foreground transition hover:border-primary/50 hover:bg-card hover:text-foreground"
    >
      <PlusIcon className="size-4" />
      Запропонувати свій варіант
    </button>
  );
}

const grid = "grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,268px),1fr))]";

function OpenQuestion({ q, table, room }: { q: TableQuestion; table: TableState; room: RoomState }) {
  const options = table.options.filter((o) => o.q === q.id);
  const open = options.filter((o) => o.status === "open");
  const contested = open.filter((o) => noteCounts(table, o.id).obj).length;
  return (
    <section id={`q-${q.id}`} className="scroll-mt-6 rounded-3xl border border-border bg-background/70 p-3 sm:p-4">
      <header className="flex flex-col gap-2 px-1 pb-4">
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
          <RefChip id={q.id} />
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-soft px-2 py-0.5 text-[11px] font-semibold text-amber">
            <CircleHelpIcon className="size-3" />
            Відкрите
          </span>
          <span className="inline-flex items-center gap-1">
            ставить <Avatar handle={q.by} size={16} /> <Name handle={q.by} className="font-medium" />
          </span>
          <span className="ml-auto tabular">
            {open.length ? plural(open.length, "варіант", "варіанти", "варіантів") : "варіантів ще немає"}
            {contested ? ` · ${contested} оскаржено` : ""}
          </span>
        </div>
        <Markdown text={q.text} className="text-[18px] leading-snug font-semibold tracking-tight text-balance" />
      </header>
      <div className={grid}>
        {options.map((o) => (
          <OptionCard key={o.id} o={o} table={table} room={room} decided={false} />
        ))}
      </div>
      <AddOption q={q.id} />
    </section>
  );
}

function DecidedQuestion({ q, table, room }: { q: TableQuestion; table: TableState; room: RoomState }) {
  const flash = useStore((s) => s.flash);
  const options = table.options.filter((o) => o.q === q.id);
  const decision = table.decisions.filter((d) => d.q === q.id).at(-1);
  const chosen = decision ? table.options.find((o) => o.id === decision.option) : undefined;
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!flash) return;
    const anchor = refAnchor(room, flash.ref);
    if (anchor === `q-${q.id}` || options.some((o) => anchor === `opt-${o.id}`)) setShow(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flash]);
  return (
    <section id={`q-${q.id}`} className="scroll-mt-6 rounded-3xl border border-border/80 bg-background/50 p-3 sm:p-4">
      <header className="flex flex-wrap items-center gap-2 px-1 text-[12px] text-muted-foreground">
        <RefChip id={q.id} />
        <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
          <GavelIcon className="size-3" />
          Вирішено
        </span>
        <Markdown text={q.text} className="min-w-0 basis-full text-[15.5px] leading-snug font-semibold text-foreground sm:basis-auto sm:flex-1" />
      </header>
      {decision ? (
        <div className="mt-3 flex gap-3 rounded-2xl bg-secondary/70 p-3.5 ring-1 ring-primary/15">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
            <CheckIcon className="size-4" strokeWidth={3} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5 text-[14.5px] font-semibold">
              <RefChip id={decision.option} />
              {chosen?.title ?? decision.option}
            </div>
            {decision.note ? (
              <Clamp max={96} fade="from-secondary" more="Детальніше">
                <Markdown text={decision.note} className="mt-1 text-[13.5px] text-muted-foreground" />
              </Clamp>
            ) : null}
            <div className="mt-1 text-[11.5px] text-faint">
              рішення №{decision.n} · {participant(room, decision.by).label}
            </div>
          </div>
        </div>
      ) : null}
      {options.length ? (
        <button
          type="button"
          onClick={() => setShow(!show)}
          className="mt-2 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12.5px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronDownIcon className={cn("size-4 transition", show && "rotate-180")} />
          {show ? "Сховати варіанти" : `Усі варіанти й аргументи · ${options.length}`}
        </button>
      ) : null}
      {show ? (
        <div className={cn(grid, "mt-2")}>
          {options.map((o) => (
            <OptionCard key={o.id} o={o} table={table} room={room} decided />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function LedgerBlock({ id, title, Icon, aside, children }: { id: string; title: string; Icon: typeof CheckIcon; aside?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6 rounded-2xl border border-border bg-card p-4 shadow-soft">
      <h3 className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        <Icon className="size-3.5" />
        {title}
        {aside ? <span className="ml-auto tracking-normal normal-case">{aside}</span> : null}
      </h3>
      {children}
    </section>
  );
}

function Ledger({ table, room }: { table: TableState; room: RoomState }) {
  const post = useStore((s) => s.post);
  const decisions = [...table.decisions].reverse();
  const settled = [...table.settled.map((s) => ({ ...s, fact: false })), ...table.facts.map((f) => ({ ...f, fact: true }))].sort((a, b) => a.seq - b.seq);
  const done = table.next.filter((n) => n.done).length;
  return (
    <>
      <LedgerBlock id="board-decisions" title="Рішення" Icon={GavelIcon} aside={decisions.length ? <span className="tabular text-faint">{decisions.length}</span> : null}>
        {decisions.length ? (
          <ol className="flex flex-col gap-3">
            {decisions.map((d) => {
              const o = table.options.find((x) => x.id === d.option);
              return (
                <li key={d.id} className="flex gap-2.5">
                  <span className="tabular mt-0.5 grid h-5 min-w-5 shrink-0 place-items-center rounded-md bg-primary px-1 text-[11px] font-bold text-primary-foreground">
                    {d.n}
                  </span>
                  <div className="min-w-0 text-[13.5px]">
                    <div className="leading-snug font-semibold">
                      <RefChip id={d.option} className="mr-1 align-[1px]" />
                      {o?.title ?? d.option}
                    </div>
                    <div className="mt-0.5 text-[11.5px] text-faint">{participant(room, d.by).label}</div>
                  </div>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="text-[13px] text-muted-foreground">Ще нічого не обрано. Рішення з’являться тут, коли хтось обере варіант.</p>
        )}
      </LedgerBlock>
      {settled.length ? (
        <LedgerBlock id="board-settled" title="Узгоджено й факти" Icon={PinIcon}>
          <ul className="flex flex-col gap-2.5">
            {settled.map((s) => (
              <li key={s.id} id={`ti-${s.id}`} className="flex scroll-mt-24 gap-2.5">
                {s.fact ? (
                  <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded bg-codex-soft font-mono text-[10px] font-bold text-codex" title="Факт">
                    F
                  </span>
                ) : (
                  <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary/60 ring-4 ring-primary/10" />
                )}
                <div className="min-w-0 text-[13px]">
                  <Clamp max={88} more="Далі">
                    <Markdown text={s.text} />
                  </Clamp>
                  <div className="text-[11.5px] text-faint">
                    {s.fact ? "факт · " : ""}
                    {participant(room, s.by).label}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </LedgerBlock>
      ) : null}
      {table.next.length ? (
        <LedgerBlock
          id="board-next"
          title="Наступні кроки"
          Icon={FootprintsIcon}
          aside={
            <span className="tabular text-faint">
              {done} / {table.next.length}
            </span>
          }
        >
          <div className="mb-3 h-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${(done / table.next.length) * 100}%` }} />
          </div>
          <ul className="flex flex-col gap-2">
            {table.next.map((n) => (
              <li key={n.id} id={`ti-${n.id}`} className={cn("flex scroll-mt-24 gap-2.5", n.done && "text-muted-foreground")}>
                <button
                  type="button"
                  disabled={n.done}
                  aria-label={n.done ? "Виконано" : "Позначити виконаним"}
                  title={n.done ? "Виконано" : "Позначити виконаним"}
                  onClick={() => post("/table", { op: "done", target: n.id }).catch((e) => toast.error(e instanceof Error ? e.message : String(e)))}
                  className={cn(
                    "mt-0.5 grid size-4 shrink-0 place-items-center rounded border transition",
                    n.done ? "border-primary bg-primary text-primary-foreground" : "border-input bg-card hover:border-primary",
                  )}
                >
                  {n.done ? <CheckIcon className="size-3" strokeWidth={3} /> : null}
                </button>
                <div className="min-w-0 text-[13px]">
                  <Markdown text={n.text} className={cn(n.done && "line-through decoration-faint")} />
                  <div className="text-[11.5px] text-faint">{participant(room, n.by).label}</div>
                </div>
              </li>
            ))}
          </ul>
        </LedgerBlock>
      ) : null}
    </>
  );
}

/** The four steps the table is made of, so a first look explains it. */
function Flow({ className }: { className?: string }) {
  const steps: Array<[string, string, typeof CheckIcon, string]> = [
    ["Питання", "що треба вирішити", CircleHelpIcon, "text-amber bg-amber-soft"],
    ["Варіанти", "реальні альтернативи", LightbulbIcon, "text-primary bg-secondary"],
    ["Аргументи", "за, проти, докази", ScaleIcon, "text-codex bg-codex-soft"],
    ["Рішення", "обирає будь-хто", GavelIcon, "text-primary-foreground bg-primary"],
  ];
  return (
    <ol className={cn("flex flex-wrap items-center gap-x-1.5 gap-y-2", className)}>
      {steps.map(([label, hint, Icon, tone], i) => (
        <li key={label} className="flex items-center gap-1.5">
          <span className="flex items-center gap-2 rounded-xl border border-border bg-card py-1.5 pr-3 pl-1.5">
            <span className={cn("grid size-6 place-items-center rounded-lg", tone)}>
              <Icon className="size-3.5" />
            </span>
            <span className="flex flex-col leading-tight">
              <b className="text-[12.5px] font-semibold">{label}</b>
              <span className="text-[11px] text-muted-foreground">{hint}</span>
            </span>
          </span>
          {i < steps.length - 1 ? <ArrowRightIcon className="size-3.5 text-faint" /> : null}
        </li>
      ))}
    </ol>
  );
}

function Toolbar() {
  const openDialog = useStore((s) => s.openDialog);
  const driven = useStore((s) => s.snap?.driven);
  if (!driven) return null;
  const items: Array<[TableFormOp, string, typeof PlusIcon]> = [
    ["ask", "Питання", CircleHelpIcon],
    ["propose", "Варіант", LightbulbIcon],
    ["settle", "Узгоджено", PinIcon],
    ["next", "Крок", FootprintsIcon],
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {items.map(([op, label, Icon]) => (
        <Button key={op} variant="outline" size="sm" className="h-8 rounded-lg bg-card text-[12.5px]" onClick={() => openDialog({ kind: "table-form", op })}>
          <Icon className="size-3.5" />
          {label}
        </Button>
      ))}
    </div>
  );
}

function Summary({ table }: { table: TableState }) {
  const openQ = table.questions.filter((q) => q.status === "open").length;
  const live = table.options.filter((o) => o.status === "open" && (!o.q || table.questions.find((q) => q.id === o.q)?.status !== "decided"));
  const contested = live.filter((o) => noteCounts(table, o.id).obj).length;
  const done = table.next.filter((n) => n.done).length;
  const go = (id: string) => () => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const cells: Array<{ n: string; label: string; sub?: string; target: string; tone: string }> = [
    { n: String(openQ), label: plural(openQ, "відкрите питання", "відкриті питання", "відкритих питань").replace(/^\d+ /, ""), target: "board-open", tone: openQ ? "text-amber" : "text-faint" },
    {
      n: String(live.length),
      label: "варіантів на розгляді",
      sub: contested ? `${contested} оскаржено` : undefined,
      target: "board-open",
      tone: live.length ? "text-foreground" : "text-faint",
    },
    { n: String(table.decisions.length), label: "рішень", target: "board-decisions", tone: table.decisions.length ? "text-primary" : "text-faint" },
    { n: `${done}/${table.next.length}`, label: "кроків виконано", target: "board-next", tone: table.next.length ? "text-foreground" : "text-faint" },
  ];
  return (
    <div className="grid grid-cols-2 overflow-hidden rounded-2xl border border-border bg-card shadow-soft @2xl:grid-cols-4">
      {cells.map((c, i) => (
        <button
          key={c.label}
          type="button"
          onClick={go(c.target)}
          className={cn(
            "flex flex-col items-start gap-0.5 px-4 py-3 text-left transition hover:bg-accent/60",
            i % 2 === 1 && "border-l border-border",
            i >= 2 && "border-t border-border @2xl:border-t-0",
            i === 2 && "@2xl:border-l",
          )}
        >
          <span className={cn("tabular text-[24px] leading-none font-semibold tracking-tight", c.tone)}>{c.n}</span>
          <span className="text-[12px] text-muted-foreground">
            {c.label}
            {c.sub ? <span className="text-destructive"> · {c.sub}</span> : null}
          </span>
        </button>
      ))}
    </div>
  );
}

function Empty() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center gap-5 px-4 py-16 text-center">
      <span className="grid size-14 place-items-center rounded-2xl bg-secondary text-primary shadow-soft">
        <ScaleIcon className="size-6" />
      </span>
      <div className="flex flex-col gap-2">
        <h2 className="font-serif text-[26px] font-semibold tracking-tight">Стіл порожній</h2>
        <p className="mx-auto max-w-[52ch] text-[14.5px] leading-relaxed text-pretty text-muted-foreground">
          Коли в розмові з’являється справжній вибір, агенти кладуть його сюди: питання, кілька варіантів, а під кожним — хто за, хто проти і чим це доведено. Ви бачите
          згоду й суперечку одним поглядом, а не шукаєте їх у стрічці.
        </p>
      </div>
      <Flow className="justify-center" />
      <p className="text-[13px] text-faint">Агенти роблять це самі. Або почніть ви:</p>
      <Toolbar />
    </div>
  );
}

export function TableBoard() {
  const room = useStore((s) => s.snap?.state);
  const flash = useStore((s) => s.flash);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!flash || flash.ref.startsWith("m-") || !room) return;
    const id = refAnchor(room, flash.ref);
    if (!id) return;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A folded question opens itself on the same flash; its options appear a render later.
    const find = () => {
      const node = host.current?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
      if (!node) {
        if (tries++ < 6) timer = setTimeout(find, 60);
        return;
      }
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      node.classList.remove("animate-flash");
      void node.offsetWidth;
      node.classList.add("animate-flash");
    };
    timer = setTimeout(find, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flash]);
  if (!room) return null;
  const table = room.table;
  const empty = !table.questions.length && !table.options.length && !table.settled.length && !table.facts.length && !table.next.length;
  const open = table.questions.filter((q) => q.status === "open").sort((a, b) => a.seq - b.seq);
  const decided = table.questions.filter((q) => q.status === "decided").sort((a, b) => b.seq - a.seq);
  const loose = table.options.filter((o) => !o.q);
  return (
    <div ref={host} className="scroll-thin min-h-0 flex-1 overflow-y-auto bg-canvas">
      {empty ? (
        <Empty />
      ) : (
        <div className="@container mx-auto flex w-full max-w-[1320px] flex-col gap-5 px-3 pt-6 pb-10 sm:px-6">
          <header className="flex flex-col gap-4 @4xl:flex-row @4xl:items-end @4xl:justify-between">
            <div className="flex max-w-[64ch] flex-col gap-1.5">
              <h1 className="flex items-center gap-2.5 font-serif text-[28px] leading-none font-semibold tracking-tight">
                <ScaleIcon className="size-6 text-primary" />
                Стіл
              </h1>
              <p className="text-[14px] leading-relaxed text-pretty text-muted-foreground">
                Тут вибір розкладено по поличках: питання, варіанти, хто за й хто проти і чим це доведено. Агенти ведуть стіл самі; ви бачите, де згода, а де суперечка, — й
                можете обрати.
              </p>
            </div>
            <Toolbar />
          </header>
          <Flow className="hidden @2xl:flex" />
          <Summary table={table} />
          <div className="grid items-start gap-5 @4xl:grid-cols-[minmax(0,1fr)_minmax(280px,320px)]">
            <div id="board-open" className="flex min-w-0 scroll-mt-6 flex-col gap-4">
              {open.map((q) => (
                <OpenQuestion key={q.id} q={q} table={table} room={room} />
              ))}
              {loose.length ? (
                <section className="rounded-3xl border border-border bg-background/70 p-3 sm:p-4">
                  <header className="px-1 pb-3 text-[13px] text-muted-foreground">
                    <b className="font-semibold text-foreground">Пропозиції без окремого питання</b> · їх можна обрати напряму
                  </header>
                  <div className={grid}>
                    {loose.map((o) => (
                      <OptionCard key={o.id} o={o} table={table} room={room} decided={false} />
                    ))}
                  </div>
                </section>
              ) : null}
              {!open.length && !loose.length ? (
                <div className="flex items-center gap-3 rounded-3xl border border-dashed border-border px-5 py-4 text-[13.5px] text-muted-foreground">
                  <CheckIcon className="size-4 text-primary" />
                  Відкритих питань немає — усе, що було на столі, вирішено.
                </div>
              ) : null}
              {decided.length ? (
                <>
                  <h2 className="mt-2 flex items-center gap-2 px-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                    <GavelIcon className="size-3.5" />
                    Вирішені питання
                  </h2>
                  {decided.map((q) => (
                    <DecidedQuestion key={q.id} q={q} table={table} room={room} />
                  ))}
                </>
              ) : null}
            </div>
            <aside className="flex flex-col gap-4">
              <Ledger table={table} room={room} />
            </aside>
          </div>
        </div>
      )}
    </div>
  );
}
