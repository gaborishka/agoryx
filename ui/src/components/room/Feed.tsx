import { ChevronDownIcon, ColumnsIcon, RowsIcon, SplitIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Markdown } from "@/components/md/Markdown";
import { OpCards } from "@/components/table/OpCard";
import { useNow } from "@/hooks/use-now";
import { clock, names, plural, secs } from "@/lib/format";
import { unquoted } from "../../../../internal/agora/quote";
import { buildFeed, type FeedItem, type FeedModel, type FeedRow, ink, nameOf, participant } from "@/lib/room";
import { useSeating, useStore } from "@/lib/store";
import type { TableOp, TurnState } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Avatar, Name, Tip } from "./bits";
import { AgentMessage, CommitLine, DecisionLine, DocLine, Fresh, HumanMessage, PassLine, RevertLine, StandaloneOp, StepCommitLine, SystemLine, UpdateLine } from "./Messages";
import { PrCard } from "./Github";
import { isThreadReport, ThreadCard } from "@/components/thread/ThreadCard";
import { ActivityList } from "./Trace";
import { QuoteSelection } from "./QuoteSelection";

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
      <h2 className="font-display text-[26px] font-[650] text-balance">The room is ready</h2>
      <p className="text-body leading-relaxed text-pretty text-muted-foreground">
        Write what needs doing or discussing. {names(room.agents.map((a) => a.label))} will start at the same time, from the same point, saying as they go who is doing what,
        and then talk in turns, with everything already said in the room.
      </p>
    </div>
  );
}

const liveTone = { claude: "bg-claude", codex: "bg-codex", human: "bg-human", sys: "bg-foreground/40" } as const;

function LiveTurn({ turn, ops }: { turn: TurnState; ops?: TableOp[] }) {
  const stream = useStore((s) => s.snap?.streams[turn.id]?.text ?? "");
  const room = useSeating();
  const now = useNow(true);
  const elapsed = secs(now - new Date(turn.startedAt).getTime());
  const last = turn.activity.slice(-4);
  const current = turn.activity.at(-1);
  const who = participant(room, turn.agent);
  const label = current?.kind === "thinking" ? "thinking" : current?.kind === "command" ? "running a command" : current?.kind === "edit" ? "writing a file" : current?.kind === "read" ? "reading" : current?.kind === "web" ? "searching the web" : current?.kind === "browser" ? "working in the browser" : "working";
  return (
    <article className="relative min-w-0 overflow-hidden rounded-2xl border border-border bg-card p-4 pt-5 shadow-soft sm:p-5 sm:pt-6">
      {/* The working voice's band, breathing while the turn runs. */}
      <span aria-hidden className={cn("live-band absolute inset-x-0 top-0 h-[3px]", liveTone[who.tone])} style={ink(who)} />
      <header className="flex items-center gap-2">
        <Avatar handle={turn.agent} size={28} live />
        <Name handle={turn.agent} className="text-body" />
        <Shimmer as="span" className="text-small" duration={1.6}>
          {`${label}…`}
        </Shimmer>
        <span className="tabular ml-auto text-xs text-faint">{elapsed}</span>
      </header>
      {last.length ? <ActivityList items={last} turn={turn} className="mt-3" /> : null}
      {stream ? (
        <div className="mt-2">
          <Markdown text={stream.length > 2400 ? `…${stream.slice(-2400)}` : stream} streaming />
        </div>
      ) : !last.length ? (
        <p className="mt-2 text-small text-muted-foreground">
          Reading what’s new in the room{room ? ` (${nameOf(room, turn.agent)} sees everything up to this point)` : ""}…
        </p>
      ) : null}
      <OpCards ops={ops} />
    </article>
  );
}

function Item({ item, model, fresh, card, clamp }: { item: FeedItem; model: FeedModel; fresh: boolean; card?: boolean; clamp?: number }) {
  if (item.type === "commit") return <CommitLine c={item.c} />;
  if (item.type === "step") return <StepCommitLine sha={item.sha} by={item.by} steps={item.steps} />;
  if (item.type === "revert") return <RevertLine r={item.r} />;
  if (item.type === "doc") return <DocLine r={item.r} />;
  if (item.type === "op") return <StandaloneOp op={item.op} />;
  if (item.type === "pr") return <PrCard pr={item.pr} />;
  const m = item.m;
  const turn = m.turnId ? model.turns.get(m.turnId) : undefined;
  const ops = m.turnId ? model.opsByTurn.get(m.turnId) : undefined;
  const docs = m.turnId ? model.docByTurn.get(m.turnId) : undefined;
  let body;
  if (m.kind === "pass") body = <PassLine m={m} turn={turn} ops={ops} docs={docs} />;
  else if (isThreadReport(m)) body = <ThreadCard m={m} />;
  else if (m.kind === "system") body = <SystemLine m={m} />;
  else if (m.kind === "decision") body = <DecisionLine m={m} />;
  else if (m.kind === "update") body = <UpdateLine m={m} />;
  else if (m.kind === "human") body = <HumanMessage m={m} />;
  else body = <AgentMessage m={m} turn={turn} ops={ops} docs={docs} card={card} clamp={clamp} />;
  return (
    <Fresh fresh={fresh} id={`m-${m.id}`} className="h-full scroll-mt-6 rounded-2xl">
      {body}
    </Fresh>
  );
}

/** A thin label over replies written at the same moment: the order below is not a conversation. */
function RoundMark({ text, title, handles, action }: { text: string; title?: string; handles: string[]; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-small text-muted-foreground">
      <div className="flex -space-x-1.5">
        {handles.map((h) => (
          <Avatar key={h} handle={h} size={18} className="ring-2 ring-background" />
        ))}
      </div>
      <Tip tip={title ?? text}>
        <span className="flex min-w-0 items-center gap-1.5">
          <SplitIcon className="size-3.5 shrink-0" />
          <b className="font-semibold text-foreground">At the same time</b>
          <span className="hidden truncate sm:inline">— {text}</span>
        </span>
      </Tip>
      <span className="h-px min-w-4 flex-1 bg-border" />
      {action}
    </div>
  );
}

/**
 * Replies written at the same moment, each seeing the others only in what they said while working. They read like any other
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
        "hidden h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-meta font-medium transition md:inline-flex",
        side ? "bg-foreground/[0.07] text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {side ? <RowsIcon className="size-3.5" /> : <ColumnsIcon className="size-3.5" />}
      {side ? "One by one" : "Compare"}
    </button>
  ) : null;
  const mark = <RoundMark text={row.text} title={row.title} handles={row.items.map((g) => g.m.author)} action={toggle} />;
  if (!side) {
    return (
      <div className="flex w-full max-w-reading flex-col gap-6 sm:px-2">
        {mark}
        {row.items.map((g) => (
          <Item key={g.key} item={g} model={model} fresh={isFresh(g.m.id)} clamp={720} />
        ))}
      </div>
    );
  }
  return (
    <section className="@container flex w-full flex-col gap-3">
      <div className="mx-auto w-full max-w-reading sm:px-2">{mark}</div>
      <div className="grid items-start gap-3 @3xl:grid-cols-2">
        {row.items.map((g) => (
          <Item key={g.key} item={g} model={model} fresh={isFresh(g.m.id)} card clamp={440} />
        ))}
      </div>
    </section>
  );
}

/** The opening words of a message, as plain text: the folded line's glimpse of where the exchange ended. */
const lastWords = (text: string) =>
  unquoted(text)
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/^[ \t]*(?:#{1,6}|>)[ \t]*/gm, "")
    // Emphasis marks, not the underscores of a name (turn_activity) or the # of PR #27.
    .replace(/[`*]|(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

/**
 * Agents talking to each other, folded into one line: who, how many messages (an agent's pass among them is none), which
 * table items they were about. The human opens it to read the exchange; a link to one of its messages opens it too.
 */
function Between({ row, model, isFresh }: { row: Extract<FeedRow, { type: "between" }>; model: FeedModel; isFresh: (id: string) => boolean }) {
  const room = useSeating();
  const flashAt = useStore((s) => (s.flash && row.items.some((g) => g.key === s.flash!.ref) ? s.flash.at : 0));
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(0);
  // A link followed before this line was drawn (the exchange was still open then) is not one to open it for.
  const [mountedAt] = useState(Date.now);
  // Opened in the same render the link lands in, so the message exists when FlashTarget looks for it.
  if (flashAt && flashAt !== opened && flashAt >= mountedAt - 1000) {
    setOpened(flashAt);
    setOpen(true);
  }
  const said = row.items.filter((g) => g.m.kind !== "pass");
  const first = said[0]!.m;
  const last = said.at(-1)!.m;
  // Read: what it held when it was drawn, what joined it that the human had already seen in the room (replies regrouped
  // with their turns can join it later), and all of it once opened. The rest is new.
  const read = useRef(new Map<string, boolean>());
  for (const g of said) if (open || !read.current.has(g.m.id)) read.current.set(g.m.id, open || !isFresh(g.m.id));
  const fresh = open ? 0 : said.filter((g) => !read.current.get(g.m.id)).length;
  const authors = [...new Set(said.map((g) => g.m.author))];
  // One agent writing to another: "3 messages from Codex to Claude".
  const who =
    authors.length === 1
      ? `from ${nameOf(room, authors[0]!)} to ${names(row.agents.filter((h) => h !== authors[0]).map((h) => nameOf(room, h)))}`
      : `between ${names(row.agents.map((h) => nameOf(room, h)))}`;
  const span = clock(first.ts) === clock(last.ts) ? clock(first.ts) : `${clock(first.ts)}–${clock(last.ts)}`;
  const shown = row.refs.slice(0, 5);
  return (
    <div className="flex w-full max-w-reading flex-col gap-5 sm:px-2" data-between={row.key}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="group flex min-w-0 items-center gap-2 rounded-lg text-left text-small text-muted-foreground transition hover:text-foreground"
      >
        <span className="flex shrink-0 -space-x-1.5">
          {row.agents.map((h) => (
            <Avatar key={h} handle={h} size={18} className="ring-2 ring-background" />
          ))}
        </span>
        <span className="min-w-0 truncate">
          <b className="font-semibold text-foreground">{plural(said.length, "message", "messages")}</b> {who}
          {shown.length ? (
            <span className="font-mono text-meta">
              {" · "}
              {shown.join(" ")}
              {row.refs.length > shown.length ? ` +${row.refs.length - shown.length}` : ""}
            </span>
          ) : null}
        </span>
        {fresh ? <span className="shrink-0 rounded-full bg-foreground/[0.07] px-1.5 text-meta font-medium text-foreground">{fresh} new</span> : null}
        <span className="h-px min-w-4 flex-1 bg-border" />
        <span className="tabular shrink-0 text-meta">{span}</span>
        <span className="inline-flex shrink-0 items-center gap-0.5 text-meta font-medium">
          {open ? "Hide" : "Show"}
          <ChevronDownIcon className={cn("size-3.5 transition", open && "rotate-180")} />
        </span>
      </button>
      {open ? null : (
        <p className="-mt-3.5 truncate pl-8 text-meta text-faint" data-between-last>
          {nameOf(room, last.author)}: {lastWords(last.text)}
        </p>
      )}
      {open
        ? row.items.map((g) => <Item key={g.key} item={g} model={model} fresh={isFresh(g.m.id)} clamp={720} />)
        : null}
    </div>
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
        <QuoteSelection />
        {model.rows.map((row) => {
          if (row.type === "hello") return <Hello key={row.key} />;
          if (row.type === "group") return <Round key={row.key} row={row} model={model} isFresh={isFresh} />;
          if (row.type === "between") return <Between key={row.key} row={row} model={model} isFresh={isFresh} />;
          return (
            <div key={row.key} className="w-full max-w-reading sm:px-2">
              <Item item={row} model={model} fresh={row.type === "msg" && isFresh(row.m.id)} clamp={720} />
            </div>
          );
        })}
        {model.live.length ? (
          <section className="flex w-full max-w-reading flex-col gap-3 sm:px-2">
            {model.liveDivider ? (
              <RoundMark text={model.liveDivider} handles={model.live.map((t) => t.agent)} />
            ) : null}
            {model.live.map((turn) => (
              <LiveTurn key={turn.id} turn={turn} ops={model.opsByTurn.get(turn.id)} />
            ))}
          </section>
        ) : null}
      </ConversationContent>
      <ConversationScrollButton className="bottom-4 shadow-lift" title="Jump to latest" aria-label="Jump to latest messages" />
    </Conversation>
  );
}
