import type { WorkflowCheck, WorkflowRun } from "@agora/workflow-types";
import { CheckIcon, ChevronRightIcon, CircleHelpIcon, CrosshairIcon, FlagIcon, GavelIcon, HandshakeIcon, SparklesIcon, TrophyIcon, XIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { Markdown } from "@/components/md/Markdown";
import { VizCard } from "@/components/md/Visual";
import { cn } from "@/lib/utils";
import { criteriaGrid, debateDigest, type DebateArgument, type DebateDigest, type DebateSide, type Standing } from "@/lib/workflow-digest";

/**
 * The run at a glance, drawn from its typed submissions: the reader follows
 * the shape of the reasoning first and opens the prose only where it matters.
 */

const SIDE = {
  pro: { mark: "+", name: "For", dot: "bg-[var(--viz-1)]", soft: "bg-[var(--viz-1)]/10", ring: "ring-[var(--viz-1)]/30" },
  con: { mark: "−", name: "Against", dot: "bg-[var(--viz-2)]", soft: "bg-[var(--viz-2)]/10", ring: "ring-[var(--viz-2)]/30" },
} as const;
const pct = (n: number) => `${Math.round(n * 100)}%`;
const PHASE_SHORT = { openings: "opening", new_arguments: "new args", rebuttal: "rebuttal" } as const;

function Kicker({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <h3 className="mb-2 flex items-center gap-1.5 text-micro font-semibold uppercase tracking-wide text-faint">
      {icon}
      {children}
    </h3>
  );
}

function Trajectory({ side }: { side: DebateSide }) {
  if (!side.confidence.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 text-micro tabular-nums text-muted-foreground" title="The advocate's own confidence in the assigned case">
      {side.confidence.map((c, i) => {
        const prev = side.confidence[i - 1]?.value;
        const moved = prev === undefined ? 0 : c.value - prev;
        return (
          <span key={c.phase} className="inline-flex items-center gap-1">
            {i ? <ChevronRightIcon className="size-3 text-faint" /> : null}
            <span className="rounded-md bg-muted px-1.5 py-0.5">
              <span className="text-faint">{PHASE_SHORT[c.phase]}</span> <strong className="font-semibold text-foreground">{pct(c.value)}</strong>
              {Math.abs(moved) >= 0.05 ? <span className={moved < 0 ? "text-del-ink" : "text-human-ink"}> {moved > 0 ? "▲" : "▼"}</span> : null}
            </span>
          </span>
        );
      })}
    </div>
  );
}

function ArgumentRow({ argument, role }: { argument: DebateArgument; role: "pro" | "con" }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={cn("rounded-xl ring-1 ring-border transition", open ? "bg-card" : "hover:bg-accent/50", argument.conceded && "ring-human/40")}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-start gap-2 px-2.5 py-2 text-left">
        <span className="mt-px shrink-0 font-mono text-micro text-faint">{argument.id}</span>
        <span className={cn("min-w-0 flex-1 text-small leading-snug", argument.conceded && "font-medium")}>{argument.headline}</span>
        <span className="flex shrink-0 items-center gap-1">
          {argument.stage === "new" ? <span className="rounded-full bg-shift-soft px-1.5 text-micro text-shift">new</span> : null}
          {argument.conceded ? (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-human-soft px-1.5 text-micro text-human-ink" title={`Conceded by ${argument.conceded.by}`}>
              <HandshakeIcon className="size-3" /> conceded
            </span>
          ) : null}
          <ChevronRightIcon className={cn("size-3.5 text-faint transition-transform", open && "rotate-90")} />
        </span>
      </button>
      {open ? (
        <div className={cn("mx-2.5 mb-2.5 rounded-lg px-3 py-2 text-small", SIDE[role].soft)}>
          <Markdown text={argument.text} literalHtml />
          {argument.conceded ? (
            <p className="mt-2 border-t border-border pt-2 text-meta text-human-ink">
              <strong>{argument.conceded.by} conceded:</strong> {argument.conceded.reason}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function SideColumn({ side }: { side: DebateSide }) {
  const s = SIDE[side.role];
  const accepted = side.acceptance.at(-1);
  return (
    <div className="min-w-0 space-y-2.5">
      <div className="flex items-start gap-2.5">
        <span className={cn("grid size-7 shrink-0 place-items-center rounded-full text-small font-bold text-white dark:text-black", s.dot)}>{s.mark}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 text-meta text-muted-foreground">
            <span className="font-semibold text-foreground">{s.name}</span>
            <span>{side.label}</span>
            {accepted !== undefined ? (
              <span className={cn("inline-flex items-center gap-0.5", accepted ? "text-human-ink" : "text-amber-ink")} title="Whether this side accepted the opponent's restatement of its case">
                {accepted ? <CheckIcon className="size-3" /> : <XIcon className="size-3" />}
                {accepted ? "fairly restated" : "restatement disputed"}
                {side.acceptance.length > 1 ? ` · ${side.acceptance.length} tries` : ""}
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-ui font-medium leading-snug">{side.positionNow ?? side.position}</p>
          {side.positionNow ? <p className="mt-0.5 text-meta text-faint line-through decoration-faint/50">{side.position}</p> : null}
        </div>
      </div>
      <Trajectory side={side} />
      <ol className="!list-none !pl-0 space-y-1.5">
        {side.arguments.map((a) => (
          <ArgumentRow key={a.id} argument={a} role={side.role} />
        ))}
      </ol>
    </div>
  );
}

const STATUS_CELL: Record<WorkflowCheck["status"], { cls: string; icon: ReactNode; name: string }> = {
  passed: { cls: "bg-human-soft text-human-ink", icon: <CheckIcon className="size-3.5" />, name: "passed" },
  failed: { cls: "bg-del text-del-ink", icon: <XIcon className="size-3.5" />, name: "failed" },
  unknown: { cls: "bg-amber-soft text-amber-ink", icon: <CircleHelpIcon className="size-3.5" />, name: "unknown" },
};

function CheckCounts({ counts }: { counts: Record<WorkflowCheck["status"], number> }) {
  const total = counts.passed + counts.failed + counts.unknown;
  if (!total) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-micro tabular-nums text-muted-foreground">
      <span className="flex h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        {(["passed", "unknown", "failed"] as const).map((k) => (counts[k] ? <span key={k} className={cn("h-full", k === "passed" ? "bg-human" : k === "failed" ? "bg-destructive" : "bg-amber")} style={{ width: `${(counts[k] / total) * 100}%` }} /> : null))}
      </span>
      {counts.passed}✓ {counts.unknown}? {counts.failed}✗
    </span>
  );
}

function Judges({ digest }: { digest: DebateDigest }) {
  if (!digest.judges.length) return null;
  return (
    <div>
      <Kicker icon={<GavelIcon className="size-3" />}>The bench</Kicker>
      <div className="space-y-2">
        {digest.judges.map((judge, i) => {
          const lean = judge.leaning;
          const at = !lean || lean.side === "undecided" ? 50 : 50 + (lean.side === "pro" ? -1 : 1) * 50 * (lean.confidence ?? 0.6);
          return (
            <div key={i} className="grid gap-x-3 gap-y-1 rounded-xl bg-muted/50 px-3 py-2.5 @min-[40rem]/workflow:grid-cols-[minmax(0,1fr)_14rem]">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-meta">
                  <span className="font-semibold">{judge.label}</span>
                  <CheckCounts counts={judge.counts} />
                </div>
                <p className="mt-0.5 text-small leading-snug text-muted-foreground">{judge.summary}</p>
              </div>
              {lean ? (
                <div className="self-center" title={lean.side === "undecided" ? "Undecided" : `Leans ${lean.side === "pro" ? "for" : "against"}${lean.confidence !== undefined ? ` (${pct(lean.confidence)})` : ""}`}>
                  <div className="relative h-4">
                    <span className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-gradient-to-r from-[var(--viz-1)]/35 via-border to-[var(--viz-2)]/35" />
                    <span className="absolute left-1/2 top-0 bottom-0 w-px bg-border" />
                    <span className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card bg-foreground shadow-soft" style={{ left: `${at}%` }} />
                  </div>
                  <div className="flex justify-between text-micro text-faint">
                    <span>for</span>
                    <span>{lean.side === "undecided" ? "undecided" : `leans ${lean.side === "pro" ? "for" : "against"}`}</span>
                    <span>against</span>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The debate as a map: two columns of headline arguments, what was conceded, where it still splits, and what would settle it. */
export function DebateMap({ run }: { run: WorkflowRun }) {
  const digest = useMemo(() => debateDigest(run), [run]);
  if (!digest || digest.sides.length < 2) return null;
  const cruxes = digest.sides.filter((s) => s.remainingDisagreement || s.decisiveTest);
  const conceded = digest.sides.reduce((n, s) => n + s.concessionsMade, 0);
  const argued = digest.sides.reduce((n, s) => n + s.arguments.length, 0);
  return (
    <section className="debate-map rounded-2xl border border-border bg-card p-4 shadow-edge" aria-label="The case at a glance">
      <header className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-small font-semibold">The case at a glance</h2>
        <span className="text-meta text-faint">
          {argued} arguments · {conceded} conceded ·{" "}
          {digest.gate === "passed" ? "both sides fairly restated" : digest.gate === "failed" ? "restatement never agreed — no rebuttals" : "restatement pending"}
        </span>
      </header>
      <div className="grid items-start gap-4 @min-[44rem]/workflow:grid-cols-2">
        {digest.sides.map((side) => (
          <SideColumn key={side.participantId} side={side} />
        ))}
      </div>
      {cruxes.length ? (
        <div className="mt-4 border-t border-border pt-3">
          <Kicker icon={<CrosshairIcon className="size-3" />}>Where it still splits — and what would settle it</Kicker>
          <div className="grid gap-2 @min-[44rem]/workflow:grid-cols-2">
            {cruxes.map((side) => (
              <div key={side.participantId} className={cn("rounded-xl px-3 py-2.5 ring-1", SIDE[side.role].ring)}>
                <p className="flex items-center gap-1.5 text-micro font-semibold text-muted-foreground">
                  <span className={cn("size-2 rounded-full", SIDE[side.role].dot)} />
                  {SIDE[side.role].name} · {side.label}
                </p>
                {side.remainingDisagreement ? <p className="mt-1 text-small leading-snug">{side.remainingDisagreement}</p> : null}
                {side.decisiveTest ? (
                  <p className="mt-1.5 flex gap-1.5 text-meta text-muted-foreground">
                    <FlagIcon className="mt-0.5 size-3 shrink-0" />
                    <span><strong className="font-semibold text-foreground">Decisive test:</strong> {side.decisiveTest}</span>
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {digest.judges.length ? (
        <div className="mt-4 border-t border-border pt-3">
          <Judges digest={digest} />
        </div>
      ) : null}
    </section>
  );
}

/** Criteria down, reviews across: how each check moved from one round to the next. */
export function CriteriaGridView({ run }: { run: WorkflowRun }) {
  const grid = useMemo(() => criteriaGrid(run), [run]);
  if (!grid || !grid.columns.length) return null;
  return (
    <div className="scroll-thin mb-5 overflow-x-auto">
      <table className="w-full border-separate border-spacing-[3px] text-meta">
        <thead>
          <tr>
            <th className="text-left font-medium text-faint">Criterion</th>
            {grid.columns.map((c, i) => (
              <th key={i} className="min-w-12 px-1 text-center font-medium text-faint" title={`${c.label} · round ${c.attempt}`}>
                <span className="block truncate">{grid.columns.length > 4 ? `R${c.attempt}` : c.label}</span>
                {grid.columns.length <= 4 && run.mode === "verification" ? <span className="block text-micro font-normal">round {c.attempt}</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.criteria.map((criterion, row) => (
            <tr key={criterion}>
              <th scope="row" className="max-w-64 py-1 pr-2 text-left font-normal text-foreground">
                <span className="line-clamp-2" title={criterion}>{criterion}</span>
              </th>
              {grid.columns.map((c, i) => {
                const status = c.statuses[row];
                const cell = status ? STATUS_CELL[status] : null;
                return (
                  <td key={i} className={cn("rounded-md text-center", cell?.cls ?? "bg-muted text-faint")} title={`${c.label}: ${cell?.name ?? "not checked"}`}>
                    <span className="inline-grid h-6 place-items-center">{cell?.icon ?? "–"}</span>
                    <span className="sr-only">{cell?.name ?? "not checked"}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Peer standings (Borda points from the anonymous rankings), with each answer's headline and its own claims on open. */
export function Standings({ rows, title, unit }: { rows: Standing[]; title: string; unit: string }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!rows.length) return null;
  const ranked = rows.some((r) => r.possible > 0);
  const max = Math.max(1, ...rows.map((r) => r.possible));
  return (
    <section className="mb-5 rounded-2xl border border-border bg-card p-4 shadow-edge" aria-label={title}>
      <header className="mb-3 flex flex-wrap items-center gap-x-3">
        <h2 className="flex items-center gap-1.5 text-small font-semibold">
          {ranked ? <TrophyIcon className="size-3.5 text-faint" /> : <SparklesIcon className="size-3.5 text-faint" />}
          {title}
        </h2>
        <span className="text-meta text-faint">{ranked ? `points from anonymous rankings · ${unit}` : `each ${unit} in one line`}</span>
      </header>
      <ol className="!list-none !pl-0 space-y-1.5">
        {rows.map((row, i) => (
          <li key={row.alias}>
            <button type="button" onClick={() => setOpen(open === row.alias ? null : row.alias)} aria-expanded={open === row.alias} className="grid w-full grid-cols-[1.5rem_minmax(0,1fr)] items-start gap-x-2 rounded-xl px-2 py-1.5 text-left hover:bg-accent/50">
              <span className="pt-px font-mono text-meta tabular-nums text-faint">{String(i + 1).padStart(2, "0")}</span>
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-x-2 text-meta">
                  <span className="font-semibold">{row.alias}</span>
                  {row.firsts ? <span className="text-micro text-human-ink">ranked first ×{row.firsts}</span> : null}
                </span>
                {ranked ? (
                  <span className="mt-1 flex items-center gap-2">
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <span className="block h-full rounded-full bg-[var(--viz-1)]" style={{ width: `${(row.points / max) * 100}%` }} />
                    </span>
                    <span className="w-14 text-right text-micro tabular-nums text-muted-foreground">{row.points}/{row.possible} pts</span>
                  </span>
                ) : null}
                <span className="mt-1 block text-small leading-snug text-muted-foreground">{row.claims?.[0]?.text ?? row.headline}</span>
              </span>
            </button>
            {open === row.alias && row.claims ? (
              <div className="ml-8 mt-1">
                <VizCard spec={{ kind: "claims", claims: row.claims }} bare />
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
