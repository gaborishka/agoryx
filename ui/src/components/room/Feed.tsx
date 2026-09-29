import { ColumnsIcon, EyeOffIcon, RowsIcon, SplitIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Markdown } from "@/components/md/Markdown";
import { OpCards } from "@/components/table/OpCard";
import { useNow } from "@/hooks/use-now";
import { names, secs } from "@/lib/format";
import { buildFeed, type FeedItem, type FeedModel, type FeedRow, nameOf } from "@/lib/room";
import { useStore } from "@/lib/store";
import type { TableOp, TurnState } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Avatar, Name, Tip } from "./bits";
import { AgentMessage, CommitLine, DecisionLine, DocLine, Fresh, HumanMessage, PassLine, StandaloneOp, SystemLine } from "./Messages";
import { ActivityList } from "./Trace";

function Hello() {
  const room = useStore((s) => s.snap?.state);
  if (!room) return null;
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-16 text-center">
      <div className="flex -space-x-2">
        {room.agents.map((a) => (
          <Avatar key={a.id} handle={a.id} size={44} className="ring-4 ring-background" />
        ))}
      </div>
      <h2 className="text-xl font-semibold tracking-tight text-balance">Кімната готова</h2>
      <p className="text-[14.5px] leading-relaxed text-pretty text-muted-foreground">
        Напишіть, що треба зробити чи обговорити. {names(room.agents.map((a) => a.label))} спершу відповідять одночасно й незалежно, а далі говоритимуть по
        черзі — з усім, що вже сказано в кімнаті.
      </p>
    </div>
  );
}

function LiveTurn({ turn, ops }: { turn: TurnState; ops?: TableOp[] }) {
  const stream = useStore((s) => s.snap?.streams[turn.id]?.text ?? "");
  const room = useStore((s) => s.snap?.state);
  const now = useNow(true);
  const elapsed = secs(now - new Date(turn.startedAt).getTime());
  const last = turn.activity.slice(-4);
  const current = turn.activity.at(-1);
  const label = current?.kind === "thinking" ? "міркує" : current?.kind === "command" ? "виконує команду" : current?.kind === "edit" ? "пише файл" : current?.kind === "read" ? "читає" : current?.kind === "web" ? "шукає в мережі" : "працює";
  return (
    <article className="relative min-w-0 rounded-2xl border border-border bg-card/80 p-4 shadow-soft sm:p-5">
      <header className="flex items-center gap-2">
        <Avatar handle={turn.agent} size={28} live />
        <Name handle={turn.agent} className="text-[14.5px]" />
        <Shimmer as="span" className="text-[13px]" duration={1.6}>
          {`${label}…`}
        </Shimmer>
        <span className="tabular ml-auto text-xs text-faint">{elapsed}</span>
      </header>
      {last.length ? <ActivityList items={last} className="mt-3" /> : null}
      {stream ? (
        <div className="mt-2">
          <Markdown text={stream.length > 2400 ? `…${stream.slice(-2400)}` : stream} streaming />
        </div>
      ) : !last.length ? (
        <p className="mt-2 text-[13px] text-muted-foreground">
          Читає нове в кімнаті{room ? ` (${nameOf(room, turn.agent)} бачить усе до цього моменту)` : ""}…
        </p>
      ) : null}
      <OpCards ops={ops} />
    </article>
  );
}

function Item({ item, model, fresh, card, clamp }: { item: FeedItem; model: FeedModel; fresh: boolean; card?: boolean; clamp?: number }) {
  if (item.type === "commit") return <CommitLine c={item.c} />;
  if (item.type === "doc") return <DocLine r={item.r} />;
  if (item.type === "op") return <StandaloneOp op={item.op} />;
  const m = item.m;
  const turn = m.turnId ? model.turns.get(m.turnId) : undefined;
  const ops = m.turnId ? model.opsByTurn.get(m.turnId) : undefined;
  const docs = m.turnId ? model.docByTurn.get(m.turnId) : undefined;
  let body;
  if (m.kind === "pass") body = <PassLine m={m} turn={turn} ops={ops} docs={docs} />;
  else if (m.kind === "system") body = <SystemLine m={m} />;
  else if (m.kind === "decision") body = <DecisionLine m={m} />;
  else if (m.kind === "human") body = <HumanMessage m={m} />;
  else body = <AgentMessage m={m} turn={turn} ops={ops} docs={docs} card={card} clamp={clamp} />;
  return (
    <Fresh fresh={fresh} id={`m-${m.id}`} className="h-full scroll-mt-6 rounded-2xl">
      {body}
    </Fresh>
  );
}

/** A thin label over replies written at the same moment: the order below is not a conversation. */
function RoundMark({ blind, text, title, handles, action }: { blind: boolean; text: string; title?: string; handles: string[]; action?: ReactNode }) {
  const Icon = blind ? EyeOffIcon : SplitIcon;
  return (
    <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
      <div className="flex -space-x-1.5">
        {handles.map((h) => (
          <Avatar key={h} handle={h} size={18} className="ring-2 ring-background" />
        ))}
      </div>
      <Tip tip={title ?? text}>
        <span className="flex min-w-0 items-center gap-1.5">
          <Icon className="size-3.5 shrink-0" />
          <b className="font-semibold text-foreground">{blind ? "Незалежно" : "Одночасно"}</b>
          <span className="hidden truncate sm:inline">— {text}</span>
        </span>
      </Tip>
      <span className="h-px min-w-4 flex-1 bg-border" />
      {action}
    </div>
  );
}

/**
 * Replies written at the same moment, none of them seeing the others. They read like any other
 * messages, under a label that says so; comparing them side by side is a choice, not the default.
 */
function Round({ row, model, isFresh }: { row: Extract<FeedRow, { type: "group" }>; model: FeedModel; isFresh: (id: string) => boolean }) {
  const [compare, setCompare] = useState(false);
  const agents = row.items.every((g) => g.m.kind === "agent");
  const canCompare = agents && row.items.length > 1 && row.items.length <= 3;
  const side = compare && canCompare;
  const toggle = canCompare ? (
    <button
      type="button"
      onClick={() => setCompare(!side)}
      aria-pressed={side}
      className={cn(
        "hidden h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium transition md:inline-flex",
        side ? "bg-accent text-foreground" : "text-primary hover:bg-accent",
      )}
    >
      {side ? <RowsIcon className="size-3.5" /> : <ColumnsIcon className="size-3.5" />}
      {side ? "По черзі" : "Порівняти"}
    </button>
  ) : null;
  const mark = <RoundMark blind={row.blind} text={row.text} title={row.title} handles={row.items.map((g) => g.m.author)} action={toggle} />;
  if (!side) {
    return (
      <div className="flex w-full max-w-[860px] flex-col gap-6 sm:px-2">
        {mark}
        {row.items.map((g) => (
          <Item key={g.key} item={g} model={model} fresh={isFresh(g.m.id)} clamp={720} />
        ))}
      </div>
    );
  }
  return (
    <section className="@container flex w-full flex-col gap-3">
      <div className="mx-auto w-full max-w-[860px] sm:px-2">{mark}</div>
      <div className="grid items-start gap-3 @3xl:grid-cols-2">
        {row.items.map((g) => (
          <Item key={g.key} item={g} model={model} fresh={isFresh(g.m.id)} card clamp={440} />
        ))}
      </div>
    </section>
  );
}

/** Scroll to a flashed message (m-<id>) once it exists. */
function FlashTarget() {
  const flash = useStore((s) => s.flash);
  const { stopScroll } = useStickToBottomContext();
  useEffect(() => {
    if (!flash || !flash.ref.startsWith("m-")) return;
    const node = document.getElementById(flash.ref);
    if (!node) return;
    stopScroll();
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    node.classList.remove("animate-flash");
    void node.offsetWidth;
    node.classList.add("animate-flash");
  }, [flash, stopScroll]);
  return null;
}

export function Feed() {
  const state = useStore((s) => s.snap?.state);
  const ops = useStore((s) => s.snap?.ops);
  const seen = useStore((s) => s.seen);
  const model = useMemo(() => (state && ops ? buildFeed(state, ops) : null), [state, ops]);
  const firstPaint = useRef(true);
  useEffect(() => {
    firstPaint.current = false;
    if (!state) return;
    for (const m of state.messages) seen.add(m.id);
  });
  if (!state || !model) return null;
  const isFresh = (id: string) => !firstPaint.current && !seen.has(id);
  return (
    <Conversation className="min-h-0 flex-1" initial="instant">
      {/* Wide enough to compare a round side by side; messages keep a reading width. */}
      <ConversationContent className="mx-auto w-full max-w-[1160px] items-center gap-6 px-3 pt-6 pb-10 sm:px-6">
        <FlashTarget />
        {model.rows.map((row) => {
          if (row.type === "hello") return <Hello key={row.key} />;
          if (row.type === "group") return <Round key={row.key} row={row} model={model} isFresh={isFresh} />;
          return (
            <div key={row.key} className="w-full max-w-[860px] sm:px-2">
              <Item item={row} model={model} fresh={row.type === "msg" && isFresh(row.m.id)} clamp={720} />
            </div>
          );
        })}
        {model.live.length ? (
          <section className="flex w-full max-w-[860px] flex-col gap-3 sm:px-2">
            {model.liveDivider ? (
              <RoundMark blind text={model.liveDivider} handles={model.live.map((t) => t.agent)} />
            ) : null}
            {model.live.map((turn) => (
              <LiveTurn key={turn.id} turn={turn} ops={model.opsByTurn.get(turn.id)} />
            ))}
          </section>
        ) : null}
      </ConversationContent>
      <ConversationScrollButton className="bottom-4 shadow-lift" title="Донизу" />
    </Conversation>
  );
}
