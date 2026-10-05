import { headlineWindow, limitPace, type Pace } from "@agora/limits";
import type { ReactNode } from "react";
import { useNow } from "@/hooks/use-now";
import { clock } from "@/lib/format";
import type { AgentKind, LimitSnapshot, LimitWindow } from "@/lib/types";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex" };

/** "5 h", "week", "week · opus": short, for the footer and the popover. */
export const windowLabel = (window: Pick<LimitWindow, "id" | "minutes">) => {
  if (window.id === "five_hour") return "5 h";
  if (window.id === "seven_day") return "week";
  if (window.id.startsWith("seven_day_")) return `week · ${window.id.slice(10)}`;
  const minutes = window.minutes;
  if (!minutes) return window.id;
  if (minutes === 10080) return "week";
  if (minutes % 1440 === 0) return `${minutes / 1440} d`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
};

/** A time as the human reads it: "14:05" today, "Fri 09:00" this week, else a date. */
const when = (iso: string, now: number) => {
  const date = new Date(iso);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return clock(iso);
  if (Math.abs(date.getTime() - now) < 6 * 86_400_000) return `${date.toLocaleDateString("en", { weekday: "short" })} ${clock(iso)}`;
  return `${date.toLocaleDateString("en", { day: "numeric", month: "short" })} ${clock(iso)}`;
};

/** "updated just now", "updated 3 min ago". */
const updated = (iso: string, now: number) => {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "updated just now";
  if (minutes < 60) return `updated ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `updated ${hours} h ago`;
  return `updated ${Math.floor(hours / 24)} d ago`;
};

const paceText = (pace: Pace, now: number): string => {
  switch (pace.state) {
    case "on-pace":
      return "on pace";
    case "ahead":
      return `ahead of pace — won’t last until the reset (runs out ≈ ${when(pace.runsOutAt!, now)})`;
    case "early":
      return "window just started";
    case "out":
      return "used up until the reset";
    case "reset":
      return "already reset — new numbers come with the next turn";
    default:
      return "pace unknown";
  }
};

/** The latest a CLI said for this kind of agent (the most recent login, if there are several). */
const latestFor = (limits: LimitSnapshot[] | undefined, kind: AgentKind) =>
  (limits ?? []).filter((entry) => entry.kind === kind).sort((a, b) => b.at.localeCompare(a.at))[0];

/** What one kind of agent's CLI last said about its limits, read for the footer: the window closest to running out and how it goes. */
export function useLimit(kind: AgentKind, limits: LimitSnapshot[] | undefined) {
  const now = useNow(true, 30_000);
  const snapshot = latestFor(limits, kind);
  const headline = snapshot ? headlineWindow(snapshot.windows, now) : undefined;
  const pace = headline ? limitPace(headline, now) : null;
  const alarm = Boolean(snapshot?.limited) || pace?.state === "out";
  const warn = !alarm && pace?.state === "ahead";
  const summary = headline ? `${windowLabel(headline)}: ${Math.round(headline.usedPercent)}% used` : "limits unknown";
  return { now, snapshot, headline, alarm, warn, summary };
}

/**
 * An agent's tile in the footer, its border drawn as far as the subscription's closest window is used —
 * amber when it will not last until the reset, red when it is out. No border when the CLI has not said.
 */
export function LimitFace({ kind, limits, size = 20, children }: { kind: AgentKind; limits: LimitSnapshot[] | undefined; size?: number; children: ReactNode }) {
  const { headline, alarm, warn } = useLimit(kind, limits);
  const used = headline ? Math.min(100, Math.max(0, headline.usedPercent)) : null;
  const box = size + 6;
  return (
    <span className="relative grid shrink-0 place-items-center" style={{ width: box, height: box }}>
      {children}
      {used !== null ? (
        <svg className="pointer-events-none absolute inset-0 size-full -rotate-90" viewBox={`0 0 ${box} ${box}`} aria-hidden>
          <rect x="1" y="1" width={box - 2} height={box - 2} rx={(box - 2) * 0.32} fill="none" strokeWidth="1.5" className="stroke-border" />
          <rect
            x="1"
            y="1"
            width={box - 2}
            height={box - 2}
            rx={(box - 2) * 0.32}
            fill="none"
            strokeWidth="1.5"
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray={`${Math.max(used, 2)} 100`}
            className={alarm ? "stroke-destructive" : warn ? "stroke-amber" : "stroke-foreground/45"}
          />
        </svg>
      ) : null}
    </span>
  );
}

/** Every window one kind of agent's CLI last reported, as a section of the agent's menu. */
export function LimitsSection({ kind, limits }: { kind: AgentKind; limits: LimitSnapshot[] | undefined }) {
  const { now, snapshot } = useLimit(kind, limits);
  return (
    <div className="border-t border-border px-3 pt-2 pb-2.5">
      <div className="flex items-baseline justify-between gap-2 text-meta text-muted-foreground">
        {KIND_LABEL[kind]} limits
        {snapshot?.plan ? <span>{snapshot.plan} plan</span> : null}
      </div>
      <LimitsBody snapshot={snapshot} now={now} />
    </div>
  );
}

function LimitsBody({ snapshot, now }: { snapshot: LimitSnapshot | undefined; now: number }) {
  return (
    <>
      {!snapshot ? (
        <p className="mt-2 text-small text-muted-foreground">Unknown: the CLI hasn’t reported its limits yet. They’ll come with the agent’s next turn.</p>
      ) : (
        <>
          {snapshot.limited ? <p className="mt-2 text-small text-destructive">The CLI says the limit is used up.</p> : null}
          {snapshot.windows.length === 0 ? <p className="mt-2 text-small text-muted-foreground">No windows reported.</p> : null}
          <ul className="mt-2 flex flex-col gap-3">
            {snapshot.windows.map((window) => (
              <LimitRow key={window.id} window={window} now={now} />
            ))}
          </ul>
          <p className="mt-3 text-meta text-faint">{updated(snapshot.at, now)} · as reported by the CLI</p>
        </>
      )}
    </>
  );
}

/** Every window one kind of agent's CLI last reported, as a block (the settings screen). */
export function LimitsCard({ kind, limits }: { kind: AgentKind; limits: LimitSnapshot[] | undefined }) {
  const now = useNow(true, 30_000);
  const snapshot = latestFor(limits, kind);
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-ui font-medium">{KIND_LABEL[kind]}</span>
        {snapshot?.plan ? <span className="text-meta text-muted-foreground">{snapshot.plan} plan</span> : null}
      </div>
      <LimitsBody snapshot={snapshot} now={now} />
    </div>
  );
}

function LimitRow({ window, now }: { window: LimitWindow; now: number }) {
  const pace = limitPace(window, now);
  const used = Math.min(100, Math.max(0, window.usedPercent));
  const tone = pace.state === "out" ? "bg-destructive" : pace.state === "ahead" ? "bg-amber" : "bg-primary";
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-small">
        <span>{windowLabel(window)}</span>
        <span className="tabular-nums text-muted-foreground">{Math.round(window.usedPercent)}% used</span>
      </div>
      <div className="relative h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className={cn("h-full rounded-full", tone, pace.state === "reset" && "opacity-40")} style={{ width: `${used}%` }} />
        {pace.elapsedPercent !== undefined && pace.state !== "reset" ? (
          // Where the window's time stands: used to the left of it is on pace.
          <div className="absolute inset-y-0 w-px bg-foreground/60" style={{ left: `${pace.elapsedPercent}%` }} title={`${Math.round(pace.elapsedPercent)}% of the window has passed`} />
        ) : null}
      </div>
      <div className="flex flex-wrap justify-between gap-x-2 text-meta text-muted-foreground">
        <span className={cn(pace.state === "ahead" && "text-amber", pace.state === "out" && "text-destructive")}>{paceText(pace, now)}</span>
        {window.resetsAt ? <span>resets {when(window.resetsAt, now)}</span> : <span>reset time unknown</span>}
      </div>
    </li>
  );
}
