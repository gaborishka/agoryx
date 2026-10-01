import {
  ChevronRightIcon,
  CircleAlertIcon,
  ExternalLinkIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  GitCompareArrowsIcon,
  PanelLeftIcon,
  TextWrapIcon,
  XIcon,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { CodeFile, EditableCode } from "@/components/code/Code";
import { EmptyState, ErrorNote, Hint, Loading } from "@/components/common/states";
import { LiveFrame } from "@/components/md/LiveFrame";
import { Markdown, MermaidFile, rawUrl } from "@/components/md/Markdown";
import { DataTable, Player } from "@/components/md/Media";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, local, roomPath } from "@/lib/api";
import { AUDIO_EXT, baseName, DIAGRAM_EXT, ext, FRAME_EXT, fullDate, IMAGE_EXT, kb, TABLE_EXT, VIDEO_EXT } from "@/lib/format";
import { isMac } from "@/lib/keys";
import { useLoad } from "@/lib/load";
import { saverFor, unsaved, useSaveState } from "@/lib/saves";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

// The workspace in the side panel, as in T3 Code: a tree of its files with a search, the open files as tabs,
// and a text file edited in place — saved on its own half a second after the typing stops, never over what an
// agent wrote since it was opened.

type FileView = { path: string; text: string; size: number; mtime: string; binary: boolean; truncated: boolean; hash: string | null };

/** Ended turns: files are asked for again after each, since agents write between. */
const useEnded = () => useStore((s) => s.snap?.state.turns.filter((t) => t.status !== "running").length ?? 0);

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (event) => {
    if (unsaved()) event.preventDefault();
  });
}

function Raw({ label, path, text }: { label: string; path: string; text: string }) {
  return (
    <details>
      <summary className="cursor-pointer text-small text-muted-foreground select-none hover:text-foreground">{label}</summary>
      <CodeFile name={path} text={text} className="mt-2" />
    </details>
  );
}

function Conflict({ roomId, path, onTake }: { roomId: string; path: string; onTake: (disk: { hash: string | null; text: string | null }) => void }) {
  const state = useSaveState(roomId, path);
  if (state.status !== "conflict" && state.status !== "error") return null;
  const saver = saverFor(roomId, path, null);
  if (state.status === "error") {
    return (
      <div className="flex shrink-0 items-center gap-2 border-b border-border/70 bg-destructive-soft px-3 py-2 text-small">
        <CircleAlertIcon className="size-4 shrink-0 text-destructive" />
        <span className="min-w-0 flex-1">Not saved: {state.error}</span>
        <Button size="sm" variant="outline" className="h-7" onClick={() => void saver.flush()}>
          Try again
        </Button>
      </div>
    );
  }
  const disk = state.disk ?? { hash: null, text: null };
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/70 bg-amber-500/10 px-3 py-2 text-small">
      <CircleAlertIcon className="size-4 shrink-0 text-amber-600" />
      <span className="min-w-0 flex-1">The file changed on disk while you were editing it — your changes are not written yet.</span>
      <Button size="sm" variant="outline" className="h-7" onClick={() => onTake(disk)}>
        Take the disk's
      </Button>
      <Button size="sm" variant="outline" className="h-7" onClick={() => saver.overwrite()}>
        Keep mine
      </Button>
    </div>
  );
}

/** A text file, edited in place. */
function EditableFile({ roomId, path, file, wrap }: { roomId: string; path: string; file: FileView; wrap: boolean }) {
  const saver = saverFor(roomId, path, file.hash);
  // What the editor opened with; it moves only when nothing typed is left unsaved (a turn changed the file) or
  // the human took the disk's version.
  const [doc, setDoc] = useState(() => ({ hash: file.hash, text: saver.pending ?? file.text, n: 0 }));
  useEffect(() => {
    if (!saver.clean || file.hash === saver.base) return;
    saver.base = file.hash;
    setDoc((d) => ({ hash: file.hash, text: file.text, n: d.n + 1 }));
  }, [file.hash, file.text, saver]);
  const take = (disk: { hash: string | null; text: string | null }) => {
    saver.discard(disk.hash);
    setDoc((d) => ({ hash: disk.hash, text: disk.text ?? "", n: d.n + 1 }));
  };
  const keys = (event: KeyboardEvent) => {
    if ((isMac ? event.metaKey : event.ctrlKey) && event.code === "KeyS") {
      event.preventDefault();
      void saver.flush();
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={keys}>
      <Conflict roomId={roomId} path={path} onTake={take} />
      <div className="scroll-thin min-h-0 flex-1 overflow-auto">
        <EditableCode name={path} text={doc.text} stateKey={`${roomId}:${path}:${doc.hash}:${doc.n}`} wrap={wrap} onText={(text) => saver.change(text)} />
      </div>
    </div>
  );
}

function Shown({ children }: { children: ReactNode }) {
  return <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3 *:shrink-0">{children}</div>;
}

function FileBody({ path, wrap, source }: { path: string; wrap: boolean; source: boolean }) {
  const roomId = useStore((s) => s.snap?.state.id ?? "");
  const rawBase = useStore((s) => s.snap?.rawBase ?? "");
  const ended = useEnded();
  const kind = ext(path);
  const url = rawUrl(rawBase, path);
  const image = IMAGE_EXT.has(kind) && kind !== "svg";
  const media = VIDEO_EXT.has(kind) || AUDIO_EXT.has(kind);
  const file = useLoad(image || media ? null : `${roomId}:${path}:${ended}`, () =>
    api<FileView>("GET", `${roomPath(roomId, "/file")}?path=${encodeURIComponent(path)}`),
  );
  // The loaded file stays shown while the next one loads, so the editor is not torn down after every turn.
  const [last, setLast] = useState<FileView | null>(null);
  useEffect(() => {
    if (file.data) setLast(file.data);
  }, [file.data]);
  if (image) {
    return (
      <Shown>
        <div className="grid place-items-center rounded-xl border border-border bg-[conic-gradient(var(--muted)_25%,transparent_0_50%,var(--muted)_0_75%,transparent_0)] bg-[length:16px_16px] p-3">
          <img src={`${url}${url.includes("?") ? "&" : "?"}v=${ended}`} alt={path} className="max-h-[70vh] max-w-full object-contain" />
        </div>
      </Shown>
    );
  }
  if (media) {
    return (
      <Shown>
        <div className="grid place-items-center">
          <Player url={url} kind={VIDEO_EXT.has(kind) ? "video" : "audio"} title={path} className={VIDEO_EXT.has(kind) ? "max-h-[70vh]" : undefined} />
        </div>
      </Shown>
    );
  }
  const f = file.data ?? (last?.path === path ? last : null);
  if (file.error && !f) return <ErrorNote className="m-3">{file.error}</ErrorNote>;
  if (!f) return <Loading block className="px-4 py-3" />;
  const meta = (
    <Hint className="tabular">
      {kb(f.size)} · modified {fullDate(f.mtime)}
      {f.truncated ? " · showing the beginning" : ""}
    </Hint>
  );
  if (FRAME_EXT.has(kind) || kind === "svg") {
    if (source && !f.binary && f.hash) return <EditableFile roomId={roomId} path={path} file={f} wrap={wrap} />;
    return (
      <Shown>
        {meta}
        <div className="overflow-hidden rounded-xl border border-border bg-white">
          <LiveFrame src={url} title={path} initial={520} max={1600} />
        </div>
      </Shown>
    );
  }
  if ((TABLE_EXT.has(kind) || DIAGRAM_EXT.has(kind)) && !f.binary) {
    if (source && f.hash) return <EditableFile roomId={roomId} path={path} file={f} wrap={wrap} />;
    return (
      <Shown>
        {meta}
        {TABLE_EXT.has(kind) ? (
          <DataTable text={f.text} sep={kind === "tsv" ? "\t" : ","} cut={f.truncated} limit={1000} />
        ) : (
          <div className="rounded-xl border border-border bg-paper p-3">
            <MermaidFile url={url} />
          </div>
        )}
        {!f.hash ? <Raw label="Raw text" path={path} text={f.text} /> : null}
      </Shown>
    );
  }
  if (f.binary) {
    return (
      <Shown>
        {meta}
        <Hint>Binary file — no preview available.</Hint>
      </Shown>
    );
  }
  if ((kind === "md" || kind === "markdown") && !source) {
    return (
      <Shown>
        {meta}
        <article className="rounded-xl border border-border bg-paper px-5 py-4">
          <Markdown text={f.text} variant="doc" />
        </article>
      </Shown>
    );
  }
  // Too large to edit whole: shown, not edited.
  if (!f.hash) {
    return (
      <Shown>
        {meta}
        <CodeFile name={path} text={f.text} />
      </Shown>
    );
  }
  return <EditableFile roomId={roomId} path={path} file={f} wrap={wrap} />;
}

/** The last turn that changed this file, to see what it did. */
const useLastChange = (path: string) =>
  useStore((s) => {
    const turns = s.snap?.state.turns ?? [];
    for (let i = turns.length - 1; i >= 0; i--) if (turns[i]!.changes?.some((c) => c.path === path)) return turns[i]!.id;
    return null;
  });

function SaveMark({ roomId, path }: { roomId: string; path: string }) {
  const { status } = useSaveState(roomId, path);
  if (status === "saved") return null;
  const label = { dirty: "Unsaved", saving: "Saving…", conflict: "Conflicts with the disk", error: "Not saved" }[status];
  return <span className={cn("size-2 shrink-0 rounded-full", status === "conflict" || status === "error" ? "bg-destructive" : "bg-foreground/60", status === "saving" && "animate-pulse")} title={label} aria-label={label} />;
}

/** Files with a view of their own: a toggle between it and the text. */
const hasView = (path: string) => {
  const kind = ext(path);
  return kind === "md" || kind === "markdown" || kind === "svg" || FRAME_EXT.has(kind) || TABLE_EXT.has(kind) || DIAGRAM_EXT.has(kind);
};

function Crumbs({ path }: { path: string }) {
  const parts = path.split("/");
  return (
    <span className="flex min-w-0 flex-1 items-center gap-0.5 truncate font-mono text-meta text-muted-foreground" title={path}>
      {parts.map((part, i) => (
        <span key={i} className="flex min-w-0 items-center gap-0.5">
          {i ? <ChevronRightIcon className="size-3 shrink-0 opacity-60" /> : null}
          <span className={cn("truncate", i === parts.length - 1 && "text-foreground")}>{part}</span>
        </span>
      ))}
    </span>
  );
}

function FileArea({ path }: { path: string }) {
  const roomId = useStore((s) => s.snap?.state.id ?? "");
  const rawBase = useStore((s) => s.snap?.rawBase ?? "");
  const openChanges = useStore((s) => s.openChanges);
  const changed = useLastChange(path);
  const [wrap, setWrap] = useState(() => local.get("wrap") !== "0");
  const [source, setSource] = useState(false);
  const toggleWrap = () => {
    local.set("wrap", wrap ? "0" : null);
    setWrap(!wrap);
  };
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/70 pr-1 pl-3">
        <Crumbs path={path} />
        {hasView(path) ? (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-small text-muted-foreground" onClick={() => setSource(!source)} aria-pressed={source}>
            {source ? "Preview" : "Text"}
          </Button>
        ) : null}
        <Button variant="ghost" size="icon" className={cn("size-7", wrap ? "text-foreground" : "text-muted-foreground")} onClick={toggleWrap} aria-pressed={wrap} aria-label="Wrap lines" title="Wrap lines">
          <TextWrapIcon className="size-3.5" />
        </Button>
        {changed ? (
          <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" onClick={() => openChanges({ scope: "turn", turn: changed, path })} aria-label="Last change" title="Last change">
            <GitCompareArrowsIcon className="size-3.5" />
          </Button>
        ) : null}
        <Button asChild variant="ghost" size="icon" className="size-7 text-muted-foreground">
          <a href={rawUrl(rawBase, path)} target="_blank" rel="noopener noreferrer" aria-label="Open in a new tab" title="Open in a new tab">
            <ExternalLinkIcon className="size-3.5" />
          </a>
        </Button>
      </div>
      <FileBody key={`${roomId}:${path}`} path={path} wrap={wrap} source={source} />
    </div>
  );
}

function FileTabs({ tabs, current }: { tabs: string[]; current: string | null }) {
  const roomId = useStore((s) => s.snap?.state.id ?? "");
  const openFile = useStore((s) => s.openFile);
  const closeFile = useStore((s) => s.closeFile);
  return (
    <div role="tablist" aria-label="Open files" className="scroll-thin flex min-w-0 flex-1 items-stretch overflow-x-auto">
      {tabs.map((path) => {
        const on = path === current;
        return (
          <div
            key={path}
            className={cn("group flex max-w-48 shrink-0 items-center gap-1 border-r border-border/70 pr-1 pl-2.5 text-small", on ? "bg-background text-foreground" : "bg-muted/40 text-muted-foreground hover:text-foreground")}
          >
            <button
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => openFile(path)}
              onAuxClick={(e) => e.button === 1 && closeFile(path)}
              className="flex min-w-0 items-center gap-1.5 py-1.5"
              title={path}
            >
              <span className="truncate font-mono text-meta">{baseName(path)}</span>
              <SaveMark roomId={roomId} path={path} />
            </button>
            <button
              type="button"
              aria-label={`Close ${baseName(path)}`}
              onClick={() => closeFile(path)}
              className={cn("grid size-5 shrink-0 place-items-center rounded hover:bg-accent", on ? "opacity-80" : "opacity-0 group-hover:opacity-80 focus:opacity-80")}
            >
              <XIcon className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

interface Dir {
  name: string;
  path: string;
  dirs: Map<string, Dir>;
  files: string[];
}

const buildTree = (files: string[]): Dir => {
  const root: Dir = { name: "", path: "", dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.split("/");
    let at = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]!;
      let next = at.dirs.get(name);
      if (!next) {
        next = { name, path: parts.slice(0, i + 1).join("/"), dirs: new Map(), files: [] };
        at.dirs.set(name, next);
      }
      at = next;
    }
    at.files.push(file);
  }
  return root;
};

/** The folders a file sits in: "a", "a/b" for "a/b/c.ts". */
const ancestors = (path: string) => {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
};

/** Letters of the query in order, anywhere in the path; the file's own name matching ranks first. */
const search = (files: string[], query: string) => {
  const needle = query.toLowerCase().replace(/\s+/g, "");
  const scored: Array<{ file: string; score: number }> = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    let at = 0;
    for (const ch of needle) {
      at = lower.indexOf(ch, at);
      if (at < 0) break;
      at += 1;
    }
    if (at < 0) continue;
    const name = baseName(lower);
    const score = (name.includes(needle) ? 0 : lower.includes(needle) ? 1 : 2) * 1000 + file.length;
    scored.push({ file, score });
  }
  return scored.sort((a, b) => a.score - b.score).slice(0, 200).map((s) => s.file);
};

function TreeRows({ dir, depth, open, toggle, current, onOpen }: { dir: Dir; depth: number; open: Set<string>; toggle: (path: string) => void; current: string | null; onOpen: (path: string) => void }) {
  const dirs = [...dir.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const files = [...dir.files].sort((a, b) => baseName(a).localeCompare(baseName(b)));
  const pad = { paddingLeft: `${depth * 12 + 6}px` };
  return (
    <>
      {dirs.map((d) => {
        const on = open.has(d.path);
        const Icon = on ? FolderOpenIcon : FolderIcon;
        return (
          <div key={d.path}>
            <button type="button" onClick={() => toggle(d.path)} aria-expanded={on} style={pad} className="flex w-full items-center gap-1 rounded-md py-1 pr-2 text-left text-small hover:bg-accent">
              <ChevronRightIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform", on && "rotate-90")} />
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate font-mono text-meta">{d.name}</span>
            </button>
            {on ? <TreeRows dir={d} depth={depth + 1} open={open} toggle={toggle} current={current} onOpen={onOpen} /> : null}
          </div>
        );
      })}
      {files.map((f) => (
        <button
          key={f}
          type="button"
          onClick={() => onOpen(f)}
          style={{ paddingLeft: `${depth * 12 + 22}px` }}
          className={cn("flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left hover:bg-accent", f === current && "bg-secondary text-secondary-foreground")}
          title={f}
        >
          <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-meta">{baseName(f)}</span>
        </button>
      ))}
    </>
  );
}

function Tree({ current, full, onPick }: { current: string | null; full: boolean; onPick: () => void }) {
  const room = useStore((s) => s.snap?.state);
  const openPath = useStore((s) => s.openFile);
  const openFile = (path: string) => {
    openPath(path);
    onPick();
  };
  const ended = useEnded();
  const roomId = room?.id ?? "";
  const tree = useLoad(roomId ? `${roomId}:tree:${ended}` : null, () => api<{ files: string[] }>("GET", roomPath(roomId, "/tree")));
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set(current ? ancestors(current) : []));
  const files = tree.data?.files;
  const root = useMemo(() => (files ? buildTree(files) : null), [files]);
  // A small folder opens whole; the shown file's folders always do.
  useEffect(() => {
    if (!files) return;
    setOpen((was) => {
      const next = new Set(was);
      if (files.length <= 40) for (const f of files) for (const a of ancestors(f)) next.add(a);
      if (current) for (const a of ancestors(current)) next.add(a);
      return next.size === was.size ? was : next;
    });
  }, [files, current]);
  const toggle = (path: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  let body: ReactNode = <Loading block className="px-2 py-2" />;
  if (tree.error) body = <ErrorNote>{tree.error}</ErrorNote>;
  else if (files && root) {
    const found = q.trim() ? search(files, q) : null;
    body = !files.length ? (
      <EmptyState icon={FolderOpenIcon} title="Nothing here yet" text="Files the agents create will appear here." />
    ) : found && !found.length ? (
      <Hint className="px-2">Nothing found.</Hint>
    ) : found ? (
      <div className="flex flex-col">
        {found.map((f) => (
          <button key={f} type="button" onClick={() => openFile(f)} className={cn("flex items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-accent", f === current && "bg-secondary")} title={f}>
            <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate font-mono text-meta">
              {baseName(f)}
              <span className="ml-1.5 text-muted-foreground">{f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ""}</span>
            </span>
          </button>
        ))}
      </div>
    ) : (
      <TreeRows dir={root} depth={0} open={open} toggle={toggle} current={current} onOpen={openFile} />
    );
  }
  return (
    <div className={cn("flex min-h-0 min-w-0 flex-col", full ? "flex-1" : "w-56 shrink-0 border-r border-border/70")}>
      <div className="flex shrink-0 flex-col gap-2 border-b border-border/70 px-2 py-2">
        {full ? (
          <p className="truncate px-1 font-mono text-meta text-muted-foreground" title={room?.workspace}>
            {room?.workspace}
          </p>
        ) : null}
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a file…" aria-label="Find a file" className="h-7 text-small" />
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-1 py-1.5">{body}</div>
    </div>
  );
}

export function FilesPanel() {
  const path = useStore((s) => s.filePath);
  const fileTabs = useStore((s) => s.fileTabs);
  const wide = useStore((s) => s.wide);
  const tabs = path && !fileTabs.includes(path) ? [...fileTabs, path] : fileTabs;
  // Beside the file when the panel is wide; over it when narrow, until a file is picked.
  const [treeShown, setTreeShown] = useState<boolean | null>(null);
  const tree = !path || (treeShown ?? wide);
  useEffect(() => {
    if (!wide) setTreeShown(null);
  }, [path, wide]);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {tabs.length ? (
        <div className="flex h-9 shrink-0 items-stretch border-b border-border/70 bg-muted/40">
          <Button
            variant="ghost"
            size="icon"
            className={cn("size-9 shrink-0 rounded-none border-r border-border/70", tree ? "text-foreground" : "text-muted-foreground")}
            onClick={() => setTreeShown(!tree)}
            disabled={!path}
            aria-pressed={tree}
            aria-label="File tree"
            title="File tree"
          >
            <PanelLeftIcon className="size-4" />
          </Button>
          <FileTabs tabs={tabs} current={path} />
        </div>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1">
        {tree ? <Tree current={path} full={!path || !wide} onPick={() => !wide && setTreeShown(null)} /> : null}
        {path && !(tree && !wide) ? <FileArea key={path} path={path} /> : null}
      </div>
    </div>
  );
}
