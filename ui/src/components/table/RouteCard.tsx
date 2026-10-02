import { CheckIcon, GitCommitHorizontalIcon, RouteIcon, ShieldAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Markdown } from "@/components/md/Markdown";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api, roomPath } from "@/lib/api";
import { plural } from "@/lib/format";
import { participant } from "@/lib/room";
import { useStore } from "@/lib/store";
import type { RoomState, TableItem, TableOption, TableState } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { StepCommitPlan } from "@agora/step-commit";
import { stepBuilder, stepChecked } from "@agora/table";
import { NoteItem, RefChip } from "./OpCard";

// A step goes through four states, each ticked once it is reached: built, its check asked for, checked, committed.
// The table only shows what the agents and the human did; the one button here is the human's commit.
const STAGES = [
  ["building", "Building"],
  ["review", "On review"],
  ["checked", "Checked"],
  ["committed", "Committed"],
] as const;
type Stage = (typeof STAGES)[number][0];

/**
 * Which states a step has reached, and the one it is in now; `unchecked`: marked done with nobody else's check (in a
 * room with one agent, its own check counts).
 */
export const stageOf = (step: TableItem): { reached: Record<Stage, boolean>; now: Stage; unchecked: boolean } => {
  const checked = stepChecked(step);
  const reached = { building: true, review: Boolean(step.review) || checked, checked, committed: Boolean(step.commit) };
  const now: Stage = reached.committed ? "committed" : checked ? "checked" : reached.review ? "review" : "building";
  return { reached, now, unchecked: Boolean(step.done) && !checked };
};

/** Past this many files in a group, the rest are counted, not listed (an untracked build folder can hold thousands). */
const MAX_LISTED = 200;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The four states in a row: done ones ticked, the current one named; one skipped (committed with no check) dashed. */
function Stages({ step }: { step: TableItem }) {
  const { reached, now, unchecked } = stageOf(step);
  const at = STAGES.findIndex(([key]) => key === now);
  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-1 text-micro" aria-label={`${step.id}: ${STAGES[at]![1].toLowerCase()}`}>
      {STAGES.map(([key, label], i) => {
        const current = i === at;
        const ticked = reached[key] && (i < at || key === "checked" || key === "committed" || (key === "building" && unchecked));
        const skipped = i < at && !reached[key];
        return (
          <li
            key={key}
            aria-current={current ? "step" : undefined}
            className={cn("inline-flex items-center gap-1", current ? "font-semibold text-foreground" : ticked ? "text-muted-foreground" : "text-faint")}
          >
            {i ? <span aria-hidden className={cn("h-px w-2.5", i <= at ? "bg-primary/45" : "bg-border")} /> : null}
            <span
              aria-hidden
              className={cn(
                "grid size-3.5 shrink-0 place-items-center rounded-full border",
                ticked ? "border-primary bg-primary text-primary-foreground" : current ? "border-primary ring-2 ring-primary/15" : skipped ? "border-dashed border-amber" : "border-border",
              )}
            >
              {ticked ? <CheckIcon className="size-2.5" strokeWidth={3} /> : null}
            </span>
            {/* Narrow, only the state it is in is named. */}
            <span className={cn(!current && "sr-only @sm:not-sr-only")}>
              {label}
              {skipped ? " (skipped)" : ""}
            </span>
          </li>
        );
      })}
      {unchecked && !reached.committed ? <li className="ml-1 font-medium text-amber-ink">done without a check</li> : null}
    </ol>
  );
}

/** What the step's check found: the objections to it, in a popover. */
function Findings({ table, step }: { table: TableState; step: TableItem }) {
  const notes = table.notes.filter((n) => n.target === step.id && n.kind === "object").sort((a, b) => a.seq - b.seq);
  if (!notes.length) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-5 items-center gap-1 rounded-full bg-destructive-soft px-2 text-micro font-semibold text-destructive transition hover:bg-destructive-soft/70"
        >
          <ShieldAlertIcon className="size-3" />
          {plural(notes.length, "finding", "findings")}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex max-h-96 w-80 flex-col gap-2 overflow-y-auto p-2.5">
        <p className="px-0.5 text-meta font-semibold text-muted-foreground">What the check of {step.id} found</p>
        {notes.map((n) => (
          <NoteItem key={n.id} n={n} />
        ))}
      </PopoverContent>
    </Popover>
  );
}

/** Where the step went: its commit, which opens in Changes. */
function Committed({ step, room }: { step: TableItem; room: RoomState }) {
  const openChanges = useStore((s) => s.openChanges);
  const commit = step.commit!;
  return (
    <span className="inline-flex items-center gap-1 text-micro text-muted-foreground">
      <GitCommitHorizontalIcon className="size-3" />
      <button
        type="button"
        title="Show the commit"
        className="font-mono text-foreground underline decoration-border underline-offset-2 hover:decoration-current"
        onClick={() => openChanges({ scope: "commit", sha: commit.sha })}
      >
        {commit.sha.slice(0, 7)}
      </button>
      {commit.by === "agoryx" ? "in a checkpoint" : `by ${participant(room, commit.by).label}`}
    </span>
  );
}

function FileChoice({ file, chosen, onToggle, room }: { file: StepCommitPlan["files"][number]; chosen: boolean; onToggle: () => void; room: RoomState }) {
  const turns = file.turns.slice(-3);
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-lg px-1.5 py-1 hover:bg-muted/60">
      <input type="checkbox" checked={chosen} onChange={onToggle} className="mt-0.5 size-3.5 shrink-0 accent-primary" />
      <span className="min-w-0">
        <span className="block font-mono text-micro break-all">{file.path}</span>
        <span className="block text-micro text-faint">
          {turns.length
            ? `${file.turns.length > turns.length ? "… " : ""}${turns.map((turn) => `${turn.id} ${participant(room, turn.agent).label}`).join(", ")}`
            : "not changed by a turn of this room"}
        </span>
      </span>
    </label>
  );
}

/**
 * The human's commit of one step: every uncommitted file in the folder, those changed since the step was put on
 * the table ticked. Only the ticked ones go in, under the folder's own git name, with the step in the subject.
 */
function CommitStep({ step, room, primary, busyTurn }: { step: TableItem; room: RoomState; primary: boolean; busyTurn: boolean }) {
  const post = useStore((s) => s.post);
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<StepCommitPlan | null>(null);
  const [error, setError] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setPlan(null);
    setError("");
    api<StepCommitPlan>("GET", `${roomPath(room.id, "/step-commit")}?step=${encodeURIComponent(step.id)}`)
      .then((next) => {
        if (!live) return;
        setPlan(next);
        // Only what is listed is ticked: a file past the list can't be seen or unticked.
        setChosen(next.files.filter((file) => file.step).slice(0, MAX_LISTED).map((file) => file.path));
      })
      .catch((e) => live && setError(message(e)));
    return () => {
      live = false;
    };
  }, [open, room.id, step.id]);
  const commit = () => {
    setBusy(true);
    setError("");
    post("/step-commit", { step: step.id, files: chosen })
      .then((made) => {
        toast.success(`${step.id} committed as ${String(made.sha).slice(0, 7)}`);
        setOpen(false);
      })
      .catch((e) => setError(message(e)))
      .finally(() => setBusy(false));
  };
  const toggle = (path: string) => setChosen((list) => (list.includes(path) ? list.filter((entry) => entry !== path) : [...list, path]));
  const groups = plan
    ? ([
        ["Changed by this step's turns", plan.files.filter((file) => file.step)],
        ["Other uncommitted files", plan.files.filter((file) => !file.step)],
      ] as const)
    : [];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="xs"
          variant={primary ? "default" : "outline"}
          className="h-6 rounded-md px-2 text-micro"
          disabled={busyTurn}
          title={busyTurn ? "A turn is running: commit the step once it has ended" : undefined}
        >
          <GitCommitHorizontalIcon />
          Commit step
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2.5 p-3">
        <div className="flex flex-col gap-0.5">
          <p className="text-ui font-semibold">Commit {step.id}</p>
          <p className="text-meta text-muted-foreground">
            Only the files you tick go in, under the folder’s own git name. What you leave out stays as it is. Git hooks don’t run, and the commit
            isn’t signed.
          </p>
        </div>
        {plan ? <code className="block truncate rounded-md bg-muted px-2 py-1 font-mono text-micro">{plan.subject}</code> : null}
        {!plan && !error ? <p className="text-small text-muted-foreground">Reading the folder…</p> : null}
        {plan && !plan.files.length ? <p className="text-small text-muted-foreground">Nothing in the folder is uncommitted.</p> : null}
        {plan?.files.length ? (
          <div className="scroll-thin -mx-1.5 flex max-h-64 flex-col gap-2 overflow-y-auto">
            {groups.map(([title, files]) =>
              files.length ? (
                <div key={title} className="flex flex-col">
                  <p className="px-1.5 pb-0.5 text-micro font-semibold text-muted-foreground">{title}</p>
                  {files.slice(0, MAX_LISTED).map((file) => (
                    <FileChoice key={file.path} file={file} chosen={chosen.includes(file.path)} onToggle={() => toggle(file.path)} room={room} />
                  ))}
                  {files.length > MAX_LISTED ? <p className="px-1.5 py-1 text-micro text-faint">… and {files.length - MAX_LISTED} more, not listed</p> : null}
                </div>
              ) : null,
            )}
          </div>
        ) : null}
        {error ? <p className="rounded-lg bg-destructive-soft px-2.5 py-1.5 text-small text-destructive">{error}</p> : null}
        {plan?.files.length ? (
          <Button size="sm" disabled={!chosen.length || busy || busyTurn} onClick={commit}>
            <GitCommitHorizontalIcon />
            {busy ? "Committing…" : `Commit ${plural(chosen.length, "file", "files")}`}
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** Who put the step on the table, who built it when someone else did, and who checked it (or closed it unchecked). */
const who = (n: TableItem, room: RoomState): string => {
  const label = (id: string) => participant(room, id).label;
  const parts = [label(n.by)];
  // Its builder: who asked for its check, or (checked, none asked for) the agent that closed it in a room of one.
  const builder = stepBuilder(n, room.human);
  if (builder && builder !== n.by && (n.review || stepChecked(n))) parts.push(`built by ${label(builder)}`);
  // Its checker: who marked it done, or whose support let its builder close it; not the one who put it there and
  // closed it, with nobody else on it.
  const checker = stepChecked(n) ? (n.checkedBy ?? (n.doneBy !== builder ? n.doneBy : undefined)) : undefined;
  if (checker && checker !== builder && (builder || checker !== n.by)) parts.push(`checked by ${label(checker)}`);
  else if (n.doneBy && !stepChecked(n) && n.doneBy !== n.by && n.doneBy !== n.review) parts.push(`done by ${label(n.doneBy)}`);
  return parts.join(" · ");
};

/** One step: done box, text, who, its four states, what its check found, and its commit (or the human's button). */
export function StepRow({ n, table, room }: { n: TableItem; table: TableState; room: RoomState }) {
  const post = useStore((s) => s.post);
  const driven = useStore((s) => s.snap?.driven);
  const gitRepo = useStore((s) => s.snap?.gitRepo);
  const { reached } = stageOf(n);
  const busyTurn = room.turns.some((turn) => turn.status === "running");
  return (
    <li id={`ti-${n.id}`} className="@container flex scroll-mt-24 gap-2.5">
      <button
        type="button"
        disabled={n.done}
        aria-label={n.done ? "Done" : "Mark done"}
        title={n.done ? "Done" : "Mark done"}
        onClick={() => post("/table", { op: "done", target: n.id }).catch((e) => toast.error(message(e)))}
        className={cn(
          "mt-0.5 grid size-4 shrink-0 place-items-center rounded border transition",
          n.done ? "border-primary bg-primary text-primary-foreground" : "border-input bg-card hover:border-primary",
        )}
      >
        {n.done ? <CheckIcon className="size-3" strokeWidth={3} /> : null}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className={cn("flex min-w-0 items-baseline gap-1.5", n.done && "text-muted-foreground")}>
          <span className="shrink-0 font-mono text-micro font-semibold text-faint">{n.id}</span>
          <Markdown text={n.text} className={cn("min-w-0 text-ui", n.done && "line-through decoration-faint")} />
        </div>
        <div className="text-meta text-faint">{who(n, room)}</div>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <Stages step={n} />
          <Findings table={table} step={n} />
          {n.commit ? (
            <Committed step={n} room={room} />
          ) : driven && gitRepo && (n.done || n.review) ? (
            <CommitStep step={n} room={room} primary={reached.checked} busyTurn={busyTurn} />
          ) : null}
        </div>
      </div>
    </li>
  );
}

/** A route: an option with steps on it, as a checklist of where each step stands. */
function RouteCard({ o, steps, table, room }: { o: TableOption; steps: TableItem[]; table: TableState; room: RoomState }) {
  const stages = steps.map((step) => stageOf(step));
  const counts = new Map<Stage, number>();
  // A step done without a check is counted apart: it is neither still being built nor checked.
  for (const stage of stages) if (!stage.unchecked || stage.reached.committed) counts.set(stage.now, (counts.get(stage.now) ?? 0) + 1);
  const unchecked = stages.filter((stage) => stage.unchecked && !stage.reached.committed).length;
  const bar: Array<[Stage, string]> = [
    ["committed", "bg-primary"],
    ["checked", "bg-primary/55"],
    ["review", "bg-codex/50"],
  ];
  // What checks found on the steps not yet through one: those on a checked step were dealt with.
  const findings = steps.reduce((sum, step, i) => sum + (stages[i]!.reached.checked ? 0 : table.notes.filter((n) => n.target === step.id && n.kind === "object").length), 0);
  return (
    <section id={`route-${o.id}`} className="flex scroll-mt-24 flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-soft">
      <header className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 text-micro font-semibold text-muted-foreground">
          <RouteIcon className="size-3.5" />
          Route
        </span>
        <RefChip id={o.id} />
        {o.status === "chosen" ? <span className="rounded-full bg-meet px-2 py-0.5 text-micro font-semibold text-background">chosen</span> : null}
        <span className="tabular ml-auto text-meta text-muted-foreground">
          {counts.get("committed") ?? 0} of {plural(steps.length, "step", "steps")} committed
        </span>
      </header>
      <h3 className={cn("text-lead leading-snug font-semibold text-balance", o.status === "withdrawn" && "line-through decoration-faint")}>{o.title}</h3>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
        {bar.map(([stage, cls]) => (counts.get(stage) ? <div key={stage} className={cn("h-full transition-all", cls)} style={{ width: `${((counts.get(stage) ?? 0) / steps.length) * 100}%` }} /> : null))}
      </div>
      <p className="text-micro text-muted-foreground">
        {[
          ...STAGES.map(([stage, label]) => (counts.get(stage) ? `${counts.get(stage)} ${label.toLowerCase()}` : ""))
            .filter(Boolean)
            .reverse(),
          ...(unchecked ? [`${unchecked} done without a check`] : []),
          ...(findings ? [`${plural(findings, "finding", "findings")} in review`] : []),
        ].join(" · ")}
      </p>
      <ol className="flex flex-col gap-3 border-t border-border/70 pt-3">
        {steps.map((n) => (
          <StepRow key={n.id} n={n} table={table} room={room} />
        ))}
      </ol>
    </section>
  );
}

/** Every option that has steps on it, the chosen ones first. */
export function RouteCards({ table, room }: { table: TableState; room: RoomState }) {
  const routes = table.options
    .filter((o) => table.next.some((n) => n.target === o.id))
    .sort((a, b) => Number(b.status === "chosen") - Number(a.status === "chosen") || a.seq - b.seq);
  if (!routes.length) return null;
  return (
    <div id="board-routes" className="flex scroll-mt-6 flex-col gap-4">
      {routes.map((o) => (
        <RouteCard key={o.id} o={o} steps={table.next.filter((n) => n.target === o.id)} table={table} room={room} />
      ))}
    </div>
  );
}
