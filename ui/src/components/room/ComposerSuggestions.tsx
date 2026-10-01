import { AtSignIcon, FileIcon, TerminalIcon, XIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { choiceKey, type ComposerChoice } from "@/lib/composer-context";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

export function ComposerSuggestions({ choices, active, onPick, onActive, loading, error }: {
  choices: ComposerChoice[]; active: number; onPick: (choice: ComposerChoice) => void; onActive: (index: number) => void; loading: boolean; error?: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [active]);
  let previous = "";
  return (
    <div className="absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-xl border border-border bg-popover shadow-lift">
      <div id="composer-suggestions" ref={list} role="listbox" aria-label="Participants, files and commands" className="scroll-thin max-h-[min(20rem,45vh)] overflow-y-auto p-1">
        {choices.map((choice, index) => {
          const heading = choice.kind !== previous ? { participant: "Participants", file: "Workspace files", command: "Room commands" }[choice.kind] : null;
          previous = choice.kind;
          const Icon = choice.kind === "file" ? FileIcon : choice.kind === "command" ? TerminalIcon : AtSignIcon;
          return (
            <div key={choiceKey(choice)}>
              {heading ? <div className="px-2 py-1.5 text-meta text-faint">{heading}</div> : null}
              <button type="button" id={`composer-choice-${index}`} role="option" aria-selected={active === index}
                onPointerDown={(e) => e.preventDefault()} onPointerMove={() => onActive(index)} onClick={() => onPick(choice)}
                className={cn("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-small", active === index && "bg-accent")}>
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1"><span className="block truncate font-medium">{choice.label}</span><span className="block truncate text-meta text-muted-foreground">{choice.detail}</span></span>
              </button>
            </div>
          );
        })}
        {loading ? <div role="status" className="px-3 py-2 text-meta text-faint">Loading workspace files…</div> : null}
        {error ? <div role="status" className="px-3 py-2 text-meta text-destructive">Files: {error}</div> : null}
        {!choices.length && !loading && !error ? <div className="px-3 py-3 text-small text-muted-foreground">No matches</div> : null}
      </div>
      <div className="border-t border-border px-3 py-1.5 text-meta text-faint">↑ ↓ choose · Enter / Tab insert · Esc close</div>
    </div>
  );
}

export function ContextFileList({ paths, onRemove }: { paths: string[]; onRemove: (path: string) => void }) {
  const openFile = useStore((s) => s.openFile);
  if (!paths.length) return null;
  return <div className="flex flex-wrap gap-1.5 px-3 pt-3">{paths.map((path) => (
    <div key={path} className="inline-flex max-w-full items-center gap-1 rounded-lg border border-border bg-muted/50 py-1 pr-1 pl-2 text-meta">
      <button type="button" onClick={() => openFile(path)} title={path} className="flex min-w-0 items-center gap-1.5 hover:text-primary"><FileIcon className="size-3.5 shrink-0" /><span className="truncate font-mono">{path}</span></button>
      <button type="button" onClick={() => onRemove(path)} aria-label={`Remove file ${path}`} className="grid size-5 shrink-0 place-items-center rounded hover:bg-accent"><XIcon className="size-3" /></button>
    </div>
  ))}</div>;
}
