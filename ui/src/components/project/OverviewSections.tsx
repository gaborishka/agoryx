import { CopyIcon, FileTextIcon, GitBranchIcon, ImageIcon, PaperclipIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ErrorNote, Hint, Loading } from "@/components/common/states";
import { rawUrl } from "@/components/md/Markdown";
import { api, Unauthorized } from "@/lib/api";
import { ago, baseName, ext, IMAGE_EXT, plural, took, VISUAL_EXT } from "@/lib/format";
import { errText } from "@/lib/load";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { LibraryEntry, LibraryKind, ProjectOverview, ThreadView } from "@agora/overview";
import { Block } from "./ProjectPage";

/**
 * The project page's view across its rooms: the threads with what each last reported, the library (what was
 * attached, the rooms' documents, the media agents linked — each where it is, by its path), and what the rooms'
 * turns took. Read again when a room of the project changes.
 */

type Overview = ProjectOverview & { rawBase: Record<string, string> };

const COLUMNS: Array<{ id: string; head: string; has: (thread: ThreadView) => boolean }> = [
  { id: "working", head: "Working", has: (thread) => thread.running },
  { id: "reported", head: "Reported back", has: (thread) => !thread.running && thread.report?.reason === "quiet" },
  { id: "stopped", head: "Stopped", has: (thread) => !thread.running && (thread.report?.reason === "budget" || thread.report?.reason === "stopped") },
  { id: "waiting", head: "Not reported yet", has: (thread) => !thread.running && !thread.report },
];

function ThreadTile({ thread }: { thread: ThreadView }) {
  const go = useStore((s) => s.go);
  const openThread = useStore((s) => s.openThread);
  const report = thread.report;
  const files = report ? report.files.length + (report.more ?? 0) : 0;
  return (
    <li>
      <button
        type="button"
        onClick={() => {
          // Beside the room it came from, where its reports are.
          go({ kind: "room", id: thread.parent });
          openThread(thread.id);
        }}
        className="flex w-full flex-col gap-1 rounded-xl border border-border/70 bg-card px-3 py-2.5 text-left text-small transition hover:border-border"
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate font-medium">{thread.name}</span>
          <span className="shrink-0 text-micro text-faint">{ago(report?.at ?? thread.updatedAt)}</span>
        </span>
        <span className="truncate text-meta text-muted-foreground">
          {thread.agents.join(", ")} · from {thread.parentName ?? thread.parent}
        </span>
        {thread.branch ? (
          <span className="flex min-w-0 items-center gap-1 text-meta text-muted-foreground">
            <GitBranchIcon className="size-3 shrink-0" />
            <span className="truncate font-mono">{thread.branch}</span>
          </span>
        ) : null}
        {report ? (
          <span className="text-meta text-muted-foreground">
            {files ? `${plural(files, "file", "files")} changed${report.uncommitted ? `, ${report.uncommitted} uncommitted` : ""}` : "no changes"}
          </span>
        ) : null}
        {report?.open ? (
          <span className="flex min-w-0 items-baseline gap-1.5 text-meta">
            <span className="shrink-0 rounded bg-secondary px-1 font-mono text-micro font-semibold">{report.open.id}</span>
            <span className="truncate">{report.open.text.split("\n")[0]}</span>
          </span>
        ) : null}
        {report?.last ? (
          <span className="line-clamp-2 text-meta text-muted-foreground">
            <span className="text-foreground/80">{report.last.by}:</span> {report.last.text}
          </span>
        ) : null}
      </button>
    </li>
  );
}

function Threads({ threads }: { threads: ThreadView[] }) {
  const columns = COLUMNS.map((column) => ({ ...column, threads: threads.filter(column.has) })).filter((column) => column.threads.length);
  return (
    <Block title="Threads" aside={threads.length ? `${threads.length}` : undefined}>
      {threads.length ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {columns.map((column) => (
            <div key={column.id} className="flex min-w-0 flex-col gap-2">
              <h3 className="text-meta font-medium text-muted-foreground">
                {column.head} <span className="text-faint">{column.threads.length}</span>
              </h3>
              <ul className="flex flex-col gap-2">
                {column.threads.map((thread) => (
                  <ThreadTile key={thread.id} thread={thread} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <Hint>
          No threads yet. An agent in a Work room here starts one with <code className="font-mono text-meta">agoryx new --from here</code>: its own branch,
          reporting back to the room it came from.
        </Hint>
      )}
    </Block>
  );
}

const KIND_LABEL: Record<LibraryKind, string> = { upload: "Attached", doc: "Documents", media: "Media" };
const KIND_ICON = { upload: PaperclipIcon, doc: FileTextIcon, media: ImageIcon };

function LibraryRow({ entry, rawBase }: { entry: LibraryEntry; rawBase?: string }) {
  const go = useStore((s) => s.go);
  const setPanel = useStore((s) => s.setPanel);
  const Icon = KIND_ICON[entry.kind];
  // Served through the room that links it, while it links it, and only media: a picture shows, any media opens.
  const url = entry.kind !== "doc" && entry.exists && rawBase && VISUAL_EXT.has(ext(entry.path)) ? rawUrl(rawBase, `~abs/${entry.path.replace(/^\//, "")}`) : null;
  const picture = url && IMAGE_EXT.has(ext(entry.path));
  const open = () => {
    if (entry.kind === "doc") {
      go({ kind: "room", id: entry.room });
      setPanel("doc");
    } else if (url) window.open(url, "_blank", "noopener");
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(entry.path);
      toast.success("Path copied");
    } catch {
      toast.error("Could not copy the path");
    }
  };
  return (
    <li className="flex items-center gap-3 px-3.5 py-2.5">
      {picture ? (
        <img src={url} alt="" loading="lazy" className="size-9 shrink-0 rounded-md object-cover ring-1 ring-border" />
      ) : (
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-secondary text-muted-foreground">
          <Icon className="size-4" />
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        {entry.kind === "doc" || url ? (
          <button type="button" onClick={open} className="min-w-0 truncate text-left text-ui hover:underline" title={entry.path}>
            {baseName(entry.path)}
          </button>
        ) : (
          <span className="min-w-0 truncate text-ui" title={entry.path}>
            {baseName(entry.path)}
          </span>
        )}
        <span className="truncate text-meta text-faint">
          {entry.kind === "doc" ? `${plural(entry.revisions ?? 0, "revision", "revisions")}${entry.by ? `, last by ${entry.by}` : ""}` : `linked by ${entry.by}`} in “{entry.roomName}”
          {entry.alsoIn ? ` and ${plural(entry.alsoIn, "other room", "other rooms")}` : ""} · {ago(entry.at)}
          {entry.exists ? "" : " · no longer there"}
        </span>
      </span>
      {entry.kind !== "doc" ? (
        <button type="button" onClick={() => void copy()} title={`Copy the path: ${entry.path}`} aria-label="Copy the path" className="shrink-0 text-faint transition hover:text-foreground">
          <CopyIcon className="size-3.5" />
        </button>
      ) : null}
    </li>
  );
}

function Library({ entries, rawBase }: { entries: LibraryEntry[]; rawBase: Record<string, string> }) {
  const [kind, setKind] = useState<LibraryKind | null>(null);
  const shown = kind ? entries.filter((entry) => entry.kind === kind) : entries;
  const counts = (Object.keys(KIND_LABEL) as LibraryKind[]).map((id) => ({ id, n: entries.filter((entry) => entry.kind === id).length })).filter(({ n }) => n);
  return (
    <Block title="Library" aside={entries.length ? `${entries.length}` : undefined}>
      <p className="text-small leading-relaxed text-muted-foreground">
        Files attached in this project’s rooms, their documents, and media the agents linked. Each stays where it is; nothing is copied here.
      </p>
      {counts.length > 1 ? (
        <div className="flex flex-wrap gap-1">
          {[{ id: null, n: entries.length }, ...counts].map(({ id, n }) => (
            <button
              key={id ?? "all"}
              type="button"
              onClick={() => setKind(id)}
              className={cn("rounded-full px-2.5 py-0.5 text-meta transition", kind === id ? "bg-foreground text-background" : "text-muted-foreground hover:bg-accent")}
            >
              {id ? KIND_LABEL[id] : "All"} {n}
            </button>
          ))}
        </div>
      ) : null}
      {shown.length ? (
        <ul className="flex flex-col divide-y divide-border/60 rounded-xl border border-border/70">
          {shown.map((entry) => (
            <LibraryRow key={`${entry.kind}:${entry.room}:${entry.path}`} entry={entry} rawBase={rawBase[entry.room]} />
          ))}
        </ul>
      ) : (
        <Hint>Nothing attached, written or linked yet.</Hint>
      )}
    </Block>
  );
}

function Usage({ usage }: { usage: ProjectOverview["usage"] }) {
  const go = useStore((s) => s.go);
  const kinds = Object.entries(usage.byKind).filter(([, totals]) => totals.turns);
  const top = usage.rooms.filter((room) => room.total.turns).slice(0, 8);
  return (
    <Block title="Usage" aside={usage.total.turns ? plural(usage.total.turns, "turn", "turns") : undefined}>
      {usage.total.turns ? (
        <div className="flex flex-col gap-3 text-small">
          <p className="text-muted-foreground">
            All rooms: <span className="text-foreground">{took(usage.total)}</span>
            {usage.threads.turns ? <> · threads: {took(usage.threads)}</> : null}
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            {kinds.map(([kind, totals]) => (
              <div key={kind} className="contents">
                <dt className="capitalize text-muted-foreground">{kind}</dt>
                <dd>
                  {plural(totals.turns, "turn", "turns")} · {took(totals)}
                </dd>
              </div>
            ))}
          </dl>
          <ul className="flex flex-col divide-y divide-border/60 rounded-xl border border-border/70">
            {top.map((room) => (
              <li key={room.id}>
                <button type="button" onClick={() => go({ kind: "room", id: room.id })} className="flex w-full items-baseline gap-3 px-3.5 py-2 text-left transition hover:bg-foreground/[0.03]">
                  <span className="min-w-0 flex-1 truncate">
                    {room.name}
                    {room.thread ? <span className="text-faint"> · thread</span> : null}
                  </span>
                  <span className="shrink-0 text-meta text-muted-foreground">{took(room.total)}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="text-meta text-faint">What the CLIs reported for each turn. The $ is Claude Code’s estimate at API prices; on a subscription nothing is billed per turn.</p>
        </div>
      ) : (
        <Hint>No turns yet.</Hint>
      )}
    </Block>
  );
}

export function OverviewSections({ hash }: { hash: string }) {
  // Read again when what it shows can have changed: a room's messages (reports, files linked), a run starting or
  // ending (its usage) — not with every step of a run. The room list is not read while the tab is hidden, so neither is this.
  const tick = useStore((s) =>
    s.rooms
      .filter((room) => room.projectHash === hash)
      .map((room) => `${room.id}:${room.messages}:${room.running}`)
      .join(","),
  );
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<Overview>("GET", `/api/projects/${hash}/overview`)
      .then((got) => {
        if (!live) return;
        setOverview(got);
        setError(null);
      })
      .catch((err) => live && !(err instanceof Unauthorized) && setError(errText(err)));
    return () => {
      live = false;
    };
  }, [hash, tick]);
  useEffect(() => setOverview(null), [hash]);
  if (error && !overview) return <ErrorNote>{error}</ErrorNote>;
  if (!overview) return <Loading lines={3} />;
  return (
    <>
      <Threads threads={overview.threads} />
      <Library entries={overview.library} rawBase={overview.rawBase} />
      <Usage usage={overview.usage} />
    </>
  );
}
