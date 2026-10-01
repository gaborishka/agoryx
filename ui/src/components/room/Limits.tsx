import { headlineWindow, limitPace, type Pace } from "@agora/limits";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useNow } from "@/hooks/use-now";
import { clock } from "@/lib/format";
import type { AgentKind, LimitSnapshot, LimitWindow } from "@/lib/types";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex" };

/** "5 год", "тиждень", "тиждень · opus": short, for the footer and the popover. */
export const windowLabel = (window: Pick<LimitWindow, "id" | "minutes">) => {
  if (window.id === "five_hour") return "5 год";
  if (window.id === "seven_day") return "тиждень";
  if (window.id.startsWith("seven_day_")) return `тиждень · ${window.id.slice(10)}`;
  const minutes = window.minutes;
  if (!minutes) return window.id;
  if (minutes === 10080) return "тиждень";
  if (minutes % 1440 === 0) return `${minutes / 1440} дн`;
  if (minutes % 60 === 0) return `${minutes / 60} год`;
  return `${minutes} хв`;
};

/** A time as the human reads it: "14:05" today, "пт 09:00" this week, else a date. */
const when = (iso: string, now: number) => {
  const date = new Date(iso);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return clock(iso);
  if (Math.abs(date.getTime() - now) < 6 * 86_400_000) return `${date.toLocaleDateString("uk-UA", { weekday: "short" })} ${clock(iso)}`;
  return `${date.toLocaleDateString("uk-UA", { day: "numeric", month: "short" })} ${clock(iso)}`;
};

/** "оновлено щойно", "оновлено 3 хв тому". */
const updated = (iso: string, now: number) => {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "оновлено щойно";
  if (minutes < 60) return `оновлено ${minutes} хв тому`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `оновлено ${hours} год тому`;
  return `оновлено ${Math.floor(hours / 24)} дн тому`;
};

const paceText = (pace: Pace, now: number): string => {
  switch (pace.state) {
    case "on-pace":
      return "у темпі";
    case "ahead":
      return `випереджаєте темп — до скидання не вистачить (≈ ${when(pace.runsOutAt!, now)})`;
    case "early":
      return "вікно щойно почалося";
    case "out":
      return "вичерпано до скидання";
    case "reset":
      return "уже скинуто — нові дані прийдуть з наступним ходом";
    default:
      return "темп невідомий";
  }
};

/** The latest a CLI said for this kind of agent (the most recent login, if there are several). */
const latestFor = (limits: LimitSnapshot[] | undefined, kind: AgentKind) =>
  (limits ?? []).filter((entry) => entry.kind === kind).sort((a, b) => b.at.localeCompare(a.at))[0];

/** Where one kind's subscription stands: the window closest to running out, and whether it worries. */
export const useLimitState = (kind: AgentKind, limits: LimitSnapshot[] | undefined) => {
  const now = useNow(true, 30_000);
  const snapshot = latestFor(limits, kind);
  const headline = snapshot ? headlineWindow(snapshot.windows, now) : undefined;
  const pace = headline ? limitPace(headline, now) : null;
  const alarm = Boolean(snapshot?.limited) || pace?.state === "out";
  return { now, snapshot, headline, alarm, warn: !alarm && pace?.state === "ahead" };
};

/** The subscription's limits inside an agent's menu: one line, the windows under it. */
export function LimitsSection({ kind, limits }: { kind: AgentKind; limits: LimitSnapshot[] | undefined }) {
  const { now, snapshot, headline, alarm, warn } = useLimitState(kind, limits);
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-ui transition hover:bg-accent"
      >
        Ліміт {KIND_LABEL[kind]}
        <span className={cn("ml-auto tabular-nums text-meta text-muted-foreground", warn && "text-amber", alarm && "text-destructive")}>
          {headline ? `${windowLabel(headline)}: ${Math.round(headline.usedPercent)}%` : "невідомо"}
        </span>
      </button>
      {open ? (
        <div className="px-3 pb-3">
          <LimitsBody snapshot={snapshot} now={now} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * An agent's subscription limits in the footer: the window closest to running out ("5 год: 42%"), and on click
 * every window with its reset and pace. Only what the CLI reported — nothing here limits anything.
 */
export function LimitsChip({ kind, limits, className }: { kind: AgentKind; limits: LimitSnapshot[] | undefined; className?: string }) {
  const [open, setOpen] = useState(false);
  const now = useNow(true, 30_000);
  const snapshot = latestFor(limits, kind);
  const headline = snapshot ? headlineWindow(snapshot.windows, now) : undefined;
  const pace = headline ? limitPace(headline, now) : null;
  const alarm = Boolean(snapshot?.limited) || pace?.state === "out";
  const warn = pace?.state === "ahead";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn("shrink-0 tabular-nums data-[state=open]:bg-accent data-[state=open]:text-foreground", className, warn && "text-amber", alarm && "text-destructive")}
          title={`${KIND_LABEL[kind]}: ліміти підписки`}
        >
          {headline ? `${windowLabel(headline)}: ${Math.round(headline.usedPercent)}%` : <span className="text-faint">ліміт: невідомо</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-[300px] p-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-small font-medium">{KIND_LABEL[kind]}</span>
          {snapshot?.plan ? <span className="text-meta text-muted-foreground">план {snapshot.plan}</span> : null}
        </div>
        <LimitsBody snapshot={snapshot} now={now} />
      </PopoverContent>
    </Popover>
  );
}

function LimitsBody({ snapshot, now }: { snapshot: LimitSnapshot | undefined; now: number }) {
  return (
    <>
      {!snapshot ? (
        <p className="mt-2 text-small text-muted-foreground">Невідомо: CLI ще нічого не казав про ліміти. Дані прийдуть з наступним ходом агента.</p>
      ) : (
        <>
          {snapshot.limited ? <p className="mt-2 text-small text-destructive">CLI каже: ліміт вичерпано.</p> : null}
          {snapshot.windows.length === 0 ? <p className="mt-2 text-small text-muted-foreground">Вікна невідомі.</p> : null}
          <ul className="mt-2 flex flex-col gap-3">
            {snapshot.windows.map((window) => (
              <LimitRow key={window.id} window={window} now={now} />
            ))}
          </ul>
          <p className="mt-3 text-meta text-faint">{updated(snapshot.at, now)} · так каже сам CLI</p>
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
        {snapshot?.plan ? <span className="text-meta text-muted-foreground">план {snapshot.plan}</span> : null}
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
        <span className="tabular-nums text-muted-foreground">використано {Math.round(window.usedPercent)}%</span>
      </div>
      <div className="relative h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className={cn("h-full rounded-full", tone, pace.state === "reset" && "opacity-40")} style={{ width: `${used}%` }} />
        {pace.elapsedPercent !== undefined && pace.state !== "reset" ? (
          // Where the window's time stands: used to the left of it is on pace.
          <div className="absolute inset-y-0 w-px bg-foreground/60" style={{ left: `${pace.elapsedPercent}%` }} title={`минуло ${Math.round(pace.elapsedPercent)}% вікна`} />
        ) : null}
      </div>
      <div className="flex flex-wrap justify-between gap-x-2 text-meta text-muted-foreground">
        <span className={cn(pace.state === "ahead" && "text-amber", pace.state === "out" && "text-destructive")}>{paceText(pace, now)}</span>
        {window.resetsAt ? <span>скидання {when(window.resetsAt, now)}</span> : <span>скидання невідоме</span>}
      </div>
    </li>
  );
}
