import { CheckIcon, CopyIcon, FileTextIcon, FolderIcon, GitBranchIcon, ImageIcon, LayoutGridIcon, ListIcon, PaperclipIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Hint } from "@/components/common/states";
import { rawUrl } from "@/components/md/Markdown";
import { base64, MAX_FILE } from "@/components/room/Attachments";
import { Button } from "@/components/ui/button";
import { api, local, Unauthorized } from "@/lib/api";
import { ago, baseName, ext, IMAGE_EXT, plural, took, VISUAL_EXT } from "@/lib/format";
import { errText } from "@/lib/load";
import { useStore } from "@/lib/store";
import { groupThreads, threadGroup } from "@/lib/threads";
import { cn } from "@/lib/utils";
import type { LibraryEntry, LibraryKind, ProjectOverview, ThreadView } from "@agora/overview";
import { Block } from "./Block";

/**
 * The project page's view across its rooms: the threads with what each last reported, the library (what was
 * attached, the rooms' documents, the media agents linked — each where it is, by its path), and what the rooms'
 * turns took. Read again when a room of the project changes.
 */

export type Overview = ProjectOverview & { rawBase: Record<string, string> };

const groupOf = (thread: ThreadView) => threadGroup({ running: thread.running, resolved: thread.resolved, spoke: Boolean(thread.report) });

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
        {thread.resolved ? (
          <span className="flex items-center gap-1 text-meta text-faint">
            <CheckIcon className="size-3 shrink-0" /> Resolved by {thread.resolved.by} {ago(thread.resolved.at)}
          </span>
        ) : null}
      </button>
    </li>
  );
}

export function Threads({ threads }: { threads: ThreadView[] }) {
  const columns = groupThreads(threads, groupOf);
  return (
    <Block title="Threads" aside={threads.length ? `${threads.length}` : undefined}>
      {threads.length ? (
        <div className="grid gap-4 @min-[36rem]:grid-cols-2">
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

/** By source, in this order: what the rooms write, what people added, what the agents linked, where else they work. */
const KIND_LABEL: Record<LibraryKind, string> = { doc: "Documents", upload: "Attached", media: "Agents’ media", context: "Context folders" };
const KIND_ICON = { upload: PaperclipIcon, doc: FileTextIcon, media: ImageIcon, context: FolderIcon };
const KINDS = Object.keys(KIND_LABEL) as LibraryKind[];

type LibraryView = "list" | "grid";

/** Where an entry came from, in a line: who, in which room or to the project, when. */
const sourceLine = (entry: LibraryEntry) => {
  const when = entry.at ? ` · ${ago(entry.at)}` : "";
  const gone = entry.exists ? "" : " · no longer there";
  if (entry.kind === "context") return `${entry.by ? `added by ${entry.by}` : "context folder"}${when}${gone}`;
  if (entry.added) return `added by ${entry.by} to the project${entry.alsoIn ? `, linked in ${plural(entry.alsoIn, "room", "rooms")}` : ""}${when}${gone}`;
  const rooms = `in “${entry.roomName}”${entry.alsoIn ? ` and ${plural(entry.alsoIn, "other room", "other rooms")}` : ""}`;
  if (entry.kind === "doc") return `${plural(entry.revisions ?? 0, "revision", "revisions")}${entry.by ? `, last by ${entry.by}` : ""} ${rooms}${when}${gone}`;
  return `linked by ${entry.by} ${rooms}${when}${gone}`;
};

function useEntry(entry: LibraryEntry, rawBase: string | undefined, onChange: () => void, hash?: string) {
  const go = useStore((s) => s.go);
  const setPanel = useStore((s) => s.setPanel);
  // Served through the room that links it, while it links it, and only media: a picture shows, any media opens.
  const url = entry.kind !== "doc" && entry.kind !== "context" && entry.exists && rawBase && VISUAL_EXT.has(ext(entry.path)) ? rawUrl(rawBase, `~abs/${entry.path.replace(/^\//, "")}`) : null;
  const picture = url && IMAGE_EXT.has(ext(entry.path)) ? url : null;
  const open =
    entry.kind === "doc"
      ? () => {
          go({ kind: "room", id: entry.room });
          setPanel("doc");
        }
      : url
        ? () => window.open(url, "_blank", "noopener")
        : null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(entry.path);
      toast.success("Path copied");
    } catch {
      toast.error("Could not copy the path");
    }
  };
  // Out of the library, not off the disk: the file stays where it is.
  const remove =
    entry.added && hash
      ? async () => {
          try {
            await api("DELETE", `/api/projects/${hash}/library?path=${encodeURIComponent(entry.path)}`);
            onChange();
          } catch (err) {
            if (!(err instanceof Unauthorized)) toast.error(errText(err));
          }
        }
      : null;
  return { picture, open, copy, remove, Icon: KIND_ICON[entry.kind] };
}

const quietIcon = "shrink-0 text-faint transition hover:text-foreground";

function LibraryRow({ entry, rawBase, hash, onChange }: { entry: LibraryEntry; rawBase?: string; hash?: string; onChange: () => void }) {
  const { picture, open, copy, remove, Icon } = useEntry(entry, rawBase, onChange, hash);
  return (
    <li className="flex items-center gap-3 px-3.5 py-2.5">
      {picture ? (
        <img src={picture} alt="" loading="lazy" className="size-9 shrink-0 rounded-md object-cover ring-1 ring-border" />
      ) : (
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-secondary text-muted-foreground">
          <Icon className="size-4" />
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        {open ? (
          <button type="button" onClick={open} className="min-w-0 truncate text-left text-ui hover:underline" title={entry.path}>
            {baseName(entry.path)}
          </button>
        ) : (
          <span className="min-w-0 truncate text-ui" title={entry.path}>
            {baseName(entry.path)}
          </span>
        )}
        <span className="truncate text-meta text-faint">{sourceLine(entry)}</span>
      </span>
      {entry.kind !== "doc" ? (
        <button type="button" onClick={() => void copy()} title={`Copy the path: ${entry.path}`} aria-label="Copy the path" className={quietIcon}>
          <CopyIcon className="size-3.5" />
        </button>
      ) : null}
      {remove ? (
        <button type="button" onClick={() => void remove()} title="Take it out of the library (the file stays where it is)" aria-label="Take it out of the library" className={quietIcon}>
          <XIcon className="size-3.5" />
        </button>
      ) : null}
    </li>
  );
}

function LibraryTile({ entry, rawBase, hash, onChange }: { entry: LibraryEntry; rawBase?: string; hash?: string; onChange: () => void }) {
  const { picture, open, copy, remove, Icon } = useEntry(entry, rawBase, onChange, hash);
  return (
    <li className="group/tile relative flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card">
      <button type="button" onClick={open ?? (() => void copy())} title={open ? entry.path : `Copy the path: ${entry.path}`} className="flex min-w-0 flex-col text-left">
        {picture ? (
          <img src={picture} alt="" loading="lazy" className="aspect-[4/3] w-full bg-secondary object-cover" />
        ) : (
          <span className="grid h-16 w-full place-items-center bg-secondary text-muted-foreground">
            <Icon className="size-5" />
          </span>
        )}
        <span className="flex min-w-0 flex-col px-2.5 py-2">
          <span className="truncate text-small">{baseName(entry.path)}</span>
          <span className="truncate text-micro text-faint">{sourceLine(entry)}</span>
        </span>
      </button>
      {remove ? (
        <button
          type="button"
          onClick={() => void remove()}
          title="Take it out of the library (the file stays where it is)"
          aria-label="Take it out of the library"
          className="absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-full bg-background/80 text-muted-foreground opacity-0 transition group-hover/tile:opacity-100 hover:text-foreground focus-visible:opacity-100"
        >
          <XIcon className="size-3.5" />
        </button>
      ) : null}
    </li>
  );
}

/** + Add: a file goes where attached files are kept, and into the project's library by that path. */
function AddFile({ hash, onChange }: { hash: string; onChange: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const add = async (files: File[]) => {
    setBusy(true);
    try {
      for (const file of files) {
        if (file.size > MAX_FILE) {
          toast.error(`${file.name} is over 20 MB`);
          continue;
        }
        const { path } = await api<{ path: string }>("POST", "/api/uploads", { name: file.name, data: await base64(file) });
        await api("POST", `/api/projects/${hash}/library`, { path });
      }
      onChange();
    } catch (err) {
      if (!(err instanceof Unauthorized)) toast.error(errText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length) void add(files);
        }}
      />
      <Button variant="ghost" size="sm" disabled={busy} className="h-7 gap-1 px-2 text-meta" onClick={() => input.current?.click()} title="Add a file to the project: its agents are told where it is">
        <PlusIcon className="size-3.5" />
        Add
      </Button>
    </>
  );
}

export function Library({ entries, rawBase, hash, onChange }: { entries: LibraryEntry[]; rawBase: Record<string, string>; hash?: string; onChange?: () => void }) {
  const [kind, setKind] = useState<LibraryKind | null>(null);
  const [view, setView] = useState<LibraryView>(() => (local.get("libraryView") === "grid" ? "grid" : "list"));
  const changed = onChange ?? (() => {});
  const pick = (next: LibraryView) => {
    setView(next);
    local.set("libraryView", next);
  };
  const groups = KINDS.map((id) => ({ id, entries: entries.filter((entry) => entry.kind === id) })).filter((group) => group.entries.length && (!kind || group.id === kind));
  const counts = KINDS.map((id) => ({ id, n: entries.filter((entry) => entry.kind === id).length })).filter(({ n }) => n);
  const item = (entry: LibraryEntry) => {
    const key = `${entry.kind}:${entry.room}:${entry.path}`;
    const props = { entry, rawBase: rawBase[entry.room], hash, onChange: changed };
    return view === "grid" ? <LibraryTile key={key} {...props} /> : <LibraryRow key={key} {...props} />;
  };
  return (
    <Block
      title="Library"
      aside={
        <span className="flex items-center gap-1">
          {entries.length ? <span className="mr-1">{entries.length}</span> : null}
          {entries.length ? (
            <span className="flex items-center rounded-md border border-border/70 p-0.5">
              {(["list", "grid"] as const).map((id) => {
                const Icon = id === "list" ? ListIcon : LayoutGridIcon;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => pick(id)}
                    aria-pressed={view === id}
                    aria-label={id === "list" ? "As a list" : "As a grid"}
                    className={cn("grid size-6 place-items-center rounded transition", view === id ? "bg-accent text-foreground" : "text-faint hover:text-foreground")}
                  >
                    <Icon className="size-3.5" />
                  </button>
                );
              })}
            </span>
          ) : null}
          {hash ? <AddFile hash={hash} onChange={changed} /> : null}
        </span>
      }
    >
      <p className="text-small leading-relaxed text-muted-foreground">
        The rooms’ documents, files attached or added here, media the agents linked, and the context folders. Each stays where it is; nothing is copied.
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
      {groups.length ? (
        groups.map((group) => (
          <section key={group.id} className="flex flex-col gap-1.5">
            {groups.length > 1 || kind ? (
              <h3 className="text-micro font-medium text-faint">
                {KIND_LABEL[group.id]} {group.entries.length}
              </h3>
            ) : null}
            {view === "grid" ? (
              <ul className="grid grid-cols-2 gap-2 @min-[28rem]:grid-cols-3 @min-[44rem]:grid-cols-4">{group.entries.map(item)}</ul>
            ) : (
              <ul className="flex flex-col divide-y divide-border/60 rounded-xl border border-border/70">{group.entries.map(item)}</ul>
            )}
          </section>
        ))
      ) : (
        <Hint>Nothing attached, written or linked yet.</Hint>
      )}
    </Block>
  );
}

export function Usage({ usage }: { usage: ProjectOverview["usage"] }) {
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

/** The project's overview, read again when one of its rooms changes. */
export function useOverview(hash: string): { overview: Overview | null; error: string | null; reload: () => void } {
  // Read again when what it shows can have changed: a room's messages (reports, files linked), a run starting or
  // ending (its usage) — not with every step of a run. The room list is not read while the tab is hidden, so neither is this.
  const tick = useStore((s) =>
    s.rooms
      .filter((room) => room.projectHash === hash)
      .map((room) => `${room.id}:${room.messages}:${room.running}:${room.resolved?.at ?? ""}`)
      .join(","),
  );
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  // After a change made here (+ Add, taking a file out): read again now.
  const [again, setAgain] = useState(0);
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
  }, [hash, tick, again]);
  useEffect(() => setOverview(null), [hash]);
  return { overview, error, reload: () => setAgain((n) => n + 1) };
}
