import { FileTextIcon, GitCommitHorizontalIcon, GavelIcon, InfoIcon, RotateCcwIcon, TriangleAlertIcon, Undo2Icon } from "lucide-react";
import { motion } from "motion/react";
import { memo, type ReactNode } from "react";
import { Markdown } from "@/components/md/Markdown";
import { OpCard, OpCards } from "@/components/table/OpCard";
import { Button } from "@/components/ui/button";
import { cost, passNote, plural, secs } from "@/lib/format";
import { t } from "@/lib/i18n";
import { decisionOf, sysError, sysLine } from "@/lib/system";
import { ink, nameOf, participant } from "@/lib/room";
import { useStore } from "@/lib/store";
import type { DocRevision, MessageEntry, RevertEntry, TableOp, TurnState } from "@/lib/types";
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
      {turn.status === "error" ? <span className="rounded-full bg-destructive-soft px-2 text-micro font-medium text-destructive">помилка</span> : null}
      {turn.status === "interrupted" ? <span className="rounded-full bg-amber-soft px-2 text-micro font-medium text-amber">перервано</span> : null}
    </>
  );
}

const railTone = { claude: "bg-claude/35", codex: "bg-codex/35", human: "bg-human/35", sys: "bg-border" } as const;

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
  const text = <Markdown text={m.text} source={`m:${m.id}`} />;
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
        {!card ? <span className={cn("absolute top-1 bottom-1 left-[13px] w-[2px] rounded-full opacity-0 transition group-hover/msg:opacity-100", railTone[p.tone])} style={ink(p)} /> : null}
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
      <div className="max-w-full rounded-2xl rounded-br-md bg-human-soft px-4 py-2.5 text-foreground ring-1 ring-human/15">
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
    ? `без слів — ${ops.length === 1 ? "хід" : "ходи"} на столі`
    : turn?.files?.length || docs?.length
      ? "без слів — лише зміни"
      : `пропускає хід — ${note || "нема що додати"}`;
  return (
    <div>
      <div className="flex items-center gap-2 text-small text-muted-foreground">
        <Avatar handle={m.author} size={20} />
        <span>
          <Name handle={m.author} /> {silent}
        </span>
      </div>
      {docs?.length || turn?.files?.length || ops?.length ? (
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
          <Tip tip="Написано під час роботи — це ще не відповідь за хід">
            <span className="text-xs text-muted-foreground">по ходу</span>
          </Tip>
          <Time iso={m.ts} />
        </div>
        <Markdown text={m.text} className="text-ui leading-relaxed text-muted-foreground" />
      </div>
    </div>
  );
}

export function SystemLine({ m }: { m: MessageEntry }) {
  const room = useStore((s) => s.snap?.state);
  // A line an agent's action wrote (it is the author): say who, by the name the UI gives it.
  const who = m.author !== "agoryx" && m.author !== room?.human ? nameOf(room, m.author) : undefined;
  const err = sysError(m);
  const Icon = err ? TriangleAlertIcon : InfoIcon;
  return (
    <div
      className={cn(
        "mx-auto flex max-w-[92%] items-start gap-2 rounded-xl px-3 py-2 text-small",
        err ? "bg-destructive-soft text-destructive" : "text-muted-foreground",
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <Markdown text={sysLine(m, who)} className="text-small leading-relaxed" />
    </div>
  );
}

export function DecisionLine({ m }: { m: MessageEntry }) {
  // From its code, or read back from an older room's English; a line neither covers shows as written.
  const d = decisionOf(m);
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-primary/25 bg-secondary/70 px-4 py-3">
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
        <GavelIcon className="size-4" />
      </span>
      <div className="min-w-0">
        <div className="text-micro font-semibold tracking-wider text-primary uppercase">{t.decision.title(d?.n)}</div>
        <Markdown text={d ? t.decision.body(d) : m.text} className="text-body" />
        {d ? <div className="text-meta text-muted-foreground">{t.decision.by(d.by)}</div> : null}
      </div>
    </div>
  );
}

export function CommitLine({ c }: { c: { sha: string; subject: string; files: number } }) {
  const openChanges = useStore((s) => s.openChanges);
  const openDialog = useStore((s) => s.openDialog);
  const driven = useStore((s) => s.snap?.driven);
  return (
    <div className="group flex flex-wrap items-center gap-2 text-small text-muted-foreground">
      <span className="grid size-5 place-items-center rounded-md bg-add text-add-ink">
        <GitCommitHorizontalIcon className="size-3.5" />
      </span>
      <span>
        Контрольна точка{" "}
        <button type="button" className="font-mono text-meta text-foreground underline decoration-border underline-offset-2 hover:decoration-current" onClick={() => openChanges({ scope: "commit", sha: c.sha })}>
          {c.sha.slice(0, 7)}
        </button>{" "}
        · {plural(c.files, "файл", "файли", "файлів")}
      </span>
      {driven ? (
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground opacity-70 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
          onClick={() => openDialog({ kind: "revert", sha: c.sha })}
        >
          <RotateCcwIcon />
          Повернути теку сюди
        </Button>
      ) : null}
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
  const files = plural(r.total, "файл", "файли", "файлів");
  const where = r.fromRoom ? <> з кімнати «{r.fromRoom.name}»</> : null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-small text-muted-foreground">
      <span className="grid size-5 place-items-center rounded-md bg-secondary text-primary">
        <RotateCcwIcon className="size-3.5" />
      </span>
      <span>
        <Name handle={r.by} />{" "}
        {r.undoOf !== undefined ? (
          <>
            скасовує повернення теки{where} · {files}
          </>
        ) : (
          <>
            повертає теку до контрольної точки{" "}
            <button type="button" className="font-mono text-meta text-foreground underline decoration-border underline-offset-2 hover:decoration-current" onClick={() => openChanges({ scope: "commit", sha: r.to })}>
              {r.to.slice(0, 7)}
            </button>
            {where} · {files}
          </>
        )}
      </span>
      {r.left?.length ? (
        <Tip tip={`Не вдалося повернути: ${r.left.join(", ")}`}>
          <span className="text-destructive">не все</span>
        </Tip>
      ) : null}
      {r.undone !== undefined ? (
        <span className="text-faint">скасовано</span>
      ) : driven && undoable ? (
        <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-foreground" onClick={() => openDialog({ kind: "revert", undo: r.seq })}>
          <Undo2Icon />
          Скасувати повернення
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
          <Tip tip="Файл змінився, поки ходи йшли паралельно, і кімната не бачить, чий це хід.">
            <span>
              {r.among.map((id, i) => (
                <span key={id}>
                  {i ? " або " : ""}
                  <Name handle={id} />
                </span>
              ))}
            </span>
          </Tip>
        ) : (
          <Name handle={r.by} />
        )}{" "}
        змінює{" "}
        <button type="button" className="font-mono text-meta text-foreground underline decoration-border underline-offset-2 hover:decoration-current" onClick={() => openDocRevision(r.seq)}>
          {r.path}
        </button>
      </span>
      <Stats added={r.added} removed={r.removed} deleted={r.deleted} />
      {r.native && who.agent ? <NativeBadge agent={r.by} label="у своїй сесії" tip={`Змінено в рідній сесії ${who.label}, поза ходом у кімнаті.`} /> : null}
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
        <span>на столі</span>
        {who.agent && !op.turnId ? <NativeBadge agent={op.by} label="у своїй сесії" tip={`Зроблено з рідної сесії ${who.label}, поза ходом у кімнаті.`} /> : null}
      </div>
      <div className="pl-7">
        <OpCard o={op} />
      </div>
    </div>
  );
}
