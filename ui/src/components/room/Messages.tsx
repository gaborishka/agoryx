import { ChevronRightIcon, FileTextIcon, GitCommitHorizontalIcon, InfoIcon, RotateCcwIcon, TriangleAlertIcon, Undo2Icon } from "lucide-react";
import { motion } from "motion/react";
import { memo, useState, type ReactNode } from "react";
import { Mark } from "@/components/brand/Mark";
import { Markdown } from "@/components/md/Markdown";
import { OpCard, OpCards, RefChip } from "@/components/table/OpCard";
import { Button } from "@/components/ui/button";
import { cost, passNote, plural, secs } from "@/lib/format";
import { t } from "@/lib/i18n";
import { decisionOf, sysError, sysLine, sysRisk } from "@/lib/system";
import { ink, nameOf, participant } from "@/lib/room";
import { useStore } from "@/lib/store";
import type { DocRevision, MessageEntry, RevertEntry, TableItem, TableOp, TurnState } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Avatar, Name, NativeBadge, NativeTag, Stats, Time, Tip } from "./bits";
import { Clamp } from "@/components/common/Clamp";
import { TurnBar } from "./Trace";

export function Fresh({ fresh, children, className, id }: { fresh: boolean; children: ReactNode; className?: string; id?: string }) {
  if (!fresh) {
    return (
      <div id={id} className={className}>
        {children}
      </div>
    );
  }
  return (
    <motion.div id={id} className={className} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, ease: [0.2, 0, 0, 1] }}>
      {children}
    </motion.div>
  );
}

function TurnMeta({ turn }: { turn?: TurnState }) {
  if (!turn) return null;
  const bits = [secs(turn.durationMs), cost(turn.usage?.costUsd)].filter(Boolean);
  return (
    <>
      {bits.length ? <span className="tabular text-xs text-faint">{bits.join(" · ")}</span> : null}
      {turn.status === "error" ? <span className="rounded-full bg-destructive-soft px-2 text-micro font-medium text-destructive">error</span> : null}
      {turn.status === "interrupted" ? <span className="rounded-full bg-amber-soft px-2 text-micro font-medium text-amber">interrupted</span> : null}
    </>
  );
}

/** The voice rail: always there, faint; the whole voice lights up while the reader is on the turn. */
const railTone = {
  claude: "bg-claude/40 group-hover/msg:bg-claude/85",
  codex: "bg-codex/40 group-hover/msg:bg-codex/85",
  human: "bg-human/40 group-hover/msg:bg-human/85",
  sys: "bg-border",
} as const;

const cardTone = { claude: "bg-claude", codex: "bg-codex", human: "bg-human", sys: "bg-border" } as const;

export const AgentMessage = memo(function AgentMessage({
  m,
  turn,
  ops,
  docs,
  card,
  clamp,
}: {
  m: MessageEntry;
  turn?: TurnState;
  ops?: TableOp[];
  docs?: DocRevision[];
  card?: boolean;
  /** Fold a long reply to this height (px); the rest opens on demand. */
  clamp?: number;
}) {
  const room = useStore((s) => s.snap?.state);
  const p = participant(room, m.author);
  const text = (
    <div data-quote={m.id} data-author={m.author}>
      <Markdown text={m.text} source={`m:${m.id}`} />
    </div>
  );
  return (
    <article
      className={cn(
        "group/msg relative min-w-0",
        card && "overflow-hidden rounded-2xl border border-border bg-card p-4 pt-5 shadow-soft sm:p-5 sm:pt-6",
      )}
    >
      {/* The stripe is its own element: the agent's shade must not reach other agents' colours inside the card. */}
      {card ? <span aria-hidden className={cn("absolute inset-x-0 top-0 h-[3px]", cardTone[p.tone])} style={ink(p)} /> : null}
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Avatar handle={m.author} size={28} />
        <Name handle={m.author} className="text-body" />
        <NativeTag m={m} />
        <Time iso={m.ts} />
        <TurnMeta turn={turn} />
      </header>
      <div className={cn("relative mt-1.5", !card && "pl-[38px]")}>
        {!card ? <span aria-hidden className={cn("absolute top-0.5 bottom-1 left-[13px] w-[2px] rounded-full transition-colors duration-300", railTone[p.tone])} style={ink(p)} /> : null}
        {clamp ? <Clamp max={clamp}>{text}</Clamp> : text}
        <OpCards ops={ops} compact={Boolean(clamp)} />
        <TurnBar turn={turn} docs={docs} compact={Boolean(clamp)} text={m.text} />
      </div>
    </article>
  );
});

export const HumanMessage = memo(function HumanMessage({ m }: { m: MessageEntry }) {
  return (
    <div className="flex flex-col items-end gap-1 pl-[12%]">
      <div data-quote={m.id} data-author={m.author} className="max-w-full rounded-[20px] rounded-br-[6px] bg-human-soft px-4 py-2.5 text-foreground ring-1 ring-human/20">
        <Markdown text={m.text} source={`m:${m.id}`} />
      </div>
      <div className="flex items-center gap-2 pr-1">
        <NativeTag m={m} />
        <Time iso={m.ts} />
      </div>
    </div>
  );
});

export function PassLine({ m, turn, ops, docs }: { m: MessageEntry; turn?: TurnState; ops?: TableOp[]; docs?: DocRevision[] }) {
  const note = passNote(m.text);
  const silent = ops?.length
    ? `said nothing, made ${ops.length === 1 ? "a move" : "moves"} on the table`
    : turn?.files?.length || docs?.length
      ? "said nothing, only made changes"
      : `passes — ${note || "nothing to add"}`;
  return (
    <div>
      <div className="flex items-center gap-2 text-small text-muted-foreground">
        <Avatar handle={m.author} size={20} />
        <span>
          <Name handle={m.author} /> {silent}
        </span>
      </div>
      {docs?.length || turn?.files?.length || turn?.activity.length || ops?.length ? (
        <div className="pl-7">
          <OpCards ops={ops} />
          <TurnBar turn={turn} docs={docs} text={m.text} />
        </div>
      ) : null}
    </div>
  );
}

/** What an agent said while it worked (`agoryx say`): a line in the flow, not a turn's reply. */
export function UpdateLine({ m }: { m: MessageEntry }) {
  return (
    <div className="flex items-start gap-2 text-ui">
      <Avatar handle={m.author} size={20} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <Name handle={m.author} />
          <Tip tip="Written while working — not the turn’s reply yet">
            <span className="text-xs text-muted-foreground">while working</span>
          </Tip>
          <Time iso={m.ts} />
        </div>
        <div data-quote={m.id} data-author={m.author}>
          <Markdown text={m.text} className="text-ui leading-relaxed text-muted-foreground" />
        </div>
      </div>
    </div>
  );
}

export function SystemLine({ m }: { m: MessageEntry }) {
  const room = useStore((s) => s.snap?.state);
  // A line an agent's action wrote (it is the author): say who, by the name the UI gives it.
  const who = m.author !== "agoryx" && m.author !== room?.human ? nameOf(room, m.author) : undefined;
  const err = sysError(m);
  const risk = !err && sysRisk(m);
  const Icon = err || risk ? TriangleAlertIcon : InfoIcon;
  return (
    <div
      className={cn(
        "mx-auto flex max-w-[92%] items-start gap-2 rounded-xl px-3 py-2 text-small",
        err ? "bg-destructive-soft text-destructive" : risk ? "bg-amber-soft text-amber-ink" : "text-muted-foreground",
      )}
      data-risk={risk || undefined}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <Markdown text={sysLine(m, who)} className="text-small leading-relaxed" />
    </div>
  );
}

export function DecisionLine({ m }: { m: MessageEntry }) {
  // From its code, or read back from an older room's English; a line neither covers shows as written.
  const d = decisionOf(m);
  const [why, setWhy] = useState(false);
  return (
    // What the room settled is the one place the page turns over. The card holds the decision itself;
    // the reasons open on demand, so a run of decisions stays a list of headlines, not a wall.
    <div className="settled flex w-fit max-w-full items-start gap-3 rounded-2xl px-4 py-3">
      <Mark className="mt-[3px] size-4" />
      <div className="min-w-0">
        <div className="text-meta text-muted-foreground">
          {t.decision.title(d?.n)}
          {d ? ` · ${t.decision.by(d.by)}` : null}
        </div>
        {d ? (
          <div className="mt-0.5 flex items-baseline gap-2">
            <span className="shrink-0 rounded-md bg-secondary px-1.5 font-mono text-meta">{d.option}</span>
            <span className="font-display text-lead font-[650] text-meet-ink">{d.title}</span>
          </div>
        ) : (
          <Markdown text={m.text} className="text-body" />
        )}
        {d?.note ? (
          <>
            <button
              type="button"
              aria-expanded={why}
              onClick={() => setWhy((v) => !v)}
              className="mt-1 -ml-1 inline-flex items-center gap-0.5 rounded-md px-1 text-meta text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-current"
            >
              <ChevronRightIcon className={cn("size-3.5 transition-transform", why && "rotate-90")} />
              {t.decision.why}
            </button>
            {why ? <Markdown text={d.note} className="mt-1 max-w-[68ch] text-body" /> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

/** The steps a commit took, each a link to it on the table. */
function CommittedSteps({ steps }: { steps: TableItem[] }) {
  return (
    <>
      {steps.map((n, i) => (
        <span key={n.id} className="inline-flex min-w-0 items-baseline gap-1">
          {i ? "," : ""}
          <RefChip id={n.id} />
          <span className="max-w-[32ch] truncate text-foreground">{n.text.split("\n")[0]}</span>
        </span>
      ))}
    </>
  );
}

export function CommitLine({ c }: { c: { sha: string; subject: string; files: number; internal?: boolean; workspace?: string } }) {
  const openChanges = useStore((s) => s.openChanges);
  const openDialog = useStore((s) => s.openDialog);
  const driven = useStore((s) => s.snap?.driven);
  const workspace = useStore((s) => s.snap?.state.workspace);
  const next = useStore((s) => s.snap?.state.table.next);
  const steps = next?.filter((n) => n.commit?.by === "agoryx" && n.commit.sha === c.sha) ?? [];
  return (
    <div className="group flex flex-wrap items-center gap-2 text-small text-muted-foreground">
      <span className="grid size-5 place-items-center rounded-md bg-add text-add-ink">
        <GitCommitHorizontalIcon className="size-3.5" />
      </span>
      <span>
        {c.internal ? "Recovery snapshot" : "Checkpoint"}{" "}
        <button type="button" className="font-mono text-meta text-foreground underline decoration-border underline-offset-2 hover:decoration-current" onClick={() => openChanges({ scope: "commit", sha: c.sha })}>
          {c.sha.slice(0, 7)}
        </button>{" "}
        · {plural(c.files, "file", "files")}
      </span>
      {steps.length ? (
        <span className="inline-flex min-w-0 flex-wrap items-baseline gap-1">
          with <CommittedSteps steps={steps} />
        </span>
      ) : null}
      {driven && (!c.workspace || c.workspace === workspace) ? (
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground opacity-70 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
          onClick={() => openDialog({ kind: "revert", sha: c.sha })}
        >
          <RotateCcwIcon />
          Revert folder to here
        </Button>
      ) : null}
    </div>
  );
}

/** A step went into a commit of its author's or the human's own: the commit opens in Changes. */
export function StepCommitLine({ sha, by, steps }: { sha: string; by: string; steps: TableItem[] }) {
  const openChanges = useStore((s) => s.openChanges);
  const who = useStore((s) => (s.snap ? nameOf(s.snap.state, by) : by));
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-muted-foreground">
      <span className="grid size-5 place-items-center rounded-md bg-primary text-primary-foreground">
        <GitCommitHorizontalIcon className="size-3.5" />
      </span>
      <span>
        {who} committed {steps.length > 1 ? "steps" : "step"}
      </span>
      <CommittedSteps steps={steps} />
      <span>
        as{" "}
        <button type="button" className="font-mono text-meta text-foreground underline decoration-border underline-offset-2 hover:decoration-current" onClick={() => openChanges({ scope: "commit", sha })}>
          {sha.slice(0, 7)}
        </button>
      </span>
    </div>
  );
}

/** The human returned the folder to a checkpoint (or undid that): only files moved, the conversation stays. */
export function RevertLine({ r }: { r: RevertEntry }) {
  const openChanges = useStore((s) => s.openChanges);
  const openDialog = useStore((s) => s.openDialog);
  const driven = useStore((s) => s.snap?.driven);
  // Only this room's latest return can be undone, never an undo (that would redo it) nor another room's.
  const undoable = useStore((s) => {
    const last = s.snap?.state.reverts?.filter((entry) => !entry.fromRoom).at(-1);
    return last?.seq === r.seq && last.undoOf === undefined && last.undone === undefined;
  });
  const files = plural(r.total, "file", "files");
  const where = r.fromRoom ? <> from room “{r.fromRoom.name}”</> : null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-small text-muted-foreground">
      <span className="grid size-5 place-items-center rounded-md bg-secondary text-primary">
        <RotateCcwIcon className="size-3.5" />
      </span>
      <span>
        <Name handle={r.by} />{" "}
        {r.undoOf !== undefined ? (
          <>
            undoes the folder revert{where} · {files}
          </>
        ) : (
          <>
            reverts the folder to checkpoint{" "}
            <button type="button" className="font-mono text-meta text-foreground underline decoration-border underline-offset-2 hover:decoration-current" onClick={() => openChanges({ scope: "commit", sha: r.to })}>
              {r.to.slice(0, 7)}
            </button>
            {where} · {files}
          </>
        )}
      </span>
      {r.left?.length ? (
        <Tip tip={`Couldn’t revert: ${r.left.join(", ")}`}>
          <span className="text-destructive">partial</span>
        </Tip>
      ) : null}
      {r.undone !== undefined ? (
        <span className="text-faint">undone</span>
      ) : driven && undoable ? (
        <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-foreground" onClick={() => openDialog({ kind: "revert", undo: r.seq })}>
          <Undo2Icon />
          Undo revert
        </Button>
      ) : null}
    </div>
  );
}

export function DocLine({ r }: { r: DocRevision }) {
  const openDocRevision = useStore((s) => s.openDocRevision);
  const room = useStore((s) => s.snap?.state);
  const who = participant(room, r.by);
  return (
    <div className="flex flex-wrap items-center gap-2 text-small text-muted-foreground">
      <span className="grid size-5 place-items-center rounded-md bg-secondary text-primary">
        <FileTextIcon className="size-3.5" />
      </span>
      <span>
        {r.among ? (
          <Tip tip="The file changed while turns ran in parallel, and the room can’t tell whose turn it was.">
            <span>
              {r.among.map((id, i) => (
                <span key={id}>
                  {i ? " or " : ""}
                  <Name handle={id} />
                </span>
              ))}
            </span>
          </Tip>
        ) : (
          <Name handle={r.by} />
        )}{" "}
        changes{" "}
        <button type="button" className="font-mono text-meta text-foreground underline decoration-border underline-offset-2 hover:decoration-current" onClick={() => openDocRevision(r.seq)}>
          {r.path}
        </button>
      </span>
      <Stats added={r.added} removed={r.removed} deleted={r.deleted} />
      {r.native && who.agent ? <NativeBadge agent={r.by} label="in own session" tip={`Changed in ${who.label}’s own session, outside a room turn.`} /> : null}
    </div>
  );
}

export function StandaloneOp({ op }: { op: TableOp }) {
  const room = useStore((s) => s.snap?.state);
  const who = participant(room, op.by);
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 text-small text-muted-foreground">
        <Avatar handle={op.by} size={20} />
        <Name handle={op.by} />
        <span>on the table</span>
        {who.agent && !op.turnId ? <NativeBadge agent={op.by} label="in own session" tip={`Done from ${who.label}’s own session, outside a room turn.`} /> : null}
      </div>
      <div className="pl-7">
        <OpCard o={op} />
      </div>
    </div>
  );
}
