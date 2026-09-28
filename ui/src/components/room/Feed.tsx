import { useEffect, useMemo, useRef } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Markdown } from "@/components/md/Markdown";
import { OpCards } from "@/components/table/OpCard";
import { useNow } from "@/hooks/use-now";
import { secs } from "@/lib/format";
import { buildFeed, type FeedItem, type FeedModel, nameOf } from "@/lib/room";
import { useStore } from "@/lib/store";
import type { TableOp, TurnState } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Avatar, Divider, Name } from "./bits";
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
    <article className="relative min-w-0 rounded-2xl border border-dashed border-border bg-card/60 p-4">
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
          <Markdown text={stream.length > 6000 ? stream.slice(-6000) : stream} streaming />
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

function Item({ item, model, fresh, card }: { item: FeedItem; model: FeedModel; fresh: boolean; card?: boolean }) {
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
  else body = <AgentMessage m={m} turn={turn} ops={ops} docs={docs} card={card} />;
  return (
    <Fresh fresh={fresh} id={`m-${m.id}`} className="h-full scroll-mt-6 rounded-2xl">
      {body}
    </Fresh>
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
      <ConversationContent className="mx-auto w-full max-w-[860px] gap-6 px-4 pt-6 pb-10 @container sm:px-8">
        <FlashTarget />
        {model.rows.map((row) => {
          if (row.type === "hello") return <Hello key={row.key} />;
          if (row.type === "group") {
            const columns = row.items.length <= 3 && row.items.every((g) => g.m.kind === "agent");
            return (
              <section key={row.key} className="flex flex-col gap-4">
                <Divider title={row.title}>{row.text}</Divider>
                <div className={cn("flex flex-col gap-6", columns && "@3xl:grid @3xl:grid-cols-2 @3xl:items-start @3xl:gap-4")}>
                  {row.items.map((g) => (
                    <Item key={g.key} item={g} model={model} fresh={isFresh(g.m.id)} card={columns} />
                  ))}
                </div>
              </section>
            );
          }
          return <Item key={row.key} item={row} model={model} fresh={row.type === "msg" && isFresh(row.m.id)} />;
        })}
        {model.liveDivider ? <Divider>{model.liveDivider}</Divider> : null}
        {model.live.length ? (
          <div className={cn("flex flex-col gap-4", model.live.length > 1 && "@3xl:grid @3xl:grid-cols-2 @3xl:items-start")}>
            {model.live.map((turn) => (
              <LiveTurn key={turn.id} turn={turn} ops={model.opsByTurn.get(turn.id)} />
            ))}
          </div>
        ) : null}
      </ConversationContent>
      <ConversationScrollButton className="bottom-4 shadow-lift" title="Донизу" />
    </Conversation>
  );
}
