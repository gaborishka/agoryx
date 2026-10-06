import { parseViz, vizDecisionReply, vizText, type VizCell, type VizClaim, type VizSpec, type VizStepStatus, type VizTone } from "@agora/visuals";
import {
  BanIcon,
  BarChart3Icon,
  CheckIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleHelpIcon,
  CircleIcon,
  Code2Icon,
  ColumnsIcon,
  GaugeIcon,
  ListChecksIcon,
  ListTreeIcon,
  MinusIcon,
  PlusIcon,
  ScaleIcon,
  SkipForwardIcon,
  SplitIcon,
  XIcon,
} from "lucide-react";
import { memo, type MouseEvent, type ReactNode, useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
// A claim's detail is markdown. Markdown draws ```viz fences with this file: the two refer to each other only at render time.
import { Markdown } from "./Markdown";

/**
 * A ```viz fence drawn as a native card. Every kind keeps its words in text
 * ink and its identity in a mark beside them, so nothing is carried by colour
 * alone, and every card can show the plain reading it was drawn from.
 */


const KIND_ICON: Record<VizSpec["kind"], typeof ListTreeIcon> = {
  claims: ListTreeIcon,
  compare: ColumnsIcon,
  chart: BarChart3Icon,
  stats: GaugeIcon,
  steps: ListChecksIcon,
  stance: ScaleIcon,
  tradeoff: SplitIcon,
  decision: CircleHelpIcon,
};

/** What an untitled card is, named in its header so the reader knows what kind of thing it is before reading it. */
const KIND_NAME: Record<VizSpec["kind"], string> = {
  claims: "Key points",
  compare: "Comparison",
  chart: "Chart",
  stats: "At a glance",
  steps: "Plan",
  stance: "Positions",
  tradeoff: "Trade-offs",
  decision: "Your call",
};

const TONE_MARK: Record<VizTone, string> = {
  pro: "bg-[var(--viz-1)]",
  con: "bg-[var(--viz-2)]",
  good: "bg-human",
  bad: "bg-destructive",
  warn: "bg-amber",
  info: "bg-[var(--viz-3)]",
  neutral: "bg-faint/60",
};
const TONE_GLYPH: Record<VizTone, string> = { pro: "+", con: "−", good: "✓", bad: "✗", warn: "!", info: "i", neutral: "·" };
const TONE_NAME: Record<VizTone, string> = { pro: "for", con: "against", good: "holds", bad: "fails", warn: "risk", info: "note", neutral: "" };
const SERIES = ["var(--viz-1)", "var(--viz-2)", "var(--viz-3)", "var(--viz-4)", "var(--viz-5)", "var(--viz-6)"];

function ToneMark({ tone, className }: { tone?: VizTone; className?: string }) {
  if (!tone) return <span className={cn("mt-[0.45em] size-1.5 shrink-0 rounded-full bg-faint/50", className)} aria-hidden />;
  return (
    <span
      title={TONE_NAME[tone]}
      className={cn("mt-[0.2em] grid size-4 shrink-0 place-items-center rounded-full text-[10px] font-bold leading-none text-white dark:text-black", TONE_MARK[tone], className)}
    >
      {TONE_GLYPH[tone]}
    </span>
  );
}

/** A small meter for 0..1 confidence, with its number: the bar alone would be colour-only. */
function Confidence({ value }: { value: number }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-micro tabular-nums text-faint" title={`Confidence ${Math.round(value * 100)}%`}>
      <span className="relative h-1 w-8 overflow-hidden rounded-full bg-muted">
        <span className="absolute inset-y-0 left-0 rounded-full bg-foreground/55" style={{ width: `${value * 100}%` }} />
      </span>
      {Math.round(value * 100)}%
    </span>
  );
}

function By({ by }: { by?: string }) {
  if (!by) return null;
  return <span className="shrink-0 rounded-md bg-secondary px-1.5 py-px text-micro text-secondary-foreground">{by}</span>;
}

// ── claims ───────────────────────────────────────────────────────────────

const countClaims = (claims: VizClaim[] | undefined): number => (claims ?? []).reduce((n, c) => n + 1 + countClaims(c.children), 0);

function ClaimRow({ claim, number, depth }: { claim: VizClaim; number: string; depth: number }) {
  const openable = Boolean(claim.detail || claim.children?.length);
  const [open, setOpen] = useState(false);
  const below = countClaims(claim.children);
  return (
    <li className={cn(depth > 1 && "border-l border-border pl-3")}>
      <div
        role={openable ? "button" : undefined}
        tabIndex={openable ? 0 : undefined}
        aria-expanded={openable ? open : undefined}
        onClick={openable ? () => setOpen(!open) : undefined}
        onKeyDown={openable ? (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen(!open)) : undefined}
        className={cn("group flex items-start gap-2 rounded-lg px-1.5 py-1", openable && "cursor-pointer hover:bg-accent/60")}
      >
        <span className="mt-[0.15em] w-6 shrink-0 font-mono text-micro tabular-nums text-faint">{number}</span>
        <ToneMark tone={claim.tone} />
        <span className={cn("min-w-0 flex-1 leading-snug", depth === 1 ? "text-ui font-medium" : "text-small")}>{claim.text}</span>
        <span className="flex shrink-0 items-center gap-1.5 pt-px">
          <By by={claim.by} />
          {claim.confidence !== undefined ? <Confidence value={claim.confidence} /> : null}
          {openable ? (
            <span className="inline-flex items-center gap-0.5 text-micro text-faint">
              {!open && below ? below : null}
              <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
            </span>
          ) : null}
        </span>
      </div>
      {open ? (
        <div className="ml-8 pb-1">
          {claim.detail ? (
            <div className="px-1.5 pb-1.5 text-small text-muted-foreground">
              <Markdown text={claim.detail} literalHtml />
            </div>
          ) : null}
          {claim.children?.length ? <ClaimList claims={claim.children} prefix={`${number}.`} depth={depth + 1} /> : null}
        </div>
      ) : null}
    </li>
  );
}

function ClaimList({ claims, prefix, depth }: { claims: VizClaim[]; prefix: string; depth: number }) {
  return (
    <ol className="!list-none !pl-0 space-y-0.5">
      {claims.map((claim, i) => (
        <ClaimRow key={i} claim={claim} number={`${prefix}${i + 1}`} depth={depth} />
      ))}
    </ol>
  );
}

// ── compare ──────────────────────────────────────────────────────────────

const YES = /^(yes|true|✓|✔|pass(ed)?|ok)$/i;
const NO = /^(no|false|✗|✘|fail(ed)?)$/i;
const PARTIAL = /^(partial|partly|some|~|maybe|limited)$/i;

function Cell({ value, max }: { value: VizCell; max: number }) {
  const s = typeof value === "string" ? value : "";
  if (value === true || YES.test(s)) return <span className="inline-flex items-center gap-1 text-human-ink"><CheckIcon className="size-4" /><span className="sr-only">yes</span>{s && !YES.test(s) ? s : null}</span>;
  if (value === false || NO.test(s)) return <span className="inline-flex items-center gap-1 text-del-ink"><XIcon className="size-4" /><span className="sr-only">no</span></span>;
  if (PARTIAL.test(s)) return <span className="inline-flex items-center gap-1 text-amber-ink"><CircleDashedIcon className="size-3.5" />{s}</span>;
  if (typeof value === "number") {
    return (
      <span className="inline-flex w-full min-w-16 items-center gap-2">
        <span className="tabular-nums">{value.toLocaleString()}</span>
        {max > 0 && value >= 0 ? (
          <span className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
            <span className="block h-full rounded-full bg-foreground/40" style={{ width: `${(value / max) * 100}%` }} />
          </span>
        ) : null}
      </span>
    );
  }
  if (value === null || s === "") return <span className="text-faint">—</span>;
  return <span>{s}</span>;
}

function Compare({ spec }: { spec: Extract<VizSpec, { kind: "compare" }> }) {
  const pick = spec.pick ? spec.columns.indexOf(spec.pick) : -1;
  return (
    <div className="scroll-thin overflow-x-auto">
      <table className="w-full border-collapse text-small">
        <thead>
          <tr>
            <th className="w-[1%] py-1.5 pr-3 text-left" />
            {spec.columns.map((column, i) => (
              <th key={column} className={cn("px-3 py-1.5 text-left font-semibold", i === pick && "rounded-t-lg bg-human-soft text-human-ink")}>
                <span className="inline-flex items-center gap-1.5">
                  {column}
                  {i === pick ? <span className="rounded-full bg-human px-1.5 text-micro font-medium text-white dark:text-black">pick</span> : null}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spec.rows.map((row) => {
            const max = Math.max(0, ...row.values.filter((v): v is number => typeof v === "number"));
            return (
              <tr key={row.label} className="border-t border-border">
                <th scope="row" className="whitespace-nowrap py-1.5 pr-3 text-left font-medium text-muted-foreground" title={row.note}>
                  {row.label}
                  {row.note ? <span className="block max-w-56 whitespace-normal text-micro font-normal text-faint">{row.note}</span> : null}
                </th>
                {row.values.map((value, i) => (
                  <td key={i} className={cn("px-3 py-1.5 align-top", i === pick && "bg-human-soft/60")}>
                    <Cell value={value} max={max} />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── chart ────────────────────────────────────────────────────────────────

const niceMax = (value: number): number => {
  if (value <= 0) return 1;
  const step = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * step >= value) return m * step;
  return 10 * step;
};
const short = (n: number) => (Math.abs(n) >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e4 ? `${+(n / 1e3).toFixed(1)}k` : `${+n.toFixed(2)}`);

function Legend({ names }: { names: string[] }) {
  if (names.length < 2) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-meta text-muted-foreground">
      {names.map((name, i) => (
        <span key={name} className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px]" style={{ background: SERIES[i] }} />
          {name}
        </span>
      ))}
    </div>
  );
}

interface Hover { x: number; y: number; label: string; rows: { name: string; value: number; color: string }[] }

function Tip({ hover, unit }: { hover: Hover | null; unit?: string }) {
  if (!hover) return null;
  return (
    <div
      className="pointer-events-none absolute z-10 min-w-28 -translate-x-1/2 -translate-y-full rounded-lg border border-border bg-popover px-2.5 py-1.5 text-meta shadow-soft"
      style={{ left: hover.x, top: hover.y - 6 }}
    >
      <div className="mb-0.5 font-medium">{hover.label}</div>
      {hover.rows.map((row) => (
        <div key={row.name} className="flex items-center gap-1.5 tabular-nums">
          <span className="size-2 rounded-[2px]" style={{ background: row.color }} />
          <span className="text-muted-foreground">{row.name}</span>
          <span className="ml-auto pl-3">{row.value.toLocaleString()}{unit ?? ""}</span>
        </div>
      ))}
    </div>
  );
}

function Chart({ spec }: { spec: Extract<VizSpec, { kind: "chart" }> }) {
  const [hover, setHover] = useState<Hover | null>(null);
  const { labels, series, type, unit } = spec;
  const rowsAt = (i: number) => series.map((s, k) => ({ name: s.name, value: s.values[i]!, color: SERIES[k]! }));
  if (type === "hbar") {
    const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
    return (
      <div className="relative" onMouseLeave={() => setHover(null)}>
        <Legend names={series.map((s) => s.name)} />
        <div className="space-y-1.5">
          {labels.map((label, i) => (
            <div
              key={label}
              className="grid grid-cols-[minmax(4rem,9rem)_1fr] items-center gap-3"
              onMouseMove={(e) => {
                const box = (e.currentTarget.parentElement!.parentElement as HTMLElement).getBoundingClientRect();
                setHover({ x: e.clientX - box.left, y: e.clientY - box.top, label, rows: rowsAt(i) });
              }}
            >
              <span className="truncate text-right text-meta text-muted-foreground" title={label}>{label}</span>
              <div className="space-y-[2px]">
                {series.map((s, k) => (
                  <div key={s.name} className="flex items-center gap-2">
                    <span className="h-2.5 rounded-r-[4px]" style={{ width: `${Math.max(0, (s.values[i]! / max) * 100)}%`, background: SERIES[k], minWidth: s.values[i]! > 0 ? 2 : 0 }} />
                    {series.length === 1 || s.values[i]! < 0 ? <span className="text-micro tabular-nums text-muted-foreground">{short(s.values[i]!)}{unit ?? ""}</span> : null}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <Tip hover={hover} unit={unit} />
      </div>
    );
  }
  const W = 640;
  const H = 200;
  const pad = { l: 40, r: 8, t: 8, b: 26 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const totals = labels.map((_, i) => series.reduce((n, s) => n + Math.max(0, s.values[i]!), 0));
  const all = series.flatMap((s) => s.values);
  // Below zero the axis gets its own round step, and zero keeps a solid baseline.
  const lo = -niceMax(-Math.min(0, ...all)) * (Math.min(0, ...all) < 0 ? 1 : 0);
  const hi = niceMax(type === "stacked" ? Math.max(...totals) : Math.max(0, ...all));
  const span = hi - lo || 1;
  const y = (v: number) => pad.t + ih - ((v - lo) / span) * ih;
  const band = iw / labels.length;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => lo + f * span);
  const every = Math.ceil(labels.length / 10);
  const onMove = (e: MouseEvent<SVGRectElement>, i: number) => {
    const svg = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
    // The tooltip is placed in the wrapper, which also holds the legend above the plot.
    const wrap = e.currentTarget.ownerSVGElement!.parentElement!.getBoundingClientRect();
    const scale = svg.width / W;
    const top = type === "stacked" ? y(totals[i]!) : y(Math.max(0, ...series.map((s) => s.values[i]!)));
    setHover({ x: svg.left - wrap.left + (pad.l + band * (i + 0.5)) * scale, y: svg.top - wrap.top + top * scale, label: labels[i]!, rows: rowsAt(i) });
  };
  return (
    <div className="relative" onMouseLeave={() => setHover(null)}>
      <Legend names={series.map((s) => s.name)} />
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full overflow-visible" role="img" aria-label={vizText(spec)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeDasharray={t === 0 ? undefined : "2 3"} />
            <text x={pad.l - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize="10" fill="var(--faint)">{short(t)}</text>
          </g>
        ))}
        {lo < 0 ? <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} stroke="var(--faint)" /> : null}
        {labels.map((label, i) =>
          i % every === 0 ? (
            <text key={label} x={pad.l + band * (i + 0.5)} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--muted-foreground)">
              {label.length > 12 ? `${label.slice(0, 11)}…` : label}
            </text>
          ) : null,
        )}
        {type === "line"
          ? series.map((s, k) => (
              <g key={s.name}>
                <polyline fill="none" stroke={SERIES[k]} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" points={s.values.map((v, i) => `${pad.l + band * (i + 0.5)},${y(v)}`).join(" ")} />
                {labels.length <= 24
                  ? s.values.map((v, i) => <circle key={i} cx={pad.l + band * (i + 0.5)} cy={y(v)} r={hover?.label === labels[i] ? 4.5 : 3} fill={SERIES[k]} stroke="var(--card)" strokeWidth="2" />)
                  : null}
              </g>
            ))
          : labels.map((_, i) => {
              const x0 = pad.l + band * i + band * 0.15;
              const bw = band * 0.7;
              if (type === "stacked") {
                let base = 0;
                return series.map((s, k) => {
                  const v = Math.max(0, s.values[i]!);
                  const top = y(base + v);
                  const h = y(base) - top;
                  base += v;
                  return h > 0 ? <rect key={`${i}-${k}`} x={x0} y={top + (k === series.length - 1 ? 0 : 1)} width={bw} height={Math.max(0, h - 1)} rx={k === series.length - 1 ? 3 : 0} fill={SERIES[k]} /> : null;
                });
              }
              const w = bw / series.length;
              return series.map((s, k) => {
                const v = s.values[i]!;
                const top = Math.min(y(v), y(0));
                return <rect key={`${i}-${k}`} x={x0 + w * k + 1} y={top} width={Math.max(1, w - 2)} height={Math.abs(y(v) - y(0))} rx={3} fill={SERIES[k]} />;
              });
            })}
        {labels.map((_, i) => (
          <rect key={i} x={pad.l + band * i} y={pad.t} width={band} height={ih} fill="transparent" onMouseMove={(e) => onMove(e, i)} />
        ))}
      </svg>
      <Tip hover={hover} unit={unit} />
    </div>
  );
}

// ── stats, steps, stance, tradeoff, decision ─────────────────────────────

const TONE_TEXT: Partial<Record<VizTone, string>> = { good: "text-human-ink", pro: "text-human-ink", bad: "text-del-ink", con: "text-del-ink", warn: "text-amber-ink" };

function Stats({ spec }: { spec: Extract<VizSpec, { kind: "stats" }> }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))] gap-2">
      {spec.items.map((item) => (
        <div key={item.label} className="rounded-xl bg-muted/60 px-3 py-2.5">
          <div className="truncate text-meta text-muted-foreground" title={item.label}>{item.label}</div>
          <div className="mt-0.5 flex items-baseline gap-1.5">
            <span className="text-title font-semibold tabular-nums tracking-tight">{item.value}</span>
            {item.delta ? <span className={cn("text-meta tabular-nums", item.tone ? TONE_TEXT[item.tone] : "text-muted-foreground")}>{item.delta}</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

const STEP_ICON: Record<VizStepStatus, ReactNode> = {
  done: <CheckIcon className="size-3.5" />,
  doing: <CircleDotIcon className="size-3.5" />,
  todo: <CircleIcon className="size-3" />,
  blocked: <BanIcon className="size-3.5" />,
  skipped: <SkipForwardIcon className="size-3" />,
};
const STEP_TONE: Record<VizStepStatus, string> = {
  done: "bg-human text-white dark:text-black",
  doing: "bg-[var(--viz-1)] text-white dark:text-black",
  todo: "bg-muted text-faint",
  blocked: "bg-destructive text-white dark:text-black",
  skipped: "bg-muted text-faint",
};

function Steps({ spec }: { spec: Extract<VizSpec, { kind: "steps" }> }) {
  const done = spec.steps.filter((s) => s.status === "done").length;
  const counted = spec.steps.filter((s) => s.status !== "skipped").length;
  return (
    <div>
      <div className="mb-2.5 flex items-center gap-2 text-meta text-muted-foreground">
        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <span className="block h-full rounded-full bg-human" style={{ width: `${counted ? (done / counted) * 100 : 0}%` }} />
        </span>
        <span className="tabular-nums">{done}/{counted} done</span>
      </div>
      <ol className="!list-none !pl-0">
        {spec.steps.map((step, i) => (
          <li key={i} className="relative flex gap-2.5 pb-2 last:pb-0">
            {i < spec.steps.length - 1 ? <span className="absolute left-[9px] top-5 bottom-0 w-px bg-border" aria-hidden /> : null}
            <span title={step.status} className={cn("relative z-[1] mt-px grid size-[19px] shrink-0 place-items-center rounded-full", STEP_TONE[step.status])}>{STEP_ICON[step.status]}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-start gap-2">
                <span className={cn("flex-1 text-small leading-snug", step.status === "skipped" && "text-faint line-through", step.status === "doing" && "font-medium")}>{step.title}</span>
                <By by={step.by} />
              </div>
              {step.detail ? <p className="mt-0.5 text-meta text-muted-foreground">{step.detail}</p> : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Stance({ spec }: { spec: Extract<VizSpec, { kind: "stance" }> }) {
  return (
    <div>
      <div className="mb-1.5 grid grid-cols-[minmax(4rem,8rem)_1fr] gap-3 text-meta font-medium">
        <span />
        <div className="flex justify-between gap-4">
          <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-[var(--viz-1)]" />← {spec.left}</span>
          <span className="inline-flex items-center gap-1.5 text-right">{spec.right} →<span className="size-2 rounded-full bg-[var(--viz-2)]" /></span>
        </div>
      </div>
      <div className="space-y-2">
        {spec.items.map((item) => {
          const at = ((item.value + 1) / 2) * 100;
          return (
            <div key={item.label} className="grid grid-cols-[minmax(4rem,8rem)_1fr] items-start gap-3">
              <span className="truncate pt-0.5 text-right text-small font-medium" title={item.label}>{item.label}</span>
              <div>
                <div className="relative h-5">
                  <span className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-gradient-to-r from-[var(--viz-1)]/25 via-muted to-[var(--viz-2)]/25" />
                  <span className="absolute left-1/2 top-0.5 bottom-0.5 w-px bg-border" />
                  <span
                    title={`${item.value > 0 ? "+" : ""}${item.value.toFixed(2)}`}
                    className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card shadow-soft"
                    style={{ left: `${at}%`, background: item.value < 0 ? "var(--viz-1)" : item.value > 0 ? "var(--viz-2)" : "var(--faint)", opacity: item.confidence === undefined ? 1 : 0.45 + item.confidence * 0.55 }}
                  />
                </div>
                {item.note ? <p className="text-meta text-muted-foreground">{item.note}</p> : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Tradeoff({ spec }: { spec: Extract<VizSpec, { kind: "tradeoff" }> }) {
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${spec.options.length > 2 ? 11 : 14}rem, 1fr))` }}>
      {spec.options.map((option) => (
        <div key={option.name} className="flex flex-col rounded-xl border border-border bg-card p-3">
          <h5 className="mb-2 text-small font-semibold">{option.name}</h5>
          <ul className="!list-none !pl-0 space-y-1 text-small">
            {option.pros.map((p, i) => (
              <li key={`p${i}`} className="flex gap-1.5"><PlusIcon className="mt-0.5 size-3.5 shrink-0 text-human-ink" /><span>{p}</span></li>
            ))}
            {option.cons.map((c, i) => (
              <li key={`c${i}`} className="flex gap-1.5"><MinusIcon className="mt-0.5 size-3.5 shrink-0 text-del-ink" /><span>{c}</span></li>
            ))}
          </ul>
          {option.verdict ? <p className="mt-auto border-t border-border pt-2 text-meta font-medium text-muted-foreground [&:not(:first-child)]:mt-2.5">{option.verdict}</p> : null}
        </div>
      ))}
    </div>
  );
}

function Decision({ spec }: { spec: Extract<VizSpec, { kind: "decision" }> }) {
  const [picked, setPicked] = useState<string | null>(null);
  const answer = (label: string) => {
    setPicked(label);
    const store = useStore.getState();
    if (store.snap) store.setView("chat");
    store.composeDraft(vizDecisionReply(spec.question, label));
  };
  return (
    <div>
      <p className="mb-2 text-ui font-medium">{spec.question}</p>
      <div className="grid gap-1.5">
        {spec.options.map((option) => (
          <button
            key={option.label}
            type="button"
            onClick={() => answer(option.label)}
            className={cn(
              "group flex items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition",
              picked === option.label ? "border-foreground/40 bg-accent" : "border-border bg-card hover:border-foreground/25 hover:bg-accent/60",
            )}
          >
            <span className={cn("mt-1 grid size-3.5 shrink-0 place-items-center rounded-full border", picked === option.label ? "border-foreground" : "border-input")}>
              {picked === option.label ? <span className="size-1.5 rounded-full bg-foreground" /> : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-1.5 text-small font-medium">
                {option.label}
                {option.recommended ? <span className="rounded-full bg-human-soft px-1.5 text-micro font-medium text-human-ink">recommended</span> : null}
              </span>
              {option.detail ? <span className="block text-meta text-muted-foreground">{option.detail}</span> : null}
            </span>
          </button>
        ))}
      </div>
      <p className="mt-2 text-micro text-faint">{picked ? "Your answer is in the composer — edit it or send it." : "Pick one to draft your answer; nothing is sent until you send it."}</p>
    </div>
  );
}

// ── the card ─────────────────────────────────────────────────────────────

function Body({ spec }: { spec: VizSpec }) {
  switch (spec.kind) {
    case "claims":
      return <ClaimList claims={spec.claims} prefix="" depth={1} />;
    case "compare":
      return <Compare spec={spec} />;
    case "chart":
      return <Chart spec={spec} />;
    case "stats":
      return <Stats spec={spec} />;
    case "steps":
      return <Steps spec={spec} />;
    case "stance":
      return <Stance spec={spec} />;
    case "tradeoff":
      return <Tradeoff spec={spec} />;
    case "decision":
      return <Decision spec={spec} />;
  }
}

export function VizCard({ spec, className, bare }: { spec: VizSpec; className?: string; bare?: boolean }) {
  const [raw, setRaw] = useState(false);
  const Icon = KIND_ICON[spec.kind];
  return (
    <figure data-viz={spec.kind} className={cn("not-prose my-3 overflow-hidden rounded-xl border border-border bg-card", bare && "my-0 border-0 bg-transparent", className)}>
      {spec.title || !bare ? (
        <figcaption className={cn("flex items-center gap-2 px-3 pt-2.5 text-meta", bare && "px-0")}>
          <Icon className="size-3.5 shrink-0 text-faint" />
          <span className={cn("min-w-0 flex-1 truncate font-semibold", spec.title ? "text-foreground" : "text-faint")}>{spec.title ?? KIND_NAME[spec.kind]}</span>
          {!bare ? (
            <button
              type="button"
              onClick={() => setRaw(!raw)}
              aria-pressed={raw}
              title={raw ? "Show the card" : "Show as text"}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-micro text-faint hover:bg-accent hover:text-foreground"
            >
              <Code2Icon className="size-3" /> {raw ? "card" : "text"}
            </button>
          ) : null}
        </figcaption>
      ) : null}
      <div className={cn("px-3 pb-3 pt-2", bare && "px-0")}>
        {raw ? <pre className="scroll-thin max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-code p-2.5 font-mono text-meta leading-relaxed">{vizText(spec)}</pre> : <Body spec={spec} />}
        {spec.caption && !raw ? <p className="mt-2 text-meta text-muted-foreground">{spec.caption}</p> : null}
      </div>
    </figure>
  );
}

/** A ```viz fence in markdown: drawn once complete, a placeholder while it streams, its source and the reason when it does not parse. */
export const VizBlock = memo(function VizBlock({ code, isIncomplete }: { code: string; isIncomplete: boolean }) {
  const result = useMemo(() => (isIncomplete ? null : parseViz(code)), [code, isIncomplete]);
  if (!result) {
    return (
      <div className="not-prose my-3 flex h-24 items-center justify-center gap-2 rounded-xl border border-dashed border-border text-meta text-faint">
        <BarChart3Icon className="size-4 animate-pulse" /> drawing…
      </div>
    );
  }
  if (!result.ok) {
    return (
      <div className="not-prose my-3 overflow-hidden rounded-xl border border-dashed border-amber/60">
        <p className="bg-amber-soft px-3 py-1.5 text-meta text-amber-ink">This visual could not be drawn: {result.error}</p>
        <pre className="scroll-thin max-h-60 overflow-auto bg-code px-3 py-2 font-mono text-meta">{code}</pre>
      </div>
    );
  }
  return <VizCard spec={result.spec} />;
});
