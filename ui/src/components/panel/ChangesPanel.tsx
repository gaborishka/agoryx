import { ChevronRightIcon, FileIcon, GitCompareArrowsIcon } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { Patch, type PickLines } from "@/components/code/Code";
import { EmptyState, ErrorNote, Hint, Loading } from "@/components/common/states";
import { Avatar, Stats } from "@/components/room/bits";
import { ActivityList } from "@/components/room/Trace";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, roomPath } from "@/lib/api";
import { type Diff, orNull, useRoomDiff } from "@/lib/changes";
import { clock, fullDate, plural } from "@/lib/format";
import { useLoad } from "@/lib/load";
import { participant } from "@/lib/room";
import { type ChangeScope, type ChangesFocus, useStore } from "@/lib/store";
import type { FileChange, TurnState } from "@/lib/types";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

// What the room's turns did to the workspace, in the side panel: one turn's change, the whole room's
// against where it began, or one checkpoint commit. Only shown; nothing here keeps, reverts or applies.


/** One file's part of a multi-file patch. */
const partOf = (patch: string, path: string) =>
  patch.split(/(?=^diff --git )/m).find((part) => {
    const first = part.split("\n", 1)[0] ?? "";
    return first.endsWith(` b/${path}`) || first.includes(` a/${path} `);
  });

/** The files a patch touches, with line counts: for a commit, which carries no list of its own. */
const filesOf = (patch: string): FileChange[] =>
  patch
    .split(/(?=^diff --git )/m)
    .filter((part) => part.startsWith("diff --git "))
    .map((part) => {
      const path = /^diff --git a\/.* b\/(.*)$/m.exec(part)?.[1] ?? "";
      let added = 0;
      let removed = 0;
      for (const line of part.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) added++;
        else if (line.startsWith("-") && !line.startsWith("---")) removed++;
      }
      const binary = /^Binary files /m.test(part);
      const status = /^new file mode/m.test(part) ? "A" : /^deleted file mode/m.test(part) ? "D" : "M";
      return { path, status, added: binary ? null : added, removed: binary ? null : removed };
    });

function Scopes({ scope, commits }: { scope: ChangeScope; commits: boolean }) {
  const openChanges = useStore((s) => s.openChanges);
  const item = (value: ChangeScope, label: string, tip: string) => (
    <button
      type="button"
      aria-pressed={scope === value}
      title={tip}
      onClick={() => scope !== value && openChanges({ scope: value })}
      className={cn(
        "h-7 rounded-md px-2.5 text-small font-medium whitespace-nowrap transition",
        scope === value ? "bg-card text-foreground shadow-soft ring-1 ring-border" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
  return (
    <div role="group" aria-label="Which changes" className="flex w-fit max-w-full items-center gap-0.5 overflow-x-auto rounded-lg bg-muted p-0.5">
      {item("turn", "This turn", "What one turn changed")}
      {item("room", "Whole room", "The working folder now against where the room started")}
      {commits ? item("commit", "Checkpoint", t.checkpoint.one) : null}
    </div>
  );
}

/** The files a change touched; one picked shows alone. */
function Files({ changes, only, focus }: { changes: FileChange[]; only?: string; focus: ChangesFocus }) {
  const openChanges = useStore((s) => s.openChanges);
  const openFile = useStore((s) => s.openFile);
  if (!changes.length) return null;
  return (
    <div className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
      {changes.map((c) => (
        <div key={c.path} className={cn("group/row flex items-center gap-2 px-3 py-1.5 text-small", only === c.path && "bg-secondary/60")}>
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left font-mono text-meta hover:underline"
            title={only === c.path ? "Show all files" : "Show only this file"}
            aria-pressed={only === c.path}
            onClick={() => openChanges({ ...focus, acts: false, path: only === c.path ? undefined : c.path })}
          >
            {c.path}
          </button>
          <span className="shrink-0 text-meta">
            <Stats added={c.added} removed={c.removed} deleted={c.status === "D"} binary={c.added === null} isNew={c.status === "A"} />
          </span>
          {c.status !== "D" ? (
            <button type="button" className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" title="Open file" aria-label={`Open ${c.path}`} onClick={() => openFile(c.path)}>
              <FileIcon className="size-3.5" />
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** The patch, or one file of it. */
function Shown({ diff, only, focus, note, onPick }: { diff: Diff; only?: string; focus: ChangesFocus; note?: ReactNode; onPick?: PickLines }) {
  const openChanges = useStore((s) => s.openChanges);
  const narrowed = only && diff.changes.length > 1 ? only : undefined;
  const patch = narrowed ? (partOf(diff.patch, narrowed) ?? diff.patch) : diff.patch;
  return (
    <>
      <Files changes={diff.changes} only={narrowed} focus={focus} />
      {narrowed ? (
        <Hint>
          Only <span className="font-mono">{narrowed}</span> ·{" "}
          <button type="button" className="text-primary hover:underline" onClick={() => openChanges({ ...focus, path: undefined })}>
            all files
          </button>
        </Hint>
      ) : null}
      {diff.truncated ? <Hint>The patch is large — showing the beginning.{note ? <> {note}</> : null}</Hint> : null}
      {patch.trim() ? <Patch patch={patch} onPick={onPick} /> : <Hint>No changes to file text.</Hint>}
    </>
  );
}

// --- one turn ---------------------------------------------------------------------------------

const turnLabel = (room: Parameters<typeof participant>[0], t: TurnState) =>
  `${participant(room, t.agent).label} · ${clock(t.endedAt ?? t.startedAt)}${t.changes?.length ? ` · ${plural(t.changes.length, "file", "files")}` : ""}`;

function TurnChanges({ focus }: { focus: ChangesFocus }) {
  const room = useStore((s) => s.snap?.state);
  const openChanges = useStore((s) => s.openChanges);
  const quote = useStore((s) => s.quote);
  const driven = useStore((s) => s.snap?.driven ?? false);
  const roomId = room?.id ?? "";
  // Turns that changed files, newest first; the one asked for stays listed even if it changed none.
  const changed = useMemo(() => (room?.turns ?? []).filter((t) => t.changes?.length).reverse(), [room?.turns]);
  const turn = focus.turn ? room?.turns.find((t) => t.id === focus.turn) : changed[0];
  const options = turn && !changed.includes(turn) ? [turn, ...changed] : changed;
  const diff = useLoad(turn?.changes?.length ? `${roomId}:${turn.id}` : null, () =>
    orNull(api<Diff>("GET", `${roomPath(roomId, "/turn-diff")}?turn=${encodeURIComponent(turn!.id)}`)),
  );
  if (!room) return null;
  if (!turn) {
    return focus.turn ? (
      <EmptyState icon={GitCompareArrowsIcon} title="No such turn" text={`This room has no turn ${focus.turn}.`} />
    ) : (
      <EmptyState icon={GitCompareArrowsIcon} title="No turn has changed anything yet" text="When an agent changes files in the working folder, you’ll see exactly what here." />
    );
  }
  const acts = turn.activity.length;
  let body: ReactNode = null;
  if (turn.status === "running") body = <Hint>The turn is still running — changes show up when it ends.</Hint>;
  else if (!turn.changes?.length) body = <Hint>This turn changed no files.</Hint>;
  else if (diff.error) body = <ErrorNote>{diff.error}</ErrorNote>;
  else if (diff.data === null) body = <Hint>This turn’s snapshot is gone — its changes can’t be shown.</Hint>;
  else if (!diff.data) body = <Loading block />;
  else {
    const by = participant(room, turn.agent);
    // The lines go to the turn's agent, unless other agents' parallel turns also edited the file: then we don't know whose lines they are.
    const pick: PickLines = (path, picked) => {
      const shared = turn.changes?.find((c) => c.path === path)?.with?.length;
      quote({ id: turn.id, author: turn.agent, label: by.label, text: picked.text, file: { path, lines: picked.lines } }, shared ? undefined : turn.agent);
    };
    body = (
      <Shown
        onPick={driven ? pick : undefined}
        diff={{ ...diff.data, changes: turn.changes }}
        only={focus.path}
        focus={{ scope: "turn", turn: turn.id }}
        note={
          <>
            In full: <code className="font-mono">agoryx diff {turn.id}</code>
          </>
        }
      />
    );
  }
  return (
    <>
      <div className="flex items-center gap-2">
        <Avatar handle={turn.agent} size={22} />
        <Select value={turn.id} onValueChange={(id) => openChanges({ scope: "turn", turn: id })}>
          <SelectTrigger size="sm" className="h-8 min-w-0 flex-1 text-small" aria-label="Turn">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {turnLabel(room, t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="shrink-0 font-mono text-meta text-faint">{turn.id}</span>
      </div>
      {acts ? (
        <div>
          <button
            type="button"
            aria-expanded={Boolean(focus.acts)}
            onClick={() => openChanges({ ...focus, turn: turn.id, acts: !focus.acts })}
            className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border bg-card px-2 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            <ChevronRightIcon className={cn("size-3.5 transition-transform", focus.acts && "rotate-90")} />
            {plural(acts, "action", "actions")}
          </button>
          {focus.acts ? <ActivityList items={turn.activity} className="mt-2 rounded-xl border border-border bg-muted/40 px-3 pt-2.5 pb-1" /> : null}
        </div>
      ) : null}
      {body}
      {turn.changes?.length && turn.status !== "running" ? (
        <Hint className="text-meta">A git snapshot before and after the turn. Other agents see these +/− in their delta. To answer about some lines, press the + by a line, or drag over line numbers first to take several: they go into your message.</Hint>
      ) : null}
    </>
  );
}

// --- the whole room ------------------------------------------------------------------------------

function RoomChanges({ focus }: { focus: ChangesFocus }) {
  const room = useStore((s) => s.snap?.state);
  const diff = useRoomDiff(room);
  if (!room) return null;
  if (diff.error) return <ErrorNote>{diff.error}</ErrorNote>;
  if (diff.data === null) {
    return <EmptyState icon={GitCompareArrowsIcon} title="Nothing to compare yet" text="The comparison appears after the first turn in the room." />;
  }
  if (!diff.data) return <Loading block />;
  const { base } = diff.data;
  const from =
    base.kind === "worktree" ? (
      <>
        against branch <span className="font-mono">{base.ref}</span> <span className="font-mono text-faint">({base.sha.slice(0, 7)})</span>
      </>
    ) : (
      <>
        against the state before the first turn <span className="font-mono">{base.turnId}</span> · {fullDate(base.ts)}
      </>
    );
  return (
    <>
      <Hint className="text-meta">The working folder now, {from}. Includes uncommitted and new files.</Hint>
      {diff.data.changes.length ? (
        <Shown diff={diff.data} only={focus.path} focus={{ scope: "room" }} />
      ) : (
        <Hint>Nothing has changed since.</Hint>
      )}
    </>
  );
}

// --- one checkpoint ------------------------------------------------------------------------------

/** A commit's words from `git show --stat` output: git's "---" line and the stat block after them left out. */
const messageOf = (head: string) => {
  const stat = /^(?:---\n)?(?= .*?\s\|\s+(?:\d|Bin\b))/m.exec(head);
  return (stat ? head.slice(0, stat.index) : head).trim();
};

function CommitChanges({ focus }: { focus: ChangesFocus }) {
  const room = useStore((s) => s.snap?.state);
  const openChanges = useStore((s) => s.openChanges);
  const roomId = room?.id ?? "";
  const commits = useMemo(() => (room?.commits ?? []).slice().reverse(), [room?.commits]);
  const sha = focus.sha ?? commits[0]?.sha;
  const commit = useLoad(sha ? `${roomId}:${sha}` : null, () => api<{ sha: string; text: string }>("GET", `${roomPath(roomId, "/commit")}?sha=${encodeURIComponent(sha!)}`));
  const parts = useMemo(() => {
    const text = commit.data?.text ?? "";
    const at = text.search(/^diff --git /m);
    const patch = at < 0 ? "" : text.slice(at);
    return { head: at < 0 ? text : text.slice(0, at), patch, changes: filesOf(patch) };
  }, [commit.data]);
  if (!room) return null;
  if (!sha) return <EmptyState icon={GitCompareArrowsIcon} title="No checkpoints yet" text={t.checkpoint.none} />;
  const known = commits.some((c) => c.sha === sha);
  let body: ReactNode = <Loading block />;
  if (commit.error) body = <ErrorNote>{commit.error}</ErrorNote>;
  else if (commit.data) {
    body = (
      <>
        <pre className="scroll-thin overflow-x-auto rounded-xl border border-border bg-muted/50 px-3.5 py-3 font-mono text-meta leading-relaxed whitespace-pre-wrap">
          {messageOf(parts.head)}
        </pre>
        {parts.patch ? <Shown diff={{ changes: parts.changes, patch: parts.patch, truncated: false }} only={focus.path} focus={{ scope: "commit", sha }} /> : null}
      </>
    );
  }
  return (
    <>
      <Select value={sha} onValueChange={(next) => openChanges({ scope: "commit", sha: next })}>
        <SelectTrigger size="sm" className="h-8 w-full text-small" aria-label="Checkpoint">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {known ? null : <SelectItem value={sha}>{sha.slice(0, 7)}</SelectItem>}
          {commits.map((c) => (
            <SelectItem key={c.sha} value={c.sha}>
              <span className="font-mono text-faint">{c.sha.slice(0, 7)}</span> {c.subject.slice(0, 60)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {body}
    </>
  );
}

export function ChangesPanel() {
  const focus = useStore((s) => s.changes);
  const commits = useStore((s) => (s.snap?.state.commits.length ?? 0) > 0);
  const scope = focus.scope === "commit" && !commits && !focus.sha ? "turn" : focus.scope;
  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3 *:shrink-0">
      <Scopes scope={scope} commits={commits || scope === "commit"} />
      {scope === "room" ? <RoomChanges focus={focus} /> : scope === "commit" ? <CommitChanges focus={focus} /> : <TurnChanges focus={focus} />}
    </div>
  );
}
