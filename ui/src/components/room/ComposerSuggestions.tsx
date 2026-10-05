import { AtSignIcon, FileIcon, SparklesIcon, TerminalIcon, XIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { choiceKey, type ComposerChoice } from "@/lib/composer-context";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

export function ComposerSuggestions({ choices, active, onPick, onActive, loading, error, filters, filter, onFilter, onBack, title, loadingLabel }: {
  choices: ComposerChoice[]; active: number; onPick: (choice: ComposerChoice) => void; onActive: (index: number) => void; loading: boolean; error?: string;
  filters?: { id: string; label: string }[]; filter?: string; onFilter?: (id: string) => void; onBack?: () => void; title?: string; loadingLabel?: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [active]);
  let previous = "";
  return (
    <div className="absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-xl border border-border bg-popover shadow-lift">
      {filters || title ? <div className="flex flex-wrap items-center gap-1 border-b border-border p-2" onPointerDown={e => e.preventDefault()}>
        {onBack ? <button type="button" onClick={onBack} className="rounded px-2 py-1 text-small text-muted-foreground hover:bg-accent">← Back</button> : null}
        {title ? <span className="min-w-0 break-words px-2 text-small font-medium">{title}</span> : filters?.map(f => <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => onFilter?.(f.id)} className={cn("rounded-md px-2.5 py-1.5 text-small hover:bg-accent", filter === f.id && "bg-accent font-medium")}>{f.label}</button>)}
      </div> : null}
      <div id="composer-suggestions" ref={list} role="listbox" aria-label="Participants, files, commands and skills" className="scroll-thin max-h-[min(20rem,45vh)] overflow-y-auto p-1">
        {choices.map((choice, index) => {
          const group = choice.group ?? { participant: "Participants", file: "Workspace files", command: "Room commands", skill: "Skills", target: "Who will run it?" }[choice.kind];
          const heading = group !== previous ? group : null;
          previous = group;
          const Icon = choice.kind === "file" ? FileIcon : choice.kind === "command" ? TerminalIcon : choice.kind === "skill" ? SparklesIcon : AtSignIcon;
          return (
            <div key={choiceKey(choice)}>
              {heading ? <div className="px-2 py-1.5 text-meta text-faint">{heading}</div> : null}
              <button type="button" id={`composer-choice-${index}`} role="option" aria-selected={active === index}
                onPointerDown={(e) => e.preventDefault()} onPointerMove={() => onActive(index)} onClick={() => onPick(choice)}
                className={cn("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-small", active === index && "bg-accent")}>
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1"><span className="block break-words font-medium">{choice.label}</span><span title={choice.skill ? `${choice.detail} · ${choice.skill.path}` : choice.detail} className="line-clamp-2 break-words text-meta text-muted-foreground">{choice.detail}</span></span>
                {choice.owner ? <span className="max-w-[30%] shrink-0 break-words text-right text-meta text-muted-foreground">{choice.owner}</span> : null}
              </button>
            </div>
          );
        })}
        {loading ? <div role="status" className="px-3 py-2 text-meta text-faint">{loadingLabel ?? "Loading workspace files…"}</div> : null}
        {error ? <div role="status" className="px-3 py-2 text-meta text-destructive">{error}</div> : null}
        {!choices.length && !loading && !error ? <div className="px-3 py-3 text-small text-muted-foreground">No matches</div> : null}
      </div>
      <div className="border-t border-border px-3 py-1.5 text-meta text-faint">↑ ↓ choose · Enter / Tab select · Esc close · selecting never runs</div>
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
