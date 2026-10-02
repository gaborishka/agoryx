import { workspaceAt } from "@agora/room-mode";
import { liveBlocks } from "@agora/blocks";
import { createCodePlugin } from "@streamdown/code";
import type { DiagramPlugin, MermaidConfig } from "@streamdown/mermaid";
import { Code2Icon, ExternalLinkIcon, FileIcon, FileXIcon, Maximize2Icon } from "lucide-react";
import { type ComponentProps, createContext, useContext, memo, type ReactNode, useMemo, useState } from "react";
import { type Components, type CustomRendererProps, defaultRemarkPlugins, parseMarkdownIntoBlocks, Streamdown, type StreamdownTranslations } from "streamdown";
import { AUDIO_EXT, baseName, DIAGRAM_EXT, ext, FRAME_EXT, hashBlock, IMAGE_EXT, TABLE_EXT, VIDEO_EXT, VISUAL_EXT, workspaceRel } from "@/lib/format";
import { ink, participant, refExists, toneText } from "@/lib/room";
import { useStore } from "@/lib/store";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { LiveFrame } from "./LiveFrame";
import { CsvFile, Player, useRawText } from "./Media";
import { localPath, messageRefId, remarkAgora, wholeBlocks } from "./remark-agora";

const code = createCodePlugin({ themes: ["vitesse-light", "vitesse-dark"] });
/**
 * The @streamdown/mermaid plugin, but mermaid (half a megabyte) is imported on the first diagram,
 * not with the page. Mermaid is one global, so each render applies its own theme first.
 */
const lazyMermaid = (base: MermaidConfig): DiagramPlugin => {
  let config: MermaidConfig = { startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, ...base };
  const instance = {
    initialize(next: MermaidConfig) {
      config = { ...config, ...next };
    },
    async render(id: string, source: string) {
      const { default: mermaid } = await import("mermaid");
      mermaid.initialize(config);
      return mermaid.render(id, source);
    },
  };
  return {
    name: "mermaid",
    type: "diagram",
    language: "mermaid",
    getMermaid(next) {
      if (next) instance.initialize(next);
      return instance;
    },
  };
};
const mermaidLight = lazyMermaid({ theme: "neutral", fontFamily: "Instrument Sans Variable, system-ui, sans-serif" });
const mermaidDark = lazyMermaid({ theme: "dark", fontFamily: "Instrument Sans Variable, system-ui, sans-serif", darkMode: true });

const translations: Partial<StreamdownTranslations> = {
  close: "Close",
  copied: "Copied",
  copyCode: "Copy code",
  copyLink: "Copy link",
  copyTable: "Copy table",
  copyTableAsCsv: "As CSV",
  copyTableAsMarkdown: "As Markdown",
  copyTableAsTsv: "As TSV",
  downloadDiagram: "Download diagram",
  downloadDiagramAsMmd: "As MMD",
  downloadDiagramAsPng: "As PNG",
  downloadDiagramAsSvg: "As SVG",
  downloadFile: "Download file",
  downloadImage: "Download image",
  downloadTable: "Download table",
  downloadTableAsCsv: "As CSV",
  downloadTableAsMarkdown: "As Markdown",
  exitFullscreen: "Exit full screen",
  externalLinkWarning: "This link leads to an external site",
  imageNotAvailable: "Image not available",
  openExternalLink: "Open external link",
  openLink: "Open link",
  resetView: "Reset view",
  viewFullscreen: "Full screen",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
};

const defaultRemark = Object.values(defaultRemarkPlugins);
const blocks = wholeBlocks(parseMarkdownIntoBlocks);

export const rawUrl = (rawBase: string, path: string) => rawBase + path.split("/").map(encodeURIComponent).join("/");

/** A media file outside the workspace, served from where it is while a message links it. */
const outsideUrl = (rawBase: string, path: string) => rawUrl(rawBase, `~abs/${path.replace(/^\//, "")}`);
const isAbsPath = (path: string) => path.startsWith("/") || path.startsWith("~/");

/** The file an embed pointed at is no longer where it was; the room kept no copy. */
function Gone({ path }: { path: string }) {
  return (
    <span title={path} className="my-1 inline-flex max-w-full items-center gap-2 rounded-lg border border-dashed border-border px-2.5 py-1.5 align-top text-small text-muted-foreground">
      <FileXIcon className="size-4 shrink-0" />
      <span className="shrink-0">the file is gone</span>
      <span className="truncate font-mono text-meta">{path}</span>
    </span>
  );
}

/** Where a fence lives, so the daemon can serve it as its own page: m:<message id> or o:<option id>. */
type Source = string | undefined;
const FileSource = createContext<number | undefined>(undefined);

function Source({ code: text, lang }: { code: string; lang: string }) {
  return (
    <details className="group border-t border-border">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground">
        <Code2Icon className="size-3.5" /> <span className="font-mono">{lang}</span> code
      </summary>
      <pre className="scroll-thin max-h-80 overflow-auto border-t border-border bg-code px-3 py-2.5 font-mono text-small leading-relaxed">{text}</pre>
    </details>
  );
}

const makeLiveRenderer = (source: Source, text: string) =>
  function LiveBlock({ code: fence, isIncomplete, language }: CustomRendererProps) {
    const rawBase = useStore((s) => s.snap?.rawBase);
    const lang = language.toLowerCase();
    const block = useMemo(() => liveBlocks(text).find((b) => b.lang === lang && b.body.trim() === fence.trim()), [fence, lang]);
    if (isIncomplete || !source || !rawBase || !block) {
      return (
        <div className="my-3 overflow-hidden rounded-xl border border-border bg-code">
          <div className="border-b border-border px-3 py-1.5 font-mono text-meta text-muted-foreground">{lang}</div>
          <pre className="scroll-thin max-h-96 overflow-auto px-3 py-2.5 font-mono text-small leading-relaxed">{fence}</pre>
        </div>
      );
    }
    const url = `${rawBase}~block/${source}/${hashBlock(block.body)}`;
    if (lang === "svg") {
      return (
        <figure className="my-3 overflow-hidden rounded-xl border border-border bg-paper">
          <img src={url} alt="SVG" className="mx-auto block max-w-full p-3" />
          <Source code={fence} lang={lang} />
        </figure>
      );
    }
    return (
      <figure className="my-3 overflow-hidden rounded-xl border border-border bg-paper shadow-soft">
        <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          <span className="size-2 rounded-full bg-add-ink/70" />
          <span className="font-mono">html</span>
          <span className="text-faint">live page</span>
          <a href={url} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-accent hover:text-foreground">
            <Maximize2Icon className="size-3.5" /> Full screen
          </a>
        </div>
        <LiveFrame src={url} title="HTML" />
        <Source code={fence} lang={lang} />
      </figure>
    );
  };

function Mention({ handle, children }: { handle: string; children: ReactNode }) {
  const room = useStore((s) => s.snap?.state);
  const known = room && (room.agents.some((a) => a.id === handle) || handle === room.human);
  if (!known) return <>{children}</>;
  const p = participant(room, handle);
  return (
    <span className={cn("font-medium", toneText[p.tone])} style={ink(p)}>
      @{p.agent ? p.label : handle}
    </span>
  );
}

function Ref({ id }: { id: string }) {
  const exists = useStore((s) => (s.snap ? refExists(s.snap.state, id) : false));
  const goToRef = useStore((s) => s.goToRef);
  if (!exists) return <>{id}</>;
  return (
    <button
      type="button"
      onClick={() => goToRef(id)}
      title="Show on the table"
      className="mx-px inline-flex items-center rounded bg-secondary px-1 font-mono text-[0.84em] font-semibold text-secondary-foreground ring-1 ring-primary/15 transition hover:bg-primary hover:text-primary-foreground"
    >
      {id}
    </button>
  );
}

/** A quote's source line: the message it came from, one click away. */
function MessageRef({ id, children }: { id: string; children: ReactNode }) {
  const exists = useStore((s) => s.snap?.state.messages.some((m) => m.id === id) ?? false);
  const goToRef = useStore((s) => s.goToRef);
  if (!exists) return <span className="font-medium">{children}</span>;
  return (
    <button
      type="button"
      onClick={() => goToRef(`m-${id}`)}
      title="Show the message"
      className="inline text-left font-medium text-foreground/80 underline decoration-border underline-offset-[3px] hover:text-foreground hover:decoration-current"
    >
      {children}
    </button>
  );
}

/** A quote's source line for lines of a diff: that turn's changes, at that file. */
function TurnRef({ turn, path, children }: { turn: string; path: string; children: ReactNode }) {
  const exists = useStore((s) => s.snap?.state.turns.some((t) => t.id === turn) ?? false);
  const openChanges = useStore((s) => s.openChanges);
  if (!exists) return <span className="font-medium">{children}</span>;
  let file = path;
  try {
    file = decodeURIComponent(path);
  } catch {
    // a hand-written link with a stray %: take it as written
  }
  return (
    <button
      type="button"
      onClick={() => openChanges({ scope: "turn", turn, path: file })}
      title="Show the turn's changes"
      className="inline text-left font-medium text-foreground/80 underline decoration-border underline-offset-[3px] hover:text-foreground hover:decoration-current"
    >
      {children}
    </button>
  );
}

function FileLink({ path, children }: { path: string; children: ReactNode }) {
  const openFile = useStore((s) => s.openFile);
  return (
    <button
      type="button"
      onClick={() => openFile(path)}
      title={`Open ${path}`}
      className="inline text-left text-primary underline decoration-primary/35 underline-offset-[3px] hover:decoration-current"
    >
      {children}
    </button>
  );
}

function Link({ href, children }: ComponentProps<"a">) {
  const seq = useContext(FileSource);
  const room = useStore((s) => s.snap?.state);
  const workspace = room && seq ? workspaceAt(room, seq) : room?.workspace;
  const rawBase = useStore((s) => s.snap?.rawBase);
  if (href?.startsWith("#@")) return <Mention handle={href.slice(2)}>{children}</Mention>;
  if (href?.startsWith("#~")) return <Ref id={href.slice(2)} />;
  const messageId = messageRefId(href);
  if (messageId) return <MessageRef id={messageId}>{children}</MessageRef>;
  const turnRef = href?.match(/^#(t[0-9a-z]+)\/(.+)$/);
  if (turnRef) return <TurnRef turn={turnRef[1]!} path={turnRef[2]!}>{children}</TurnRef>;
  const local = localPath(href);
  const rel = workspaceRel(local ?? href, workspace);
  if (rel && rawBase && seq && workspace !== room?.workspace) return <a href={rawUrl(rawBase, `~at/${seq}/${rel}`)} target="_blank" rel="noopener noreferrer" className="text-primary underline">{children}</a>;
  if (rel) return <FileLink path={rel}>{children}</FileLink>;
  if (local !== null && !(rawBase && isAbsPath(local) && VISUAL_EXT.has(ext(local)))) return <span title={local}>{children}</span>;
  if (local !== null) href = outsideUrl(rawBase!, local);
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline decoration-primary/35 underline-offset-[3px] hover:decoration-current">
      {children}
    </a>
  );
}

function Embed({ src, alt }: ComponentProps<"img">) {
  const seq = useContext(FileSource);
  const room = useStore((s) => s.snap?.state);
  const workspace = room && seq ? workspaceAt(room, seq) : room?.workspace;
  const rawBase = useStore((s) => s.snap?.rawBase);
  const openFile = useStore((s) => s.openFile);
  const [gone, setGone] = useState(false);
  const url = typeof src === "string" ? (localPath(src) ?? src) : "";
  if (/^https?:|^data:image\//i.test(url)) {
    return (
      <span className="my-2 inline-flex max-w-full flex-col gap-1 align-top">
        <img src={url} alt={alt ?? ""} loading="lazy" className="max-h-[520px] max-w-full rounded-lg border border-border object-contain" />
        {alt ? <span className="text-xs text-muted-foreground">{alt}</span> : null}
      </span>
    );
  }
  const rel = workspaceRel(url, workspace);
  // Outside the workspace only media shows, straight from where the agent saved it.
  const abs = !rel && isAbsPath(url) && VISUAL_EXT.has(ext(url)) ? url : null;
  const path = rel ?? abs;
  if (!path || !rawBase) return <span className="text-muted-foreground">[{alt || url}]</span>;
  if (gone) return <Gone path={path} />;
  const historical = seq !== undefined && workspace !== room?.workspace;
  const file = rel ? rawUrl(rawBase, historical ? `~at/${seq}/${rel}` : rel) : outsideUrl(rawBase, path);
  const open = () => (rel && !historical ? openFile(rel) : window.open(file, "_blank", "noopener"));
  const caption = alt || baseName(path);
  const e = ext(path);
  if (IMAGE_EXT.has(e)) {
    return (
      <button type="button" onClick={open} className="group my-2 inline-flex max-w-full flex-col gap-1 text-left align-top" title={path}>
        <img src={file} alt={caption} loading="lazy" onError={() => setGone(true)} className="max-h-[520px] max-w-full rounded-lg border border-border bg-paper object-contain transition group-hover:shadow-soft" />
        <span className="text-xs text-muted-foreground">{caption}</span>
      </button>
    );
  }
  if (FRAME_EXT.has(e)) {
    return (
      <span className="my-3 block overflow-hidden rounded-xl border border-border bg-paper shadow-soft">
        <span className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          <span className="font-mono">{e}</span>
          <span className="truncate font-mono" title={path}>{rel ?? caption}</span>
          <a href={file} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-accent hover:text-foreground">
            <ExternalLinkIcon className="size-3.5" /> Open
          </a>
        </span>
        <LiveFrame src={file} title={path} initial={e === "pdf" ? 560 : 360} />
      </span>
    );
  }
  if (VIDEO_EXT.has(e) || AUDIO_EXT.has(e)) {
    return (
      <span className="my-2 inline-flex max-w-full flex-col gap-1 align-top">
        <Player url={file} kind={VIDEO_EXT.has(e) ? "video" : "audio"} title={path} onError={() => setGone(true)} />
        <span className="text-xs text-muted-foreground">{caption}</span>
      </span>
    );
  }
  if (TABLE_EXT.has(e) || DIAGRAM_EXT.has(e)) {
    return (
      <span className="my-3 block">
        <button type="button" onClick={open} className="mb-1.5 inline-flex max-w-full items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground" title={path}>
          <span className="font-mono">{e}</span>
          <span className="truncate font-mono">{alt || rel || caption}</span>
        </button>
        {TABLE_EXT.has(e) ? <CsvFile url={file} name={path} /> : <MermaidFile url={file} />}
      </span>
    );
  }
  return (
    <button type="button" onClick={open} className="my-1 inline-flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm hover:bg-accent">
      <FileIcon className="size-4 text-muted-foreground" />
      <span className="font-mono text-small">{baseName(path)}</span>
      <span className="text-xs text-muted-foreground">open</span>
    </button>
  );
}

/** A workspace .mmd file, drawn like a ```mermaid fence. */
export function MermaidFile({ url }: { url: string }) {
  const file = useRawText(url);
  if (file.error) return <span className="text-small text-destructive">{file.error}</span>;
  if (file.text === undefined) return <span className="block h-24 animate-pulse rounded-xl bg-muted" />;
  return <Markdown text={`\`\`\`mermaid\n${file.text.trim()}\n\`\`\``} />;
}

const shifted = (Tag: "h2" | "h3" | "h4") =>
  function Heading({ children, id }: ComponentProps<"h2">) {
    return <Tag id={id}>{children}</Tag>;
  };

const plain = (Tag: "h1" | "h2" | "h3" | "h4") =>
  function Heading({ children, id }: ComponentProps<"h1">) {
    return <Tag id={id}>{children}</Tag>;
  };

export interface MarkdownProps {
  text: string;
  /** m:<id> or o:<id>: lets ```html / ```svg fences render live. */
  source?: string;
  variant?: "chat" | "doc";
  streaming?: boolean;
  className?: string;
}

export const Markdown = memo(function Markdown({ text, source, variant = "chat", streaming = false, className }: MarkdownProps) {
  const dark = useTheme((s) => s.dark);
  const seq = useStore((s) => source?.startsWith("m:") ? s.snap?.state.messages.find((m) => m.id === source.slice(2))?.seq : source?.startsWith("o:") ? s.snap?.state.table.options.find((o) => o.id === source.slice(2))?.seq : undefined);
  const plugins = useMemo(() => {
    const Live = makeLiveRenderer(source, text);
    return { code, mermaid: dark ? mermaidDark : mermaidLight, renderers: [{ language: ["html", "htm", "svg"], component: Live }] };
  }, [source, text, dark]);
  const components = useMemo<Components>(
    () => ({
      a: Link,
      img: Embed,
      ...(variant === "chat"
        ? { h1: shifted("h2"), h2: shifted("h3"), h3: shifted("h4"), h4: shifted("h4") }
        : { h1: plain("h1"), h2: plain("h2"), h3: plain("h3"), h4: plain("h4") }),
    }),
    [variant],
  );
  return (
    <FileSource.Provider value={seq}>
    <Streamdown
      className={cn(variant === "chat" ? "prose-chat" : "prose-chat prose-doc", "min-w-0", className)}
      mode={streaming ? "streaming" : "static"}
      isAnimating={streaming}
      caret={streaming ? "block" : undefined}
      plugins={plugins}
      components={components}
      remarkPlugins={[...defaultRemark, remarkAgora]}
      parseMarkdownIntoBlocksFn={blocks}
      translations={translations}
      linkSafety={{ enabled: false }}
      lineNumbers={false}
      codeBlockMaxHeight={variant === "doc" ? 640 : 460}
      tableMaxHeight={variant === "doc" ? 800 : 420}
      shikiTheme={["vitesse-light", "vitesse-dark"]}
      controls={{ table: { copy: true, download: false, fullscreen: true }, code: { copy: true, download: false }, mermaid: { copy: true, download: false, fullscreen: true, panZoom: true }, image: false }}
    >
      {text}
    </Streamdown>
    </FileSource.Provider>
  );
});
