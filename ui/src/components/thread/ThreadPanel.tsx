import { ChevronRightIcon, GitBranchIcon, SquareArrowOutUpRightIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState, Hint, Loading } from "@/components/common/states";
import { Markdown } from "@/components/md/Markdown";
import { Avatar, Time } from "@/components/room/bits";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, roomPath, Unauthorized } from "@/lib/api";
import { ago } from "@/lib/format";
import { errText } from "@/lib/load";
import { participant } from "@/lib/room";
import { useStore } from "@/lib/store";
import { sysLine } from "@/lib/system";
import type { RoomState, RoomSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * A thread of this room beside the conversation: its own room, read as it goes, and a line to steer it (it lands in
 * the thread as the human's message). "Threads" lists this room's threads; the whole room opens on its own.
 */

/** How often the open thread is read again. */
const POLL_MS = 2000;

function ThreadList({ threads, onPick }: { threads: RoomSummary[]; onPick: (id: string) => void }) {
  if (!threads.length) return <Hint className="p-4">No threads yet. An agent starts one with `agoryx new --from here`.</Hint>;
  return (
    <ul className="flex flex-col gap-1 p-2">
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

function Steer({ id, running }: { id: string; running: boolean }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await api("POST", roomPath(id, "/messages"), { text });
      setText("");
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
      className="flex shrink-0 items-end gap-2 border-t border-border/70 p-2"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <Textarea
        aria-label="Message to the thread"
        rows={1}
        value={text}
        placeholder={running ? "Steer the thread…" : "Write in the thread…"}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={keys}
        className="max-h-40 min-h-9 resize-none text-small"
      />
      <Button type="submit" size="sm" disabled={!text.trim() || busy}>
        Send
      </Button>
    </form>
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

  useEffect(() => {
    setState(null);
    setError(null);
    setListing(false);
    if (!id) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const snap = await api<{ state: RoomState }>("GET", roomPath(id));
        if (!live) return;
        setState(snap.state);
        setError(null);
      } catch (err) {
        if (!live || err instanceof Unauthorized) return;
        setError(errText(err));
      }
      if (live) timer = setTimeout(() => void read(), POLL_MS);
    };
    void read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [id]);

  const threads = rooms.filter((room) => room.parent && room.parent === here);
  const summary = rooms.find((room) => room.id === id);
  const running = Boolean(summary?.running ?? state?.turns.some((turn) => turn.status === "running"));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/70 px-3 text-small">
        <button type="button" onClick={() => setListing(true)} className={cn("shrink-0 transition", listing ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}>
          Threads
        </button>
        {!listing && (state || summary) ? (
          <>
            <ChevronRightIcon className="size-3.5 shrink-0 text-faint" />
            <span className="min-w-0 truncate font-medium">{state?.name ?? summary?.name}</span>
            {running ? <span className="ml-1 size-1.5 shrink-0 animate-breathe rounded-full bg-foreground" title="Working" /> : null}
            <Button variant="ghost" size="sm" className="ml-auto h-7 shrink-0 gap-1 px-2 text-meta" onClick={() => id && go({ kind: "room", id })} title="Open the thread as a room of its own">
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
          <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border/70 px-3 py-1.5 text-meta text-muted-foreground">
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
          <Steer id={state.id} running={running} />
        </>
      )}
    </div>
  );
}
