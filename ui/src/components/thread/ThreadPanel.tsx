import { ArrowUpIcon, CheckIcon, ChevronRightIcon, GitBranchIcon, SquareArrowOutUpRightIcon, Undo2Icon } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState, Hint, Loading } from "@/components/common/states";
import { Markdown } from "@/components/md/Markdown";
import { Avatar, Time } from "@/components/room/bits";
import { ModelMenu } from "@/components/room/ModelMenu";
import { Button } from "@/components/ui/button";
import { api, roomPath, Unauthorized } from "@/lib/api";
import { ago } from "@/lib/format";
import { useModels } from "@/lib/models";
import { type Quote, quoteMarkdown } from "@/lib/quote";
import { errText } from "@/lib/load";
import { participant } from "@/lib/room";
import { useStore } from "@/lib/store";
import { sysLine } from "@/lib/system";
import { groupThreads, threadGroup } from "@/lib/threads";
import type { RoomAgent, RoomState, RoomSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * A thread of this room beside the conversation: its own room, read as it goes, and a line to steer it (it lands in
 * the thread as the human's message). "Threads" lists this room's threads; the whole room opens on its own.
 */

/** A thread has spoken when its agent wrote last: it waits for the human. */
const groupOf = (thread: RoomSummary) =>
  threadGroup({ running: thread.running, resolved: thread.resolved, spoke: Boolean(thread.lastMessage?.label && !thread.lastMessage.sys) });

function ThreadList({ threads, onPick }: { threads: RoomSummary[]; onPick: (id: string) => void }) {
  if (!threads.length) return <Hint className="p-4">No threads yet. An agent starts one with `agoryx new --from here`.</Hint>;
  return (
    <div className="flex flex-col gap-3 p-2">
      {groupThreads(threads, groupOf).map((group) => (
        <section key={group.id} className="flex flex-col gap-1">
          <h3 className="px-2.5 text-micro font-medium text-faint">
            {group.head} {group.threads.length}
          </h3>
          <ThreadRows threads={group.threads} onPick={onPick} />
        </section>
      ))}
    </div>
  );
}

function ThreadRows({ threads, onPick }: { threads: RoomSummary[]; onPick: (id: string) => void }) {
  return (
    <ul className="flex flex-col gap-1">
      {threads.map((thread) => (
        <li key={thread.id}>
          <button type="button" onClick={() => onPick(thread.id)} className="flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left hover:bg-accent">
            <span className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate font-medium">{thread.name}</span>
              <span className="shrink-0 text-micro text-faint">{thread.running ? "working" : ago(thread.updatedAt)}</span>
            </span>
            <span className="truncate text-meta text-muted-foreground">
              {(thread.agents ?? []).map((agent) => agent.label).join(", ")}
              {thread.branch ? ` · ${thread.branch}` : ""}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Transcript({ state }: { state: RoomState }) {
  const end = useRef<HTMLDivElement>(null);
  const shown = state.messages.filter((m) => m.kind !== "pass");
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [shown.length]);
  if (!shown.length) return <Hint className="p-4">Nothing said here yet.</Hint>;
  return (
    <div className="flex flex-col gap-3 p-3">
      {shown.map((m) => {
        if (m.kind === "system" || m.kind === "decision") {
          return (
            <div key={m.id} className="text-meta text-muted-foreground">
              <Markdown text={sysLine(m)} className="text-meta leading-relaxed" />
            </div>
          );
        }
        const human = m.kind === "human";
        const who = participant(state, m.author);
        return (
          <div key={m.id} className={cn("flex flex-col gap-1", human && "items-end")}>
            <div className="flex items-center gap-1.5 text-meta text-muted-foreground">
              {human ? null : <Avatar handle={m.author} roster={state.agents} size={18} />}
              <span className="text-foreground/80">{human ? (m.author === state.human ? "You" : m.author) : who.label}</span>
              {m.kind === "update" ? <span className="text-faint">while working</span> : null}
              <Time iso={m.ts} />
            </div>
            <div className={cn("max-w-full", human && "rounded-2xl bg-human-soft px-3 py-2 ring-1 ring-human/20")}>
              <Markdown text={m.text} className="text-small leading-relaxed" />
            </div>
          </div>
        );
      })}
      <div ref={end} />
    </div>
  );
}

/** A passage of the room as the thread reads it: named as the room's, since its message ids are not the thread's. */
const fromRoom = (quote: Quote, room: string) => quoteMarkdown(quote).replace(/^> \[([^\]]*)\]\(#[^)]*\)/, (_, source: string) => `> ${source} · in ${room}:`);

/**
 * The human's line to the thread, with its agents' model and effort beside it (from the thread's next turn).
 * A passage sent here from the room («To thread») lands above the draft; the human sends it.
 */
function Steer({ state, running, onAgent }: { state: RoomState; running: boolean; onAgent: (agent: RoomAgent) => void }) {
  const id = state.id;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const models = useModels();
  const steering = useStore((s) => s.steering);
  const room = useStore((s) => s.snap?.state.name ?? "the room");
  useEffect(() => {
    if (!steering) return;
    setText((draft) => [fromRoom(steering.quote, room), draft].filter((part) => part.trim()).join("\n\n") + "\n\n");
    useStore.setState({ steering: null });
    requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [steering, room]);
  const setModel = async (agent: RoomAgent, change: { model?: string | null; effort?: string | null }) => {
    try {
      const res = await api<{ agent: RoomAgent }>("POST", roomPath(id, "/agent"), { agent: agent.id, ...change });
      onAgent(res.agent);
    } catch (err) {
      if (!(err instanceof Unauthorized)) toast.error(errText(err));
    }
  };
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await api("POST", roomPath(id, "/messages"), { text });
      setText("");
      // The thread is read again when the room list shows its new message: now, not at the next look.
      void useStore.getState().loadRooms();
    } catch (err) {
      if (!(err instanceof Unauthorized)) toast.error(errText(err));
    } finally {
      setBusy(false);
    }
  };
  const keys = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };
  return (
    <form
      className="flex shrink-0 flex-col gap-1.5 px-3 pt-2 pb-3"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <div className="flex items-end gap-1 rounded-2xl border border-input bg-card p-1.5 pl-3 shadow-edge transition focus-within:border-foreground/30 focus-within:ring-3 focus-within:ring-foreground/[0.06]">
        <textarea
          ref={area}
          aria-label="Message to the thread"
          rows={1}
          value={text}
          placeholder={running ? "Steer the thread…" : "Write in the thread…"}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={keys}
          className="scroll-thin field-sizing-content max-h-40 min-h-8 flex-1 resize-none bg-transparent py-1.5 text-small leading-relaxed outline-none placeholder:text-faint"
        />
        <Button type="submit" size="icon" className="size-8 shrink-0 rounded-full" disabled={!text.trim() || busy} aria-label="Send" title="Send (Enter)">
          <ArrowUpIcon className="size-4" />
        </Button>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-0.5">
        {state.agents.map((agent) => (
          <ModelMenu
            key={agent.id}
            agent={agent}
            seating={state}
            models={models}
            working={running}
            align="start"
            className="h-7 px-1.5 text-meta text-muted-foreground"
            onSet={(change) => void setModel(agent, change)}
          />
        ))}
      </div>
    </form>
  );
}

/**
 * The human's ✓: the thread moves to Resolved on the board. Its agents are not told and nothing stops; while it
 * works again it shows as Working, and Reopen brings it back for good.
 */
function Resolve({ id, resolved }: { id: string; resolved?: { by: string; at: string } }) {
  const loadRooms = useStore((s) => s.loadRooms);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      await api("POST", `${roomPath(id)}/resolve`, { resolved: !resolved });
      await loadRooms();
    } catch (err) {
      if (!(err instanceof Unauthorized)) toast.error(errText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={busy}
      className={cn("ml-auto h-7 shrink-0 gap-1 px-2 text-meta", resolved && "text-muted-foreground")}
      onClick={() => void send()}
      title={resolved ? `Resolved by ${resolved.by} ${ago(resolved.at)}: open it again` : "Mark it resolved: it moves to Resolved; its agents are not told"}
    >
      {resolved ? <Undo2Icon className="size-3.5" /> : <CheckIcon className="size-3.5" />}
      {resolved ? "Reopen" : "Resolve"}
    </Button>
  );
}

export function ThreadPanel() {
  const id = useStore((s) => s.thread);
  const here = useStore((s) => s.snap?.state.id);
  const rooms = useStore((s) => s.rooms);
  const openThread = useStore((s) => s.openThread);
  const go = useStore((s) => s.go);
  const [listing, setListing] = useState(false);
  const [state, setState] = useState<RoomState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Read again when the thread said something or a run of it started or ended, as the room list shows it (which is
  // not read while the tab is hidden): not on a timer.
  const changed = useStore((s) => {
    const room = s.rooms.find((entry) => entry.id === id);
    return room ? `${room.messages}:${room.running}:${room.resolved?.at ?? ""}` : "";
  });

  useEffect(() => {
    setState(null);
    setError(null);
    setListing(false);
  }, [id]);
  // A passage sent «To thread» with no thread open: the human picks which one it goes to.
  const pick = useStore((s) => (s.steering?.pick ? s.steering.at : 0));
  useEffect(() => {
    if (pick) setListing(true);
  }, [pick]);
  useEffect(() => {
    if (!id) return;
    let live = true;
    api<{ state: RoomState }>("GET", roomPath(id))
      .then((snap) => {
        if (!live) return;
        setState(snap.state);
        setError(null);
      })
      .catch((err) => live && !(err instanceof Unauthorized) && setError(errText(err)));
    return () => {
      live = false;
    };
  }, [id, changed]);

  const threads = rooms.filter((room) => room.parent && room.parent === here);
  const summary = rooms.find((room) => room.id === id);
  const running = Boolean(summary?.running ?? state?.turns.some((turn) => turn.status === "running"));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border/70 px-4 text-small">
        <button type="button" onClick={() => setListing(true)} className={cn("shrink-0 transition", listing ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}>
          Threads
        </button>
        {!listing && (state || summary) ? (
          <>
            <ChevronRightIcon className="size-3.5 shrink-0 text-faint" />
            <span className="min-w-0 truncate font-medium">{state?.name ?? summary?.name}</span>
            {running ? <span className="ml-1 size-1.5 shrink-0 animate-breathe rounded-full bg-foreground" title="Working" /> : null}
            {id ? <Resolve id={id} resolved={state?.resolved ?? summary?.resolved} /> : null}
            <Button variant="ghost" size="sm" className="h-7 shrink-0 gap-1 px-2 text-meta" onClick={() => id && go({ kind: "room", id })} title="Open the thread as a room of its own">
              <SquareArrowOutUpRightIcon className="size-3.5" />
              Open as room
            </Button>
          </>
        ) : null}
      </div>
      {listing ? (
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          <ThreadList
            threads={threads}
            onPick={(pick) => {
              setListing(false);
              openThread(pick);
            }}
          />
        </div>
      ) : !id ? (
        <EmptyState icon={GitBranchIcon} title="No thread open" text="Open one from its card in the conversation." />
      ) : error && !state ? (
        <Hint className="p-4">{error}</Hint>
      ) : !state ? (
        <Loading className="p-4" />
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-border/70 bg-muted/40 px-4 py-2 text-meta text-muted-foreground">
            <span>{state.agents.map((agent) => agent.label).join(", ")}</span>
            {state.worktree ? (
              <span className="min-w-0 truncate font-mono">
                {state.worktree.branch} <span className="text-faint">from {state.worktree.base}</span>
              </span>
            ) : null}
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
            <Transcript state={state} />
          </div>
          <Steer state={state} running={running} onAgent={(agent) => setState((was) => (was ? { ...was, agents: was.agents.map((a) => (a.id === agent.id ? agent : a)) } : was))} />
        </>
      )}
    </div>
  );
}
