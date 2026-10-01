import { ArrowLeftIcon, ExternalLinkIcon, FileIcon, FolderOpenIcon, GitCompareArrowsIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { CodeFile } from "@/components/code/Code";
import { EmptyState, ErrorNote, Hint, Loading } from "@/components/common/states";
import { LiveFrame } from "@/components/md/LiveFrame";
import { Markdown, MermaidFile, rawUrl } from "@/components/md/Markdown";
import { DataTable, Player } from "@/components/md/Media";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, roomPath } from "@/lib/api";
import { AUDIO_EXT, baseName, DIAGRAM_EXT, ext, FRAME_EXT, fullDate, IMAGE_EXT, kb, TABLE_EXT, VIDEO_EXT } from "@/lib/format";
import { useLoad } from "@/lib/load";
import { useStore } from "@/lib/store";

// The workspace in the side panel: its files, and one of them as it is now.

type FileView = { path: string; text: string; size: number; mtime: string; binary: boolean; truncated: boolean };

/** Ended turns: files are asked for again after each, since agents write between. */
const useEnded = () => useStore((s) => s.snap?.state.turns.filter((t) => t.status !== "running").length ?? 0);

function Raw({ label, path, text }: { label: string; path: string; text: string }) {
  return (
    <details>
      <summary className="cursor-pointer text-small text-muted-foreground select-none hover:text-foreground">{label}</summary>
      <CodeFile name={path} text={text} className="mt-2" />
    </details>
  );
}

function FileBody({ path }: { path: string }) {
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
  if (image) {
    return (
      <div className="grid place-items-center rounded-xl border border-border bg-[conic-gradient(var(--muted)_25%,transparent_0_50%,var(--muted)_0_75%,transparent_0)] bg-[length:16px_16px] p-3">
        <img src={`${url}${url.includes("?") ? "&" : "?"}v=${ended}`} alt={path} className="max-h-[70vh] max-w-full object-contain" />
      </div>
    );
  }
  if (media) {
    return (
      <div className="grid place-items-center">
        <Player url={url} kind={VIDEO_EXT.has(kind) ? "video" : "audio"} title={path} className={VIDEO_EXT.has(kind) ? "max-h-[70vh]" : undefined} />
      </div>
    );
  }
  if (file.error) return <ErrorNote>{file.error}</ErrorNote>;
  if (!file.data) return <Loading block className="py-2" />;
  const f = file.data;
  const meta = (
    <Hint className="tabular">
      {kb(f.size)} · modified {fullDate(f.mtime)}
      {f.truncated ? " · showing the beginning" : ""}
    </Hint>
  );
  if (FRAME_EXT.has(kind) || kind === "svg") {
    return (
      <>
        {meta}
        <div className="overflow-hidden rounded-xl border border-border bg-white">
          <LiveFrame src={url} title={path} initial={520} max={1600} />
        </div>
        {!f.binary ? <Raw label="Code" path={path} text={f.text} /> : null}
      </>
    );
  }
  if ((TABLE_EXT.has(kind) || DIAGRAM_EXT.has(kind)) && !f.binary) {
    return (
      <>
        {meta}
        {TABLE_EXT.has(kind) ? (
          <DataTable text={f.text} sep={kind === "tsv" ? "\t" : ","} cut={f.truncated} limit={1000} />
        ) : (
          <div className="rounded-xl border border-border bg-paper p-3">
            <MermaidFile url={url} />
          </div>
        )}
        <Raw label="Raw text" path={path} text={f.text} />
      </>
    );
  }
  if (f.binary) {
    return (
      <>
        {meta}
        <Hint>Binary file — no preview available.</Hint>
      </>
    );
  }
  if (kind === "md" || kind === "markdown") {
    return (
      <>
        {meta}
        <article className="rounded-xl border border-border bg-paper px-5 py-4">
          <Markdown text={f.text} variant="doc" />
        </article>
        <Raw label="Raw text" path={path} text={f.text} />
      </>
    );
  }
  return (
    <>
      {meta}
      <CodeFile name={path} text={f.text} />
    </>
  );
}

/** The last turn that changed this file, to see what it did. */
const useLastChange = (path: string) =>
  useStore((s) => {
    const turns = s.snap?.state.turns ?? [];
    for (let i = turns.length - 1; i >= 0; i--) if (turns[i]!.changes?.some((c) => c.path === path)) return turns[i]!.id;
    return null;
  });

function OneFile({ path }: { path: string }) {
  const rawBase = useStore((s) => s.snap?.rawBase ?? "");
  const openFile = useStore((s) => s.openFile);
  const openChanges = useStore((s) => s.openChanges);
  const changed = useLastChange(path);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/70 px-2 py-1.5">
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-small text-muted-foreground" onClick={() => openFile(null)}>
          <ArrowLeftIcon className="size-3.5" />
          All files
        </Button>
        <span className="min-w-0 flex-1 truncate text-right font-mono text-meta text-muted-foreground" title={path}>
          {path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : ""}
          <span className="text-foreground">{baseName(path)}</span>
        </span>
      </div>
      <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3 *:shrink-0">
        <FileBody key={path} path={path} />
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm" className="w-fit">
            <a href={rawUrl(rawBase, path)} target="_blank" rel="noopener noreferrer">
              <ExternalLinkIcon className="size-3.5" />
              Open in new tab
            </a>
          </Button>
          {changed ? (
            <Button variant="outline" size="sm" className="w-fit" onClick={() => openChanges({ scope: "turn", turn: changed, path })}>
              <GitCompareArrowsIcon className="size-3.5" />
              Last change
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FileList() {
  const room = useStore((s) => s.snap?.state);
  const openFile = useStore((s) => s.openFile);
  const ended = useEnded();
  const roomId = room?.id ?? "";
  const tree = useLoad(roomId ? `${roomId}:tree:${ended}` : null, () => api<{ files: string[] }>("GET", roomPath(roomId, "/tree")));
  const [q, setQ] = useState("");
  let body: ReactNode = <Loading block className="px-2 py-2" />;
  if (tree.error) body = <ErrorNote>{tree.error}</ErrorNote>;
  else if (tree.data) {
    const needle = q.trim().toLowerCase();
    const files = tree.data.files.filter((f) => !needle || f.toLowerCase().includes(needle));
    body = !tree.data.files.length ? (
      <EmptyState icon={FolderOpenIcon} title="Empty for now" text="Files the agents create will appear here." />
    ) : !files.length ? (
      <Hint className="px-2">Nothing found.</Hint>
    ) : (
      <div className="flex flex-col">
        {files.map((f) => (
          <button key={f} type="button" onClick={() => openFile(f)} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-accent">
            <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate font-mono text-small" title={f}>
              <span className="text-muted-foreground">{f.includes("/") ? f.slice(0, f.lastIndexOf("/") + 1) : ""}</span>
              {baseName(f)}
            </span>
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b border-border/70 px-3 py-2.5">
        <p className="truncate font-mono text-meta text-muted-foreground" title={room?.workspace}>
          {room?.workspace}
        </p>
        {(tree.data?.files.length ?? 0) > 8 ? <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a file…" aria-label="Find a file" className="h-8" /> : null}
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 py-2">{body}</div>
    </div>
  );
}

export function FilesPanel() {
  const path = useStore((s) => s.filePath);
  return path ? <OneFile path={path} /> : <FileList />;
}
