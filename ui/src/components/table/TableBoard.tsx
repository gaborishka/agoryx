import {
  ArrowRightIcon,
  BadgeCheckIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleHelpIcon,
  FlameIcon,
  FootprintsIcon,
  GavelIcon,
  LightbulbIcon,
  ListChecksIcon,
  MessageSquareQuoteIcon,
  MicroscopeIcon,
  PinIcon,
  PlusIcon,
  RefreshCcwIcon,
  ScaleIcon,
  ShieldAlertIcon,
  ThumbsUpIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Avatar, Name, Tip } from "@/components/room/bits";
import { Clamp } from "@/components/common/Clamp";
import { EmptyState } from "@/components/common/states";
import { Markdown } from "@/components/md/Markdown";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { plural } from "@/lib/format";
import { inkColor, participant, refAnchor } from "@/lib/room";
import { disputeOf } from "@agora/table";
import { type TableFormOp, useStore } from "@/lib/store";
import type { RoomState, TableItem, TableNote, TableOption, TableQuestion, TableState } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FilePreview, NoteSource, noteCounts, RefChip } from "./OpCard";

const band = { claude: "border-l-claude", codex: "border-l-codex", human: "border-l-human", sys: "border-l-border" } as const;

/** Concessions, for rooms whose table predates them. */
const shiftsOf = (table: TableState): TableItem[] => table.shifts ?? [];

const questionOf = (table: TableState, o: TableOption) => (o.q ? table.questions.find((q) => q.id === o.q) : undefined);

/** Still waiting for a decision: open, and not under a question that is already closed. */
const isLive = (table: TableState, o: TableOption) => o.status === "open" && (questionOf(table, o)?.status ?? "open") === "open";

/** Where an option stands, in one word a reader can act on. */
function verdict(table: TableState, o: TableOption) {
  if (o.status === "chosen") return { label: "Chosen", cls: "bg-meet text-background" };
  if (o.status === "withdrawn") return { label: "Withdrawn", cls: "bg-muted text-muted-foreground" };
  const q = questionOf(table, o);
  if (q?.status === "decided") return { label: "Not chosen", cls: "bg-muted text-muted-foreground" };
  if (q?.status === "answered") return { label: "Question closed", cls: "bg-muted text-muted-foreground" };
  const { sup, obj } = noteCounts(table, o.id);
  if (sup && obj) return { label: "Disputed", cls: "bg-amber-soft text-amber" };
  if (obj) return { label: "Challenged", cls: "bg-destructive-soft text-destructive" };
  if (sup) return { label: "Endorsed", cls: "bg-add text-add-ink" };
  return { label: "No responses", cls: "bg-muted text-muted-foreground" };
}

// --- the argument map: who answered whom, and how --------------------------------------------------

type Tally = { proposed: number; support: number; object: number; evidence: number; shifts: number };
type Edge = { from: string; to: string; support: number; object: number; evidence: number; shifts: number };

/** Who wrote the item a ref points at. */
const authorOf = (table: TableState, ref?: string) => {
  if (!ref) return undefined;
  const lists: Array<Array<{ id: string; by: string }>> = [table.options, table.questions, table.settled, table.facts, table.notes, shiftsOf(table), table.next];
  for (const list of lists) {
    const hit = list.find((x) => x.id === ref);
    if (hit) return hit.by;
  }
  return undefined;
};

/** The edges between participants: every support, objection, piece of evidence and concession aimed at someone else's item. */
function argumentMap(table: TableState) {
  const tally = new Map<string, Tally>();
  const edges = new Map<string, Edge>();
  const t = (who: string) => {
    let x = tally.get(who);
    if (!x) tally.set(who, (x = { proposed: 0, support: 0, object: 0, evidence: 0, shifts: 0 }));
    return x;
  };
  const e = (from: string, to: string) => {
    const key = `${from}→${to}`;
    let x = edges.get(key);
    if (!x) edges.set(key, (x = { from, to, support: 0, object: 0, evidence: 0, shifts: 0 }));
    return x;
  };
  for (const o of table.options) t(o.by).proposed += 1;
  for (const n of table.notes) {
    const kind = n.kind === "object" ? "object" : n.kind === "support" ? "support" : "evidence";
    t(n.by)[kind] += 1;
    const to = authorOf(table, n.target);
    if (to && to !== n.by) e(n.by, to)[kind] += 1;
  }
  for (const c of shiftsOf(table)) {
    t(c.by).shifts += 1;
    const to = authorOf(table, c.target);
    // Giving up your own proposal is a concession to whoever objected to it.
    const toward =
      to === c.by ? [...new Set(table.notes.filter((n) => n.target === c.target && n.kind === "object" && n.by !== c.by).map((n) => n.by))] : to ? [to] : [];
    for (const who of toward) e(c.by, who).shifts += 1;
  }
  const weight = (x: Edge) => x.object * 2 + x.support + x.evidence + x.shifts * 2;
  return { tally, edges: [...edges.values()].sort((a, b) => weight(b) - weight(a)) };
}

/** One side objects again and again, the other never does: agreement without friction may be politeness. */
function asymmetry(room: RoomState, edges: Edge[], tally: Map<string, Tally>) {
  const agents = new Set(room.agents.map((a) => a.id));
  let best: { loud: string; quiet: string; objections: number; shifts: number; alone: boolean } | null = null;
  for (const x of edges) {
    if (!agents.has(x.from) || !agents.has(x.to) || x.object < 2) continue;
    const back = edges.find((y) => y.from === x.to && y.to === x.from);
    if (back?.object) continue;
    if (!best || x.object > best.objections) {
      // "Only X argues" holds only if no other agent objects to anything; with three, a third may be arguing too.
      const alone = room.agents.every((a) => a.id === x.from || !tally.get(a.id)?.object);
      best = { loud: x.from, quiet: x.to, objections: x.object, shifts: back?.shifts ?? 0, alone };
    }
  }
  return best;
}

function Pill({ n, kind, tip }: { n: number; kind: "support" | "object" | "evidence" | "shifts"; tip: string }) {
  if (!n) return null;
  const look = {
    support: ["bg-add text-add-ink", ThumbsUpIcon],
    object: ["bg-destructive-soft text-destructive", ShieldAlertIcon],
    evidence: ["bg-codex-soft text-codex", MicroscopeIcon],
    shifts: ["bg-shift-soft text-shift", RefreshCcwIcon],
  } as const;
  const [cls, Icon] = look[kind];
  return (
    <Tip tip={tip}>
      <span className={cn("tabular inline-flex h-5 items-center gap-1 rounded-full px-1.5 text-meta font-semibold ring-1 ring-card", cls)}>
        <Icon className="size-3" />
        {n}
      </span>
    </Tip>
  );
}

function EdgeRow({ x, room }: { x: Edge; room: RoomState }) {
  const from = participant(room, x.from).label;
  const to = participant(room, x.to).label;
  const hostile = x.object > x.support + x.shifts;
  return (
    <li className="flex items-center gap-2">
      <span className="flex w-[5.5rem] shrink-0 items-center gap-1.5 sm:w-24">
        <Avatar handle={x.from} size={22} />
        <Name handle={x.from} className="truncate text-small" />
      </span>
      <span className="relative flex h-7 min-w-16 flex-1 items-center justify-center">
        <span className={cn("absolute inset-x-0 top-1/2 border-t-2 border-dashed", hostile ? "border-destructive/35" : "border-add-ink/30")} />
        <ArrowRightIcon className={cn("absolute -right-1 size-3.5", hostile ? "text-destructive/60" : "text-add-ink/60")} />
        <span className="relative flex gap-1 rounded-full bg-card px-1.5 py-0.5">
          <Pill n={x.object} kind="object" tip={`${plural(x.object, "objection", "objections")} from ${from} to ${to}`} />
          <Pill n={x.support} kind="support" tip={`${plural(x.support, "endorsement", "endorsements")} from ${from} for ${to}`} />
          <Pill n={x.evidence} kind="evidence" tip={`${plural(x.evidence, "piece of evidence", "pieces of evidence")} from ${from} on ${to}’s points`} />
          <Pill n={x.shifts} kind="shifts" tip={`${from}: ${plural(x.shifts, "change of mind", "changes of mind")} after ${to}’s arguments`} />
        </span>
      </span>
      <span className="flex w-[5.5rem] shrink-0 items-center justify-end gap-1.5 sm:w-24">
        <Name handle={x.to} className="truncate text-small" />
        <Avatar handle={x.to} size={22} />
      </span>
    </li>
  );
}

function TallyRow({ who, t }: { who: string; t: Tally }) {
  const cell = "tabular inline-flex items-center gap-1";
  return (
    <li className="flex items-center gap-2 text-small">
      <Avatar handle={who} size={20} />
      <Name handle={who} className="min-w-0 truncate" />
      <span className="ml-auto flex items-center gap-3 text-muted-foreground">
        <Tip tip={`Proposals: ${t.proposed}`}>
          <span className={cn(cell, !t.proposed && "opacity-40")}>
            <LightbulbIcon className="size-3.5 text-primary" />
            {t.proposed}
          </span>
        </Tip>
        <Tip tip={`Endorsements: ${t.support}`}>
          <span className={cn(cell, !t.support && "opacity-40")}>
            <ThumbsUpIcon className="size-3.5 text-add-ink" />
            {t.support}
          </span>
        </Tip>
        <Tip tip={`Objections: ${t.object}`}>
          <span className={cn(cell, !t.object && "opacity-40")}>
            <ShieldAlertIcon className="size-3.5 text-destructive" />
            {t.object}
          </span>
        </Tip>
        <Tip tip={`Changes of mind: ${t.shifts}`}>
          <span className={cn(cell, !t.shifts && "opacity-40")}>
            <RefreshCcwIcon className="size-3.5 text-shift" />
            {t.shifts}
          </span>
        </Tip>
      </span>
    </li>
  );
}

/** “Where we are”: the state of the argument in one sentence, the hottest point, and who pushed back on whom. */
function Standing({ table, room }: { table: TableState; room: RoomState }) {
  const goToRef = useStore((s) => s.goToRef);
  const composeDraft = useStore((s) => s.composeDraft);
  const driven = useStore((s) => s.snap?.driven);
  const live = table.options.filter((o) => isLive(table, o));
  const disputes = live.filter((o) => noteCounts(table, o.id).obj);
  // A settled point or a fact someone still objects to is a dispute, not common ground.
  const contested = [...table.settled, ...table.facts].filter((s) => disputeOf(table, s).length);
  const openQ = table.questions.filter((q) => q.status === "open");
  const agreed = table.settled.length + table.facts.filter((f) => !f.withdrawn).length + table.decisions.length - contested.length;
  const shifts = shiftsOf(table).length;
  const parts: Array<[string, string]> = [];
  if (agreed) parts.push([`Agreed on ${plural(agreed, "point", "points")}`, "text-meet-ink"]);
  const quarrels = disputes.length + contested.length;
  if (quarrels) parts.push([plural(quarrels, "open dispute", "open disputes"), "text-destructive"]);
  if (openQ.length) parts.push([plural(openQ.length, "unanswered question", "unanswered questions"), "text-amber"]);
  if (shifts) parts.push([plural(shifts, "change of mind", "changes of mind"), "text-shift"]);
  const settled = !quarrels && !openQ.length && !live.length;
  const hot = [...disputes].sort((a, b) => noteCounts(table, b.id).obj - noteCounts(table, a.id).obj || b.seq - a.seq)[0];
  const hotPoint = !hot ? contested.sort((a, b) => b.seq - a.seq)[0] : undefined;
  const waiting = !hot && !hotPoint ? openQ.find((q) => !table.options.some((o) => o.q === q.id && o.status === "open")) : undefined;
  const { tally, edges } = argumentMap(table);
  const lean = asymmetry(room, edges, tally);
  const order = [...room.agents.map((a) => a.id), ...[...tally.keys()].filter((k) => !room.agents.some((a) => a.id === k))];
  const people = order.filter((who) => tally.has(who));
  const name = (who: string) => participant(room, who).label;
  return (
    <section className="overflow-hidden rounded-3xl border border-border bg-card shadow-soft">
      <div className="grid @3xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4 p-5 sm:p-6">
          <span className="text-small font-semibold text-muted-foreground">Where we are</span>
          <h2 className="flex flex-wrap gap-x-6 gap-y-1.5 font-display text-title leading-tight font-semibold sm:text-display">
            {parts.length ? (
              parts.map(([text, tone]) => (
                <span key={text} className={cn("inline-flex items-center gap-2.5 whitespace-nowrap", tone)}>
                  <span className="size-2 shrink-0 rounded-full bg-current opacity-80" />
                  {text}
                </span>
              ))
            ) : (
              <span className="text-muted-foreground">Nothing on the table has been weighed yet</span>
            )}
          </h2>
          {settled && parts.length ? <p className="-mt-2 text-ui text-muted-foreground">Nothing is left open — everything on the table is closed.</p> : null}
          {hot ? (
            <button
              type="button"
              onClick={() => goToRef(hot.id)}
              className="group flex items-start gap-3 rounded-2xl border border-destructive/20 bg-destructive-soft/50 p-3 text-left transition hover:border-destructive/40"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-destructive/10 text-destructive">
                <FlameIcon className="size-4" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-meta font-semibold text-destructive">Hottest right now</span>
                <span className="text-body leading-snug font-semibold text-pretty">
                  <span className="mr-1 font-mono text-meta text-muted-foreground">{hot.id}</span>
                  {hot.title}
                </span>
                <span className="text-meta text-muted-foreground">
                  {(() => {
                    const { sup, obj } = noteCounts(table, hot.id);
                    return `${plural(obj, "objection", "objections")} against ${plural(sup, "endorsement", "endorsements")} · proposed by ${name(hot.by)}`;
                  })()}
                </span>
              </span>
              <ArrowRightIcon className="mt-2 size-4 shrink-0 text-destructive/60 transition group-hover:translate-x-0.5" />
            </button>
          ) : hotPoint ? (
            <button
              type="button"
              onClick={() => goToRef(hotPoint.id)}
              className="group flex items-start gap-3 rounded-2xl border border-destructive/20 bg-destructive-soft/50 p-3 text-left transition hover:border-destructive/40"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-destructive/10 text-destructive">
                <FlameIcon className="size-4" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-meta font-semibold text-destructive">Challenged</span>
                <span className="line-clamp-2 text-body leading-snug font-semibold text-pretty">
                  <span className="mr-1 font-mono text-meta text-muted-foreground">{hotPoint.id}</span>
                  {hotPoint.text}
                </span>
                <span className="text-meta text-muted-foreground">
                  {hotPoint.id.startsWith("F") ? "fact by" : "settled by"} {name(hotPoint.by)} · challenged by {disputeOf(table, hotPoint).map(name).join(", ")}
                </span>
              </span>
              <ArrowRightIcon className="mt-2 size-4 shrink-0 text-destructive/60 transition group-hover:translate-x-0.5" />
            </button>
          ) : waiting ? (
            <button
              type="button"
              onClick={() => goToRef(waiting.id)}
              className="group flex items-start gap-3 rounded-2xl border border-amber/25 bg-amber-soft/60 p-3 text-left transition hover:border-amber/50"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-amber/15 text-amber">
                <CircleHelpIcon className="size-4" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-meta font-semibold text-amber">Waiting for options</span>
                <span className="line-clamp-2 text-body leading-snug font-semibold text-pretty">{waiting.text}</span>
              </span>
              <ArrowRightIcon className="mt-2 size-4 shrink-0 text-amber/70 transition group-hover:translate-x-0.5" />
            </button>
          ) : null}
          {lean ? (
            <div className="flex flex-col gap-2 rounded-2xl border border-amber/30 bg-amber-soft/70 p-3.5">
              <div className="flex items-center gap-2 text-small font-semibold text-amber">
                <ScaleIcon className="size-4" />
                {lean.alone ? `Only ${name(lean.loud)} is arguing` : `${name(lean.quiet)} doesn’t push back on ${name(lean.loud)}`}
              </div>
              <p className="text-small leading-relaxed text-pretty text-foreground/85">
                {name(lean.loud)} — {plural(lean.objections, "objection", "objections")} to {name(lean.quiet)}’s points; from {name(lean.quiet)} in return — none
                {lean.shifts ? `, but ${plural(lean.shifts, "change of mind", "changes of mind")}` : ""}. Agreement without resistance can be mere politeness.
              </p>
              {driven ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 self-start rounded-lg bg-card text-small"
                  onClick={() =>
                    composeDraft(
                      `@${lean.quiet} ${name(lean.loud)} has objected ${plural(lean.objections, "time", "times")} already, and you haven’t objected once. What in ${name(lean.loud)}’s position do you actually disagree with? If you have an objection, put it on the table; if the agreement is real, explain what convinced you.`,
                    )
                  }
                >
                  <MessageSquareQuoteIcon className="size-3.5" />
                  Ask {name(lean.quiet)}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-col gap-4 border-t border-border bg-muted/40 p-5 sm:p-6 @3xl:border-t-0 @3xl:border-l">
          <div className="flex flex-col gap-2.5">
            <span className="text-small font-semibold text-muted-foreground">Who answered whom</span>
            {edges.length ? (
              <ul className="flex flex-col gap-1.5">
                {edges.slice(0, 5).map((x) => (
                  <EdgeRow key={`${x.from}→${x.to}`} x={x} room={room} />
                ))}
              </ul>
            ) : (
              <p className="text-small leading-relaxed text-muted-foreground">
                No one has answered anyone else’s proposal yet. When someone endorses, objects or changes their mind, arrows appear here.
              </p>
            )}
          </div>
          {people.length ? (
            <div className="flex flex-col gap-2 border-t border-border/70 pt-4">
              <ul className="flex flex-col gap-2">
                {people.map((who) => (
                  <TallyRow key={who} who={who} t={tally.get(who)!} />
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

// --- an option as a debate -------------------------------------------------------------------------

function NoteItem({ n }: { n: TableNote }) {
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

function Side({ title, Icon, tone, notes, empty }: { title: string; Icon: typeof CheckIcon; tone: string; notes: TableNote[]; empty: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? notes : notes.slice(0, 3);
  return (
    <div className={cn("flex min-w-0 flex-col gap-2 rounded-2xl p-2.5", tone)}>
      <div className="flex items-center gap-1.5 px-0.5 text-meta font-semibold">
        <Icon className="size-3.5" />
        {title}
        <span className="tabular ml-auto font-medium opacity-70">{notes.length || ""}</span>
      </div>
      {notes.length ? (
        shown.map((n) => <NoteItem key={n.id} n={n} />)
      ) : (
        <p className="px-0.5 pb-0.5 text-small text-muted-foreground/80">{empty}</p>
      )}
      {notes.length > 3 ? (
        <button type="button" onClick={() => setAll(!all)} className="self-start rounded-md px-1.5 py-0.5 text-meta font-medium text-primary hover:bg-card">
          {all ? "Collapse" : `${notes.length - 3} more`}
        </button>
      ) : null}
    </div>
  );
}

/** How the argument pulls: support one way, objections the other. */
function Tug({ table, o }: { table: TableState; o: TableOption }) {
  const notes = table.notes.filter((n) => n.target === o.id);
  const sup = notes.filter((n) => n.kind === "support");
  const obj = notes.filter((n) => n.kind === "object");
  if (!sup.length && !obj.length) return null;
  const faces = (list: TableNote[]) => [...new Set(list.map((n) => n.by))];
  const share = (sup.length / (sup.length + obj.length)) * 100;
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex -space-x-1.5">
        {faces(sup).map((who) => (
          <Avatar key={who} handle={who} size={20} className="ring-2 ring-card" />
        ))}
      </span>
      <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <span className="absolute inset-y-0 left-0 rounded-l-full bg-add-ink/75" style={{ width: `${share}%` }} />
        <span className="absolute inset-y-0 right-0 rounded-r-full bg-destructive/75" style={{ width: `${100 - share}%` }} />
        {sup.length && obj.length ? <span className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-card" style={{ left: `${share}%` }} /> : null}
      </div>
      <span className="flex -space-x-1.5">
        {faces(obj).map((who) => (
          <Avatar key={who} handle={who} size={20} className="ring-2 ring-card" />
        ))}
      </span>
    </div>
  );
}

function Shift({ c }: { c: TableItem }) {
  return (
    <div id={`ti-${c.id}`} className="flex scroll-mt-24 gap-2.5 rounded-xl border border-shift/20 bg-shift-soft/70 px-3 py-2">
      <RefreshCcwIcon className="mt-0.5 size-4 shrink-0 text-shift" />
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-meta">
          <Avatar handle={c.by} size={16} />
          <Name handle={c.by} />
          <span className="font-medium text-shift">changes their mind</span>
        </div>
        <Clamp max={96} more="More">
          <Markdown text={c.text} className="mt-0.5 text-ui" />
        </Clamp>
      </div>
    </div>
  );
}

function Actions({ id }: { id: string }) {
  const openDialog = useStore((s) => s.openDialog);
  const driven = useStore((s) => s.snap?.driven);
  if (!driven) return null;
  const form = (op: TableFormOp) => () => openDialog({ kind: "table-form", op, target: id });
  const btn = "h-8 rounded-lg px-2.5 text-small";
  return (
    <div className="flex flex-wrap items-center gap-1 border-t border-border/70 px-4 py-2.5">
      <Button variant="ghost" size="sm" className={cn(btn, "text-add-ink hover:bg-add hover:text-add-ink")} onClick={form("support")}>
        <ThumbsUpIcon className="size-3.5" />
        For
      </Button>
      <Button variant="ghost" size="sm" className={cn(btn, "text-destructive hover:bg-destructive-soft hover:text-destructive")} onClick={form("object")}>
        <ShieldAlertIcon className="size-3.5" />
        Against
      </Button>
      <Button variant="ghost" size="sm" className={cn(btn, "text-codex hover:bg-codex-soft hover:text-codex")} onClick={form("evidence")}>
        <MicroscopeIcon className="size-3.5" />
        Evidence
      </Button>
      <span className="flex-1" />
      <Button size="sm" className={btn} onClick={form("decide")}>
        <CheckIcon className="size-3.5" />
        Choose
      </Button>
    </div>
  );
}

function Debate({ o, table, room }: { o: TableOption; table: TableState; room: RoomState }) {
  const notes = table.notes.filter((n) => n.target === o.id).sort((a, b) => a.seq - b.seq);
  const sup = notes.filter((n) => n.kind === "support");
  const obj = notes.filter((n) => n.kind === "object");
  const ev = notes.filter((n) => n.kind === "evidence");
  const shifts = shiftsOf(table).filter((c) => c.target === o.id);
  const v = verdict(table, o);
  const live = isLive(table, o);
  const faded = !live && o.status !== "chosen";
  const author = participant(room, o.by);
  return (
    <article
      id={`opt-${o.id}`}
      // The band takes the author's shade directly: an inherited --claude/--codex would recolour everything in the card.
      style={{ borderLeftColor: inkColor(author) }}
      className={cn(
        "flex min-w-0 scroll-mt-24 flex-col overflow-hidden rounded-2xl border border-l-[3px] border-border bg-card shadow-soft",
        band[author.tone],
        o.status === "chosen" && "ring-2 ring-meet/40",
        faded && "opacity-70 saturate-50",
      )}
    >
      <div className="flex flex-col gap-2.5 p-4">
        <header className="flex flex-wrap items-center gap-2">
          <RefChip id={o.id} />
          <span className={cn("rounded-full px-2 py-0.5 text-micro font-semibold", v.cls)}>{v.label}</span>
          <span className="ml-auto inline-flex items-center gap-1.5 text-meta text-muted-foreground">
            proposed by
            <Avatar handle={o.by} size={18} />
            <Name handle={o.by} className="font-medium" />
          </span>
        </header>
        <h4 className={cn("text-lead leading-snug font-semibold text-balance", o.status === "withdrawn" && "line-through decoration-faint")}>{o.title}</h4>
        {o.body ? (
          <Clamp max={140} more="Details">
            <Markdown text={o.body} source={`o:${o.id}`} className="text-ui text-foreground/90" />
          </Clamp>
        ) : null}
        {o.file ? <FilePreview file={o.file} /> : null}
        <Tug table={table} o={o} />
      </div>
      {notes.length || shifts.length ? (
        <div className="flex flex-col gap-2.5 border-t border-border/70 bg-muted/30 p-3">
          {sup.length || obj.length ? (
            <div className="grid items-start gap-2.5 @2xl:grid-cols-2">
              <Side title="For" Icon={ThumbsUpIcon} tone="bg-add/55 text-add-ink" notes={sup} empty="No one has endorsed it yet." />
              <Side title="Against" Icon={ShieldAlertIcon} tone="bg-destructive-soft/70 text-destructive" notes={obj} empty="No objections." />
            </div>
          ) : null}
          {ev.length ? <Side title="Evidence" Icon={MicroscopeIcon} tone="bg-codex-soft/70 text-codex" notes={ev} empty="" /> : null}
          {shifts.map((c) => (
            <Shift key={c.id} c={c} />
          ))}
        </div>
      ) : live ? (
        <p className="border-t border-border/70 bg-muted/30 px-4 py-2.5 text-small text-muted-foreground">No one has answered this proposal yet.</p>
      ) : null}
      {live ? <Actions id={o.id} /> : null}
    </article>
  );
}

// --- questions -------------------------------------------------------------------------------------

function QuestionActions({ q, many }: { q: string; many?: boolean }) {
  const openDialog = useStore((s) => s.openDialog);
  const driven = useStore((s) => s.snap?.driven);
  if (!driven) return null;
  const btn =
    "flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl border border-dashed border-input px-3 text-small text-muted-foreground transition hover:border-primary/50 hover:bg-card hover:text-foreground";
  return (
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={() => openDialog({ kind: "table-form", op: "propose", q })} className={btn}>
        <PlusIcon className="size-4" />
        Your own option
      </button>
      <button type="button" onClick={() => openDialog({ kind: "table-form", op: "settle", q })} className={btn}>
        <BadgeCheckIcon className="size-4" />
        {many ? "Record a recommendation" : "Record an answer"}
      </button>
    </div>
  );
}

const STATUS: Record<TableQuestion["status"], { label: string; cls: string; Icon: typeof CheckIcon }> = {
  open: { label: "Open", cls: "bg-amber-soft text-amber", Icon: CircleHelpIcon },
  answered: { label: "Answered", cls: "bg-meet/10 text-meet-ink", Icon: BadgeCheckIcon },
  decided: { label: "Settled", cls: "bg-meet/10 text-meet-ink", Icon: GavelIcon },
};

/** A question's kind: one answer (its options exclude each other) or any number; the human can switch an open one. */
function AnswerKind({ q }: { q: TableQuestion }) {
  const post = useStore((s) => s.post);
  const driven = useStore((s) => s.snap?.driven);
  const label = q.many ? "Any number of answers" : "One answer";
  const cls = "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-micro font-medium";
  if (!driven || q.status !== "open") {
    return q.many ? (
      <span className={cn(cls, "bg-secondary text-secondary-foreground")}>
        <ListChecksIcon className="size-3" />
        {label}
      </span>
    ) : null;
  }
  return (
    <Tip tip={q.many ? "Make it one answer: choosing an option closes the question" : "Its options don't exclude each other: choosing one keeps the rest open"}>
      <button
        type="button"
        onClick={() => post("/table", { op: "edit", target: q.id, many: !q.many }).catch((e) => toast.error(e instanceof Error ? e.message : String(e)))}
        className={cn(cls, "transition hover:bg-accent hover:text-foreground", q.many ? "bg-secondary text-secondary-foreground" : "text-muted-foreground ring-1 ring-border")}
      >
        <ListChecksIcon className="size-3" />
        {label}
      </button>
    </Tip>
  );
}

/** The room's recommendation on a question: a settled point that names it, or names two or more of its options. */
function Recommendations({ q, table, room }: { q: TableQuestion; table: TableState; room: RoomState }) {
  const ids = new Set(table.options.filter((o) => o.q === q.id).map((o) => o.id));
  const points = table.settled.filter((s) => {
    if (s.withdrawn || s.id === q.answer) return false;
    if (s.q === q.id) return true;
    const named = new Set(s.text.match(/\bP\d+\b/g) ?? []);
    return [...named].filter((id) => ids.has(id)).length >= 2;
  });
  if (!points.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {points.map((s) => (
        <div key={s.id} className="flex gap-3 rounded-2xl bg-secondary/50 p-3.5 ring-1 ring-border">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-secondary text-secondary-foreground">
            <FootprintsIcon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-meta font-semibold text-muted-foreground">The room recommends</div>
            <Clamp max={120} more="Details">
              <Markdown text={s.text} className="text-body" />
            </Clamp>
            <div className="mt-1 flex items-center gap-1.5 text-meta text-faint">
              <RefChip id={s.id} />
              {participant(room, s.by).label}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** How a closed question was closed: the chosen option(s), or the settled answer. */
function Resolution({ q, table, room }: { q: TableQuestion; table: TableState; room: RoomState }) {
  if (q.many) {
    // Every option chosen so far, also while the question is still open.
    const chosen = table.decisions.filter((d) => d.q === q.id && table.options.find((o) => o.id === d.option)?.status === "chosen");
    if (!chosen.length) return null;
    return (
      <div className="flex flex-col gap-2 rounded-2xl bg-secondary/70 p-3.5 ring-1 ring-meet/20">
        {chosen.map((decision) => (
          <div key={decision.id} className="flex gap-3">
            <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-meet text-background">
              <CheckIcon className="size-3.5" strokeWidth={3} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5 text-body font-semibold">
                <RefChip id={decision.option} />
                {table.options.find((o) => o.id === decision.option)?.title ?? decision.option}
              </div>
              <div className="text-meta text-faint">
                decision #{decision.n} · {participant(room, decision.by).label}
                {decision.note ? ` — ${decision.note}` : ""}
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }
  const decision = q.status === "decided" ? table.decisions.filter((d) => d.q === q.id).at(-1) : undefined;
  const answer = q.status === "answered" ? table.settled.find((s) => s.id === q.answer) : undefined;
  if (!decision && !answer) return null;
  const chosen = decision ? table.options.find((o) => o.id === decision.option) : undefined;
  return (
    <div className="flex gap-3 rounded-2xl bg-secondary/70 p-3.5 ring-1 ring-meet/20">
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-meet text-background">
        {decision ? <CheckIcon className="size-4" strokeWidth={3} /> : <BadgeCheckIcon className="size-4" />}
      </span>
      <div className="min-w-0 flex-1">
        {decision ? (
          <>
            <div className="flex flex-wrap items-center gap-1.5 text-body font-semibold">
              <RefChip id={decision.option} />
              {chosen?.title ?? decision.option}
            </div>
            {decision.note ? (
              <Clamp max={96} more="Details">
                <Markdown text={decision.note} className="mt-1 text-ui text-muted-foreground" />
              </Clamp>
            ) : null}
            <div className="mt-1 text-meta text-faint">
              decision #{decision.n} · {participant(room, decision.by).label}
            </div>
          </>
        ) : answer ? (
          <>
            <Clamp max={120} more="Details">
              <Markdown text={answer.text} className="text-body font-medium" />
            </Clamp>
            <div className="mt-1 flex items-center gap-1.5 text-meta text-faint">
              <RefChip id={answer.id} />
              answer · {participant(room, answer.by).label}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function Question({ q, table, room }: { q: TableQuestion; table: TableState; room: RoomState }) {
  const flash = useStore((s) => s.flash);
  const options = table.options.filter((o) => o.q === q.id).sort((a, b) => a.seq - b.seq);
  const shifts = shiftsOf(table).filter((c) => c.target === q.id);
  const closed = q.status !== "open";
  const [show, setShow] = useState(!closed);
  useEffect(() => {
    if (!flash || !closed) return;
    const anchor = refAnchor(room, flash.ref);
    if (options.some((o) => anchor === `opt-${o.id}`)) setShow(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flash]);
  const live = options.filter((o) => o.status === "open");
  const contested = live.filter((o) => noteCounts(table, o.id).obj).length;
  const st = STATUS[q.status];
  return (
    <section id={`q-${q.id}`} className={cn("flex scroll-mt-6 flex-col gap-3 rounded-3xl border border-border p-3 sm:p-4", closed ? "bg-background/40" : "bg-background/75")}>
      <header className="flex flex-col gap-2 px-1">
        <div className="flex flex-wrap items-center gap-2 text-meta text-muted-foreground">
          <RefChip id={q.id} />
          <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-micro font-semibold", st.cls)}>
            <st.Icon className="size-3" />
            {st.label}
          </span>
          <span className="inline-flex items-center gap-1">
            asked by <Avatar handle={q.by} size={16} /> <Name handle={q.by} className="font-medium" />
          </span>
          <AnswerKind q={q} />
          {!closed ? (
            <span className="tabular ml-auto">
              {live.length ? `${plural(live.length, "option", "options")}${q.many && live.length < options.length ? " still open" : ""}` : "no options yet"}
              {contested ? <span className="text-destructive"> · {contested} challenged</span> : null}
            </span>
          ) : null}
        </div>
        <Markdown text={q.text} className={cn("leading-snug font-semibold tracking-tight text-balance", closed ? "text-lead" : "text-title")} />
      </header>
      {closed || q.many ? <Resolution q={q} table={table} room={room} /> : null}
      <Recommendations q={q} table={table} room={room} />
      {shifts.map((c) => (
        <Shift key={c.id} c={c} />
      ))}
      {closed && options.length ? (
        <button
          type="button"
          onClick={() => setShow(!show)}
          className="inline-flex items-center gap-1 self-start rounded-lg px-2 py-1 text-small font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronDownIcon className={cn("size-4 transition", show && "rotate-180")} />
          {show ? "Hide options" : `How they got here · ${plural(options.length, "option", "options")}`}
        </button>
      ) : null}
      {/* An open question always shows its options, also one reopened after it was closed. */}
      {(show || !closed) && options.length ? (
        <div className="flex flex-col gap-3">
          {options.map((o) => (
            <Debate key={o.id} o={o} table={table} room={room} />
          ))}
        </div>
      ) : null}
      {!closed ? <QuestionActions q={q.id} many={q.many} /> : null}
    </section>
  );
}

// --- common ground ---------------------------------------------------------------------------------

function RailSection({ id, title, Icon, aside, children }: { id: string; title: string; Icon: typeof CheckIcon; aside?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="flex scroll-mt-6 flex-col gap-3 border-t border-border/70 pt-4 first:border-t-0 first:pt-0">
      <h3 className="flex items-center gap-1.5 text-small font-semibold text-muted-foreground">
        <Icon className="size-3.5" />
        {title}
        {aside ? <span className="ml-auto tracking-normal normal-case">{aside}</span> : null}
      </h3>
      {children}
    </section>
  );
}

function CommonGround({ table, room }: { table: TableState; room: RoomState }) {
  const post = useStore((s) => s.post);
  const decisions = [...table.decisions].reverse();
  const ground = [...table.settled.map((s) => ({ ...s, fact: false })), ...table.facts.map((f) => ({ ...f, fact: true }))].sort((a, b) => a.seq - b.seq);
  const shifts = shiftsOf(table);
  const done = table.next.filter((n) => n.done).length;
  const empty = !ground.length && !shifts.length && !decisions.length && !table.next.length;
  return (
    <aside className="flex flex-col gap-4 rounded-3xl border border-border bg-card p-4 shadow-soft sm:p-5">
      <header className="flex flex-col gap-0.5">
        <h2 className="font-display text-title font-semibold">Common ground</h2>
        <p className="text-small text-muted-foreground">What no longer needs proving.</p>
      </header>
      {empty ? (
        <p className="rounded-2xl border border-dashed border-border px-3.5 py-3 text-small leading-relaxed text-muted-foreground">
          Nothing is agreed yet. As soon as the agents agree on something, it appears here.
        </p>
      ) : null}
      {decisions.length ? (
        <RailSection id="board-decisions" title="Decisions" Icon={GavelIcon} aside={<span className="tabular text-faint">{decisions.length}</span>}>
          <ol className="flex flex-col gap-3">
            {decisions.map((d) => {
              const o = table.options.find((x) => x.id === d.option);
              return (
                <li key={d.id} className="flex gap-2.5">
                  <span className="tabular mt-0.5 grid h-5 min-w-5 shrink-0 place-items-center rounded-md bg-meet px-1 text-micro font-bold text-background">{d.n}</span>
                  <div className="min-w-0 text-ui">
                    <div className="leading-snug font-semibold">
                      <RefChip id={d.option} className="mr-1 align-[1px]" />
                      {o?.title ?? d.option}
                    </div>
                    <div className="mt-0.5 text-meta text-faint">{participant(room, d.by).label}</div>
                  </div>
                </li>
              );
            })}
          </ol>
        </RailSection>
      ) : null}
      {ground.length ? (
        <RailSection id="board-settled" title="Settled and facts" Icon={PinIcon} aside={<span className="tabular text-faint">{ground.length}</span>}>
          <ul className="flex flex-col gap-3">
            {ground.map((s) => (
              <li key={s.id} id={`ti-${s.id}`} className="flex scroll-mt-24 gap-2.5">
                {s.fact ? (
                  <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded bg-codex-soft font-mono text-micro font-bold text-codex" title="Fact">
                    F
                  </span>
                ) : (
                  <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary/70 ring-4 ring-primary/10" />
                )}
                <div className={cn("min-w-0", s.withdrawn && "opacity-60")}>
                  <Clamp max={88} more="More">
                    <Markdown text={s.text} className={cn("text-ui", s.withdrawn && "line-through decoration-faint")} />
                  </Clamp>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-meta text-faint">
                    {s.q ? (
                      <span className="inline-flex items-center gap-1 text-primary">
                        {table.questions.find((x) => x.id === s.q)?.many ? "recommendation for" : "answer to"} <RefChip id={s.q} />
                      </span>
                    ) : null}
                    {s.fact ? (s.withdrawn ? "fact · withdrawn" : "fact") : null}
                    <span>{participant(room, s.by).label}</span>
                    {disputeOf(table, s).length ? (
                      <span className="inline-flex items-center gap-1 font-medium text-destructive">
                        <ShieldAlertIcon className="size-3" />
                        challenged by {disputeOf(table, s).map((who) => participant(room, who).label).join(", ")}
                      </span>
                    ) : null}
                  </div>
                  {table.notes.some((n) => n.target === s.id) ? (
                    <div className="mt-2 flex flex-col gap-1.5">
                      {table.notes
                        .filter((n) => n.target === s.id)
                        .map((n) => (
                          <div key={n.id} className={cn("rounded-xl", n.kind === "object" ? "ring-1 ring-destructive/25" : "")}>
                            <NoteItem n={n} />
                          </div>
                        ))}
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </RailSection>
      ) : null}
      {shifts.length ? (
        <RailSection id="board-shifts" title="Changed their minds" Icon={RefreshCcwIcon} aside={<span className="tabular text-faint">{shifts.length}</span>}>
          <ul className="flex flex-col gap-3">
            {shifts.map((c) => (
              <li key={c.id} className="flex gap-2.5">
                <Avatar handle={c.by} size={18} className="mt-0.5" />
                <div className="min-w-0">
                  <Clamp max={88} more="More">
                    <Markdown text={c.text} className="text-ui" />
                  </Clamp>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-meta text-faint">
                    <span className="font-medium text-shift">{participant(room, c.by).label}</span>
                    {c.target ? (
                      <span className="inline-flex items-center gap-1">
                        on <RefChip id={c.target} />
                      </span>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </RailSection>
      ) : null}
      {table.next.length ? (
        <RailSection
          id="board-next"
          title="Next steps"
          Icon={FootprintsIcon}
          aside={
            <span className="tabular text-faint">
              {done} / {table.next.length}
            </span>
          }
        >
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${(done / table.next.length) * 100}%` }} />
          </div>
          <ul className="flex flex-col gap-2">
            {table.next.map((n) => (
              <li key={n.id} id={`ti-${n.id}`} className={cn("flex scroll-mt-24 gap-2.5", n.done && "text-muted-foreground")}>
                <button
                  type="button"
                  disabled={n.done}
                  aria-label={n.done ? "Done" : "Mark done"}
                  title={n.done ? "Done" : "Mark done"}
                  onClick={() => post("/table", { op: "done", target: n.id }).catch((e) => toast.error(e instanceof Error ? e.message : String(e)))}
                  className={cn(
                    "mt-0.5 grid size-4 shrink-0 place-items-center rounded border transition",
                    n.done ? "border-primary bg-primary text-primary-foreground" : "border-input bg-card hover:border-primary",
                  )}
                >
                  {n.done ? <CheckIcon className="size-3" strokeWidth={3} /> : null}
                </button>
                <div className="min-w-0">
                  <Markdown text={n.text} className={cn("text-ui", n.done && "line-through decoration-faint")} />
                  <div className="text-meta text-faint">
                    {participant(room, n.by).label}
                    {n.doneBy && n.doneBy !== n.by ? ` · done by ${participant(room, n.doneBy).label}` : ""}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </RailSection>
      ) : null}
    </aside>
  );
}

// --- frame -----------------------------------------------------------------------------------------

/**
 * The steps the table is made of, so a first look explains it: one line from the question to where
 * the voices meet. Wide, a timeline; in a popover or on a phone, a list.
 */
function Flow({ className, vertical }: { className?: string; vertical?: boolean }) {
  const steps: Array<[string, string, typeof CheckIcon, string]> = [
    ["Question", "what needs deciding", CircleHelpIcon, "text-amber bg-amber-soft"],
    ["Options", "real alternatives", LightbulbIcon, "text-foreground bg-secondary"],
    ["For and against", "arguments and evidence", ScaleIcon, "text-codex bg-codex-soft"],
    ["Change of mind", "when an argument convinced", RefreshCcwIcon, "text-shift bg-shift-soft"],
    ["Decision", "an option or a conclusion", GavelIcon, "text-background bg-meet"],
  ];
  const list = (
    <ol className={cn("flex flex-col gap-2", !vertical && "sm:hidden", className)}>
      {steps.map(([label, hint, Icon, tone]) => (
        <li key={label} className="flex items-center gap-2.5 rounded-xl border border-border bg-card py-1.5 pr-3 pl-1.5">
          <span className={cn("grid size-6 shrink-0 place-items-center rounded-lg", tone)}>
            <Icon className="size-3.5" />
          </span>
          <span className="flex flex-col text-left leading-tight">
            <b className="text-small font-semibold">{label}</b>
            <span className="text-micro text-muted-foreground">{hint}</span>
          </span>
        </li>
      ))}
    </ol>
  );
  if (vertical) return list;
  return (
    <>
      {list}
      <ol className={cn("relative hidden w-full max-w-[640px] grid-cols-5 gap-2 sm:grid", className)}>
        <span aria-hidden className="absolute top-4 right-[10%] left-[10%] h-px bg-linear-to-r from-border via-border to-meet/60" />
        {steps.map(([label, hint, Icon, tone]) => (
          <li key={label} className="relative flex flex-col items-center gap-1.5 text-center">
            <span className={cn("grid size-8 place-items-center rounded-xl ring-4 ring-background", tone)}>
              <Icon className="size-4" />
            </span>
            <b className="text-small leading-tight font-semibold text-balance">{label}</b>
            <span className="text-micro leading-snug text-balance text-muted-foreground">{hint}</span>
          </li>
        ))}
      </ol>
    </>
  );
}

function Help() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 rounded-lg px-2 text-small text-muted-foreground">
          <CircleHelpIcon className="size-4" />
          How to read
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-80 flex-col gap-3 rounded-2xl p-4">
        <p className="text-small leading-relaxed text-pretty">
          The table is a map of the argument. The agents put questions, options and arguments here themselves; you see where they agree, where they still disagree and who convinced whom.
        </p>
        <Flow vertical />
        <p className="text-meta leading-relaxed text-muted-foreground">You can choose an option, add an argument or record an answer — the agents see it on their next turn.</p>
      </PopoverContent>
    </Popover>
  );
}

function Toolbar() {
  const openDialog = useStore((s) => s.openDialog);
  const driven = useStore((s) => s.snap?.driven);
  if (!driven) return null;
  const items: Array<[TableFormOp, string, typeof PlusIcon]> = [
    ["ask", "Question", CircleHelpIcon],
    ["propose", "Option", LightbulbIcon],
    ["settle", "Conclusion", PinIcon],
    ["next", "Step", FootprintsIcon],
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {items.map(([op, label, Icon]) => (
        <Button key={op} variant="outline" size="sm" className="h-8 rounded-lg bg-card text-small" onClick={() => openDialog({ kind: "table-form", op })}>
          <Icon className="size-3.5" />
          {label}
        </Button>
      ))}
    </div>
  );
}

function Empty() {
  return (
    <EmptyState
      icon={ScaleIcon}
      title="The table is empty"
      large
      text="When a real choice comes up in the conversation, the agents put it here: the question, the options, and under each one who is for, who is against and what proves it. You see where they agree, where they disagree and who convinced whom — at a glance, not in the feed."
    >
      <Flow className="mx-auto my-3" />
      <p className="text-small text-faint">The agents do this themselves. Or you start:</p>
      <Toolbar />
    </EmptyState>
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
  const empty = !table.questions.length && !table.options.length && !table.settled.length && !table.facts.length && !table.next.length && !shiftsOf(table).length;
  const open = table.questions.filter((q) => q.status === "open").sort((a, b) => a.seq - b.seq);
  const closed = table.questions.filter((q) => q.status !== "open").sort((a, b) => b.seq - a.seq);
  const loose = table.options.filter((o) => !o.q).sort((a, b) => a.seq - b.seq);
  return (
    <div ref={host} className="scroll-thin min-h-0 flex-1 overflow-y-auto bg-canvas">
      {empty ? (
        <Empty />
      ) : (
        <div className="@container mx-auto flex w-full max-w-[1320px] flex-col gap-5 px-3 pt-5 pb-10 sm:px-6">
          <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="flex items-center gap-2 font-display text-display leading-none font-semibold">
              <ScaleIcon className="size-5 text-primary" />
              Table
            </h1>
            <Help />
            <span className="flex-1" />
            <Toolbar />
          </header>
          <Standing table={table} room={room} />
          <div className="grid items-start gap-5 @4xl:grid-cols-[minmax(0,1fr)_minmax(280px,340px)]">
            <div id="board-open" className="flex min-w-0 scroll-mt-6 flex-col gap-4">
              {open.map((q) => (
                <Question key={q.id} q={q} table={table} room={room} />
              ))}
              {loose.length ? (
                <section className="flex flex-col gap-3 rounded-3xl border border-border bg-background/75 p-3 sm:p-4">
                  <header className="px-1 text-small text-muted-foreground">
                    <b className="font-semibold text-foreground">Proposals without a question</b> · you can choose them directly
                  </header>
                  {loose.map((o) => (
                    <Debate key={o.id} o={o} table={table} room={room} />
                  ))}
                </section>
              ) : null}
              {!open.length && !loose.length ? (
                <div className="flex items-center gap-3 rounded-3xl border border-dashed border-border px-5 py-4 text-ui text-muted-foreground">
                  <CheckIcon className="size-4 text-primary" />
                  No open questions — everything on the table is closed.
                </div>
              ) : null}
              {closed.length ? (
                <>
                  <h2 className="mt-2 flex items-center gap-2 px-1 text-small font-semibold text-muted-foreground">
                    <GavelIcon className="size-3.5" />
                    Closed questions
                  </h2>
                  {closed.map((q) => (
                    <Question key={q.id} q={q} table={table} room={room} />
                  ))}
                </>
              ) : null}
            </div>
            <CommonGround table={table} room={room} />
          </div>
        </div>
      )}
    </div>
  );
}
