import { ColumnsIcon, EyeOffIcon, RowsIcon, SplitIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Markdown } from "@/components/md/Markdown";
import { OpCards } from "@/components/table/OpCard";
import { useNow } from "@/hooks/use-now";
import { secs } from "@/lib/format";
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
        Напишіть, що треба зробити чи обговорити. {room.agents.map((a) => a.label).join(" і ")} спершу відповідять одночасно й незалежно, а далі говоритимуть по
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

type Layout = "side" | "stack";

/** Say which layout the rounds use, once, for every round in the room. */
const readLayout = (): Layout => {
  try {
    return localStorage.getItem("agoryx.round") === "stack" ? "stack" : "side";
  } catch {
    return "side";
  }
};

/**
 * Replies written at the same moment, none of them seeing the others. Side by side they read as a
 * comparison; each is folded to a readable height so neither column runs for screens.
 */
function Round({ row, model, isFresh }: { row: Extract<FeedRow, { type: "group" }>; model: FeedModel; isFresh: (id: string) => boolean }) {
  const [layout, setLayout] = useState<Layout>(readLayout);
  const pick = (next: Layout) => {
    setLayout(next);
    try {
      localStorage.setItem("agoryx.round", next);
    } catch {
      // per-browser convenience only
    }
  };
  const agents = row.items.every((g) => g.m.kind === "agent");
  const side = layout === "side" && agents && row.items.length <= 3;
  const seg = (on: boolean) =>
    cn("inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium transition", on ? "bg-card text-foreground shadow-soft ring-1 ring-border" : "text-muted-foreground hover:text-foreground");
  return (
    <section className="@container flex w-full flex-col gap-3 rounded-[1.4rem] border border-border/80 bg-muted/45 p-2.5 sm:p-3">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-1.5 pt-1">
        <div className="flex -space-x-1.5">
          {row.items.map((g) => (
            <Avatar key={g.key} handle={g.m.author} size={24} className="ring-2 ring-muted" />
          ))}
        </div>
        <Tip tip={row.title}>
          <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
            {row.blind ? <EyeOffIcon className="size-3.5 shrink-0" /> : <SplitIcon className="size-3.5 shrink-0" />}
            <b className="font-semibold text-foreground">{row.blind ? "Незалежний раунд" : "Одночасно"}</b>
            <span className="hidden sm:inline">· {row.text}</span>
          </span>
        </Tip>
        {agents && row.items.length > 1 ? (
          <div className="ml-auto hidden items-center gap-0.5 rounded-lg bg-background/70 p-0.5 @3xl:flex" role="group" aria-label="Як показати відповіді">
            <button type="button" className={seg(side)} aria-pressed={side} onClick={() => pick("side")}>
              <ColumnsIcon className="size-3.5" />
              Поруч
            </button>
            <button type="button" className={seg(!side)} aria-pressed={!side} onClick={() => pick("stack")}>
              <RowsIcon className="size-3.5" />
              По черзі
            </button>
          </div>
        ) : null}
      </header>
      <div className={cn("flex flex-col gap-2.5", side && "@3xl:grid @3xl:grid-cols-2 @3xl:items-start")}>
        {row.items.map((g) => (
          <Item key={g.key} item={g} model={model} fresh={isFresh(g.m.id)} card={g.m.kind === "agent"} clamp={side ? 440 : 720} />
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
      {/* The column is wide enough for a round side by side; single messages keep a reading width. */}
      <ConversationContent className="mx-auto w-full max-w-[1160px] items-center gap-6 px-3 pt-6 pb-10 sm:px-6">
        <FlashTarget />
        {model.rows.map((row) => {
          if (row.type === "hello") return <Hello key={row.key} />;
          if (row.type === "group") return <Round key={row.key} row={row} model={model} isFresh={isFresh} />;
          return (
            <div key={row.key} className="w-full max-w-[860px] sm:px-2">
              <Item item={row} model={model} fresh={row.type === "msg" && isFresh(row.m.id)} />
            </div>
          );
        })}
        {model.live.length ? (
          <section
            className={cn(
              "@container flex w-full flex-col gap-3",
              model.live.length > 1 ? "rounded-[1.4rem] border border-dashed border-border bg-muted/30 p-2.5 sm:p-3" : "max-w-[860px] sm:px-2",
            )}
          >
            {model.liveDivider ? (
              <header className="flex items-center gap-1.5 px-1.5 pt-1 text-[13px] text-muted-foreground">
                <EyeOffIcon className="size-3.5" />
                <b className="font-semibold text-foreground">Незалежний раунд</b>
                <span className="hidden sm:inline">· {model.liveDivider}</span>
              </header>
            ) : null}
            <div className={cn("flex flex-col gap-2.5", model.live.length > 1 && "@3xl:grid @3xl:grid-cols-2 @3xl:items-start")}>
              {model.live.map((turn) => (
                <LiveTurn key={turn.id} turn={turn} ops={model.opsByTurn.get(turn.id)} />
              ))}
            </div>
          </section>
        ) : null}
      </ConversationContent>
      <ConversationScrollButton className="bottom-4 shadow-lift" title="Донизу" />
    </Conversation>
  );
}
