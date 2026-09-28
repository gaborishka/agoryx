import { CheckIcon, CircleHelpIcon, FootprintsIcon, GavelIcon, PinIcon, PlusIcon, SparklesIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { Avatar, Name } from "@/components/room/bits";
import { Markdown } from "@/components/md/Markdown";
import { Button } from "@/components/ui/button";
import { plural } from "@/lib/format";
import { participant, refAnchor } from "@/lib/room";
import { type TableFormOp, useStore } from "@/lib/store";
import type { RoomState, TableNote, TableOption, TableQuestion, TableState } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FilePreview, NoteSource, RefChip, Standing } from "./OpCard";

const NOTE: Record<TableNote["kind"], { label: string; cls: string; mark: string }> = {
  object: { label: "Заперечення", cls: "border-l-destructive/60 bg-destructive-soft/50", mark: "text-destructive" },
  support: { label: "Підтримка", cls: "border-l-add-ink/50 bg-add/40", mark: "text-add-ink" },
  evidence: { label: "Доказ", cls: "border-l-codex/50 bg-codex-soft/60", mark: "text-codex" },
};
const ORDER = { object: 0, evidence: 1, support: 2 } as const;

const optTone = { claude: "before:bg-claude", codex: "before:bg-codex", human: "before:bg-human", sys: "before:bg-border" } as const;

function Note({ n }: { n: TableNote }) {
  const k = NOTE[n.kind];
  return (
    <div id={`ti-${n.id}`} className={cn("rounded-lg border-l-2 px-2.5 py-2", k.cls)}>
      <div className="mb-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <Avatar handle={n.by} size={16} />
        <span className={cn("font-semibold", k.mark)}>{k.label}</span>
        <span>·</span>
        <Name handle={n.by} className="font-medium" />
        {n.source ? <NoteSource source={n.source} /> : null}
      </div>
      <Markdown text={n.text} className="text-[13.5px]" />
    </div>
  );
}

function Actions({ id }: { id: string }) {
  const openDialog = useStore((s) => s.openDialog);
  const driven = useStore((s) => s.snap?.driven);
  if (!driven) return null;
  const form = (op: TableFormOp) => () => openDialog({ kind: "table-form", op, target: id });
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      <Button size="sm" className="h-7 rounded-lg text-xs" onClick={form("decide")}>
        <CheckIcon className="size-3.5" />
        Обрати
      </Button>
      <Button size="sm" variant="outline" className="h-7 rounded-lg text-xs" onClick={form("object")}>
        Заперечити
      </Button>
      <Button size="sm" variant="outline" className="h-7 rounded-lg text-xs" onClick={form("support")}>
        Підтримати
      </Button>
      <Button size="sm" variant="ghost" className="h-7 rounded-lg text-xs" onClick={form("evidence")}>
        Доказ
      </Button>
    </div>
  );
}

function Option({ o, table, room, decided }: { o: TableOption; table: TableState; room: RoomState; decided: boolean }) {
  const notes = table.notes.filter((n) => n.target === o.id).sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.seq - b.seq);
  const lost = decided && o.status === "open";
  return (
    <article
      id={`opt-${o.id}`}
      className={cn(
        "relative scroll-mt-4 overflow-hidden rounded-xl border border-border bg-card p-3.5 pl-4 shadow-soft before:absolute before:inset-y-0 before:left-0 before:w-[3px]",
        optTone[participant(room, o.by).tone],
        o.status === "chosen" && "border-primary/50 ring-2 ring-primary/15",
        (lost || o.status === "withdrawn") && "opacity-60",
      )}
    >
      <header className="flex items-start gap-2">
        <RefChip id={o.id} className="mt-0.5" />
        <h4 className={cn("min-w-0 flex-1 text-[14.5px] leading-snug font-semibold", o.status === "withdrawn" && "line-through")}>{o.title}</h4>
        <Standing table={table} o={o} />
      </header>
      <div className="mt-1 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <Avatar handle={o.by} size={16} />
        <Name handle={o.by} className="font-medium" />
      </div>
      {o.body ? <Markdown text={o.body} source={`o:${o.id}`} className="mt-2 text-[14px]" /> : null}
      {o.file ? <FilePreview file={o.file} /> : null}
      {notes.length ? (
        <div className="mt-3 flex flex-col gap-1.5">
          {notes.map((n) => (
            <Note key={n.id} n={n} />
          ))}
        </div>
      ) : null}
      {o.status === "open" && !decided ? <Actions id={o.id} /> : null}
    </article>
  );
}

function Question({ q, table, room }: { q: TableQuestion; table: TableState; room: RoomState }) {
  const openDialog = useStore((s) => s.openDialog);
  const driven = useStore((s) => s.snap?.driven);
  const options = table.options.filter((o) => o.q === q.id);
  const decided = q.status === "decided";
  const decision = table.decisions.filter((d) => d.q === q.id).at(-1);
  const open = options.filter((o) => o.status === "open").length;
  return (
    <section id={`q-${q.id}`} className={cn("scroll-mt-4 rounded-2xl border border-border bg-muted/40 p-3", decided && "bg-transparent")}>
      <header className="flex items-center gap-2 px-1 text-[12px] text-muted-foreground">
        <RefChip id={q.id} />
        <Name handle={q.by} className="font-medium" />
        <span
          className={cn(
            "ml-auto rounded-full px-2 py-0.5 text-[11px] font-medium",
            decided ? "bg-primary/10 text-primary" : "text-muted-foreground",
          )}
        >
          {decided ? `Вирішено${decision ? ` — ${decision.option}` : ""}` : options.length ? plural(open, "варіант", "варіанти", "варіантів") : "Варіантів ще немає"}
        </span>
      </header>
      <div className="px-1 pt-1.5 pb-3 text-[15px] font-semibold leading-snug text-balance">
        <Markdown text={q.text} />
      </div>
      {options.length ? (
        <div className="flex flex-col gap-2.5">
          {options.map((o) => (
            <Option key={o.id} o={o} table={table} room={room} decided={decided} />
          ))}
        </div>
      ) : null}
      {!decided && driven ? (
        <button
          type="button"
          onClick={() => openDialog({ kind: "table-form", op: "propose", q: q.id })}
          className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-input py-2 text-[13px] text-muted-foreground transition hover:border-primary/40 hover:bg-card hover:text-foreground"
        >
          <PlusIcon className="size-3.5" />
          Запропонувати варіант
        </button>
      ) : null}
    </section>
  );
}

function Where({ table, room }: { table: TableState; room: RoomState }) {
  const post = useStore((s) => s.post);
  const decisions = [...table.decisions].reverse();
  const settled = [...table.settled.map((s) => ({ ...s, fact: false })), ...table.facts.map((f) => ({ ...f, fact: true }))];
  if (!decisions.length && !settled.length && !table.next.length) return null;
  const h = "mb-2 flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase";
  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-primary/20 bg-secondary/50 p-4">
      {decisions.length ? (
        <div>
          <h3 className={h}>
            <GavelIcon className="size-3.5" />
            Рішення
          </h3>
          <ul className="flex flex-col gap-2">
            {decisions.map((d) => {
              const o = table.options.find((x) => x.id === d.option);
              return (
                <li key={d.id} className="flex gap-2.5">
                  <span className="mt-1 grid size-4 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
                    <CheckIcon className="size-2.5" strokeWidth={3} />
                  </span>
                  <div className="min-w-0 text-[13.5px]">
                    <span className="font-semibold">
                      {o ? (
                        <>
                          <RefChip id={o.id} /> «{o.title}»
                        </>
                      ) : (
                        d.option
                      )}
                    </span>
                    {d.note ? <Markdown text={d.note} className="text-[13px] text-muted-foreground" /> : null}
                    <div className="text-[11.5px] text-faint">
                      рішення №{d.n} · {participant(room, d.by).label}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {settled.length ? (
        <div>
          <h3 className={h}>
            <PinIcon className="size-3.5" />
            Узгоджено
          </h3>
          <ul className="flex flex-col gap-2">
            {settled.map((s) => (
              <li key={s.id} id={`ti-${s.id}`} className="flex gap-2.5 rounded-md">
                {s.fact ? (
                  <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded bg-codex-soft font-mono text-[10px] font-bold text-codex" title="Факт">
                    F
                  </span>
                ) : (
                  <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary/50 ring-4 ring-primary/10" />
                )}
                <div className="min-w-0 text-[13.5px]">
                  <Markdown text={s.text} />
                  <div className="text-[11.5px] text-faint">
                    {s.fact ? "факт · " : ""}
                    {participant(room, s.by).label}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {table.next.length ? (
        <div>
          <h3 className={h}>
            <FootprintsIcon className="size-3.5" />
            Наступні кроки
          </h3>
          <ul className="flex flex-col gap-1.5">
            {table.next.map((n) => (
              <li key={n.id} id={`ti-${n.id}`} className={cn("flex gap-2.5 rounded-md", n.done && "text-muted-foreground")}>
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
                <div className="min-w-0 text-[13.5px]">
                  <Markdown text={n.text} className={cn(n.done && "line-through decoration-faint")} />
                  <div className="text-[11.5px] text-faint">{participant(room, n.by).label}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function Toolbar() {
  const openDialog = useStore((s) => s.openDialog);
  const driven = useStore((s) => s.snap?.driven);
  if (!driven) return null;
  const items: Array<[TableFormOp, string, typeof PlusIcon]> = [
    ["ask", "Питання", CircleHelpIcon],
    ["propose", "Пропозиція", PlusIcon],
    ["settle", "Узгоджено", PinIcon],
    ["next", "Крок", FootprintsIcon],
  ];
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map(([op, label, Icon]) => (
        <Button key={op} variant="outline" size="sm" className="h-8 rounded-lg bg-card text-[12.5px]" onClick={() => openDialog({ kind: "table-form", op })}>
          <Icon className="size-3.5" />
          {label}
        </Button>
      ))}
    </div>
  );
}

export function TablePanel() {
  const room = useStore((s) => s.snap?.state);
  const flash = useStore((s) => s.flash);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!flash || flash.ref.startsWith("m-") || !room) return;
    const id = refAnchor(room, flash.ref);
    const node = id ? host.current?.querySelector<HTMLElement>(`#${CSS.escape(id)}`) : null;
    if (!node) return;
    requestAnimationFrame(() => {
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      node.classList.remove("animate-flash");
      void node.offsetWidth;
      node.classList.add("animate-flash");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flash]);
  if (!room) return null;
  const table = room.table;
  const empty = !table.questions.length && !table.options.length && !table.settled.length && !table.facts.length && !table.next.length;
  if (empty) {
    return (
      <div className="flex flex-col items-center gap-4 px-6 py-14 text-center">
        <span className="grid size-12 place-items-center rounded-2xl bg-secondary text-primary">
          <SparklesIcon className="size-5" />
        </span>
        <h3 className="text-[17px] font-semibold">Стіл порожній</h3>
        <p className="max-w-[42ch] text-[14px] leading-relaxed text-pretty text-muted-foreground">
          Коли є справжні альтернативи, агенти кладуть сюди питання й варіанти, заперечують і підтримують одне одного, додають докази. Ви бачите, де згода, а де
          суперечка, — і обираєте.
        </p>
        <p className="text-[13px] text-faint">Агенти роблять це самі. Або почніть ви:</p>
        <Toolbar />
      </div>
    );
  }
  const questions = [...table.questions].sort((a, b) => (a.status === b.status ? a.seq - b.seq : a.status === "open" ? -1 : 1));
  const loose = table.options.filter((o) => !o.q);
  return (
    <div ref={host} className="flex flex-col gap-4 p-4">
      <Toolbar />
      <Where table={table} room={room} />
      {questions.map((q) => (
        <Question key={q.id} q={q} table={table} room={room} />
      ))}
      {loose.length ? (
        <section className="rounded-2xl border border-border bg-muted/40 p-3">
          <header className="px-1 pb-2.5 text-[12px] text-muted-foreground">Пропозиції без окремого питання</header>
          <div className="flex flex-col gap-2.5">
            {loose.map((o) => (
              <Option key={o.id} o={o} table={table} room={room} decided={false} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
