import { FileTextIcon, GitCommitHorizontalIcon, GavelIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import { motion } from "motion/react";
import { memo, type ReactNode } from "react";
import { Markdown } from "@/components/md/Markdown";
import { OpCard, OpCards } from "@/components/table/OpCard";
import { cost, isSysError, passNote, plural, secs, sysText } from "@/lib/format";
import { participant } from "@/lib/room";
import { useStore } from "@/lib/store";
import type { DocRevision, MessageEntry, TableOp, TurnState } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Avatar, Name, NativeBadge, NativeTag, Stats, Time } from "./bits";
import { Clamp } from "./Clamp";
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
      {turn.status === "error" ? <span className="rounded-full bg-destructive-soft px-2 text-[11px] font-medium text-destructive">помилка</span> : null}
      {turn.status === "interrupted" ? <span className="rounded-full bg-amber-soft px-2 text-[11px] font-medium text-amber">перервано</span> : null}
    </>
  );
}

const railTone = { claude: "bg-claude/35", codex: "bg-codex/35", human: "bg-human/35", sys: "bg-border" } as const;

const cardTone = { claude: "before:bg-claude", codex: "before:bg-codex", human: "before:bg-human", sys: "before:bg-border" } as const;

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
        card &&
          "overflow-hidden rounded-2xl border border-border bg-card p-4 pt-5 shadow-soft before:absolute before:inset-x-0 before:top-0 before:h-[3px] sm:p-5 sm:pt-6",
        card && cardTone[p.tone],
      )}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Avatar handle={m.author} size={28} />
        <Name handle={m.author} className="text-[14.5px]" />
        <NativeTag m={m} />
        <Time iso={m.ts} />
        <TurnMeta turn={turn} />
      </header>
      <div className={cn("relative mt-1.5", !card && "pl-[38px]")}>
        {!card ? <span className={cn("absolute top-1 bottom-1 left-[13px] w-[2px] rounded-full opacity-0 transition group-hover/msg:opacity-100", railTone[p.tone])} /> : null}
        {clamp ? <Clamp max={clamp}>{text}</Clamp> : text}
        <OpCards ops={ops} compact={Boolean(clamp)} />
        <TurnBar turn={turn} docs={docs} compact={Boolean(clamp)} />
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
      <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <Avatar handle={m.author} size={20} />
        <span>
          <Name handle={m.author} /> {silent}
        </span>
      </div>
      {docs?.length || turn?.files?.length || ops?.length ? (
        <div className="pl-7">
          <OpCards ops={ops} />
          <TurnBar turn={turn} docs={docs} />
        </div>
      ) : null}
    </div>
  );
}

export function SystemLine({ m }: { m: MessageEntry }) {
  const err = isSysError(m.text);
  const Icon = err ? TriangleAlertIcon : InfoIcon;
  return (
    <div
      className={cn(
        "mx-auto flex max-w-[92%] items-start gap-2 rounded-xl px-3 py-2 text-[13px]",
        err ? "bg-destructive-soft text-destructive" : "text-muted-foreground",
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <Markdown text={sysText(m.text)} className="text-[13px] leading-relaxed" />
    </div>
  );
}

export function DecisionLine({ m }: { m: MessageEntry }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-primary/25 bg-secondary/70 px-4 py-3">
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
        <GavelIcon className="size-4" />
      </span>
      <div className="min-w-0">
        <div className="text-[11px] font-semibold tracking-wider text-primary uppercase">Рішення</div>
        <Markdown text={m.text} className="text-[14.5px]" />
      </div>
    </div>
  );
}

export function CommitLine({ c }: { c: { sha: string; subject: string; files: number } }) {
  const openDialog = useStore((s) => s.openDialog);
  return (
    <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <span className="grid size-5 place-items-center rounded-md bg-add text-add-ink">
        <GitCommitHorizontalIcon className="size-3.5" />
      </span>
      <span>
        Контрольна точка{" "}
        <button type="button" className="font-mono text-[12px] text-foreground underline decoration-border underline-offset-2 hover:decoration-current" onClick={() => openDialog({ kind: "commit", sha: c.sha })}>
          {c.sha.slice(0, 7)}
        </button>{" "}
        · {plural(c.files, "файл", "файли", "файлів")}
      </span>
    </div>
  );
}

export function DocLine({ r }: { r: DocRevision }) {
  const openDocRevision = useStore((s) => s.openDocRevision);
  const room = useStore((s) => s.snap?.state);
  const who = participant(room, r.by);
  return (
    <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
      <span className="grid size-5 place-items-center rounded-md bg-secondary text-primary">
        <FileTextIcon className="size-3.5" />
      </span>
      <span>
        <Name handle={r.by} /> змінює{" "}
        <button type="button" className="font-mono text-[12px] text-foreground underline decoration-border underline-offset-2 hover:decoration-current" onClick={() => openDocRevision(r.seq)}>
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
      <div className="mb-1.5 flex items-center gap-2 text-[13px] text-muted-foreground">
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
