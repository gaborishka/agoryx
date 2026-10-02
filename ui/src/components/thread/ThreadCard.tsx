import { CheckIcon, ChevronDownIcon, ChevronRightIcon, GitBranchIcon, PanelRightOpenIcon } from "lucide-react";
import { useState } from "react";
import { Markdown } from "@/components/md/Markdown";
import { Stats } from "@/components/room/bits";
import { Button } from "@/components/ui/button";
import { nameOf } from "@/lib/room";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { MessageEntry } from "@/lib/types";
import type { SystemNote } from "@agora/types";

/**
 * What a thread left when its run ended, as its parent's feed shows it: one line — its name, who works in it, how its
 * run ended, the files and the diff stat — that opens in place into the card: its branch, the files, what its table
 * got, and its last message verbatim. No summary: the thread itself opens beside the conversation.
 */

type ThreadNote = Extract<SystemNote, { code: "thread.reported" }>;

/** Files shown before "and N more". */
const CHIPS = 6;

const ENDED: Record<ThreadNote["reason"], string> = { quiet: "went quiet", budget: "spent its turn limit", stopped: "was stopped" };

export function ThreadCard({ m }: { m: MessageEntry & { sys: ThreadNote } }) {
  const sys = m.sys;
  const openThread = useStore((s) => s.openThread);
  const shown = useStore((s) => s.panel === "thread" && s.thread === sys.room);
  const room = useStore((s) => s.snap?.state);
  const resolved = useStore((s) => s.rooms.find((entry) => entry.id === sys.room)?.resolved);
  const [expanded, setExpanded] = useState(false);
  const [all, setAll] = useState(false);
  const added = sys.files.reduce((sum, file) => sum + (file.added ?? 0), 0);
  const removed = sys.files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
  const total = sys.files.length + (sys.more ?? 0);
  const chips = all ? sys.files : sys.files.slice(0, CHIPS);
  const hidden = sys.files.length - chips.length + (sys.more ?? 0);
  const open = sys.open && !sys.items.some((item) => item.id === sys.open!.id) ? sys.open : null;
  const status = resolved ? (
    <span className="flex shrink-0 items-center gap-0.5 text-meta text-faint" title={`Resolved by ${resolved.by}`}>
      <CheckIcon className="size-3.5" /> resolved
    </span>
  ) : null;
  if (!expanded) {
    return (
      <div className="flex w-full max-w-xl min-w-0 items-center gap-1 rounded-full border border-border bg-card pr-1 text-small shadow-soft" data-thread={sys.room}>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-expanded={false}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-full py-1.5 pl-3 text-left transition hover:bg-foreground/[0.03]"
        >
          <ChevronRightIcon className="size-3.5 shrink-0 text-faint" />
          <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate font-medium">{sys.name}</span>
          <span className="hidden shrink-0 text-meta text-muted-foreground sm:inline">
            {sys.agents.join(", ")} · {ENDED[sys.reason]}
          </span>
          <span className="ml-auto shrink-0 text-meta text-muted-foreground">
            {total ? (
              <>
                {total} file{total === 1 ? "" : "s"}{" "}
                <span className="font-mono">
                  <Stats added={added} removed={removed} />
                </span>
              </>
            ) : (
              "no changes"
            )}
          </span>
          {status}
        </button>
        <Button
          size="icon"
          variant={shown ? "secondary" : "ghost"}
          className="size-7 shrink-0 rounded-full"
          aria-label="View thread"
          title="View the thread beside the conversation"
          onClick={() => openThread(sys.room)}
        >
          <PanelRightOpenIcon className="size-3.5" />
        </Button>
      </div>
    );
  }
  return (
    <div className="flex w-full max-w-xl min-w-0 flex-col gap-2 rounded-xl border border-border bg-card px-3.5 py-3 text-small shadow-soft" data-thread={sys.room}>
      <button type="button" onClick={() => setExpanded(false)} aria-expanded className="flex min-w-0 items-baseline gap-2 text-left">
        <ChevronDownIcon className="size-3.5 shrink-0 self-center text-faint" />
        <span className="shrink-0 text-meta text-faint">Thread</span>
        <span className="min-w-0 truncate font-medium">{sys.name}</span>
        <span className="ml-auto shrink-0 text-meta text-muted-foreground">
          {sys.agents.join(", ")} · {ENDED[sys.reason]}
        </span>
        {status}
      </button>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-meta text-muted-foreground">
        <GitBranchIcon className="size-3.5 shrink-0" />
        {sys.branch ? (
          <span className="min-w-0 truncate font-mono">
            {sys.branch} <span className="text-faint">from {sys.base}</span>
          </span>
        ) : (
          <span>its folder</span>
        )}
        {total ? (
          <>
            <span>
              {total} file{total === 1 ? "" : "s"}
            </span>
            <span className="font-mono">
              <Stats added={added} removed={removed} />
            </span>
            <span>{sys.uncommitted ? `${sys.uncommitted} uncommitted` : "all committed"}</span>
          </>
        ) : (
          <span>no changes</span>
        )}
      </div>
      {chips.length ? (
        <div className="flex flex-wrap gap-1">
          {chips.map((file) => (
            <span key={file.path} title={file.path} className="inline-flex max-w-full items-center gap-1 rounded-md bg-secondary px-1.5 py-0.5 font-mono text-micro text-secondary-foreground">
              <span className="text-faint">{file.status}</span>
              <span className="truncate">{file.path}</span>
            </span>
          ))}
          {hidden ? (
            <button type="button" className="rounded-md px-1.5 py-0.5 text-micro text-muted-foreground hover:text-foreground" onClick={() => setAll(!all)} disabled={!sys.files.length || (all && !!sys.more)}>
              {all ? `and ${sys.more} more` : `and ${hidden} more`}
            </button>
          ) : null}
        </div>
      ) : null}
      {sys.items.length || open ? (
        <ul className="flex flex-col gap-0.5">
          {[...sys.items, ...(open ? [open] : [])].map((item) => (
            <li key={item.id} className="flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 rounded-md bg-secondary px-1.5 font-mono text-micro font-semibold">{item.id}</span>
              <span className="min-w-0 truncate">{item.text.split("\n")[0]}</span>
              {item === open ? <span className="shrink-0 text-meta text-faint">still open</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {sys.last ? (
        <details className="group rounded-lg bg-muted/50 px-2.5 py-1.5">
          <summary className="cursor-pointer list-none text-meta text-muted-foreground">
            <span className="text-foreground/80">{sys.last.by}</span>: <span className="group-open:hidden">{sys.last.text.split("\n")[0]}</span>
          </summary>
          <Markdown text={sys.last.text} className="mt-1 text-small leading-relaxed" />
        </details>
      ) : (
        <p className="text-meta text-faint">Nobody in it said anything this run.</p>
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" variant={shown ? "secondary" : "outline"} className={cn("h-7 gap-1.5 text-meta")} onClick={() => openThread(sys.room)}>
          <PanelRightOpenIcon className="size-3.5" />
          View thread
        </Button>
        {sys.wakes ? <span className="text-meta text-faint">woke {nameOf(room, sys.wakes)}, who started it</span> : null}
      </div>
    </div>
  );
}

export const isThreadReport = (m: MessageEntry): m is MessageEntry & { sys: ThreadNote } => m.kind === "system" && m.sys?.code === "thread.reported";
