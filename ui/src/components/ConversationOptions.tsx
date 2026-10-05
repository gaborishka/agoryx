import {
  CheckIcon,
  ChevronDownIcon,
  FolderIcon,
  GitBranchIcon,
  PlusIcon,
  SearchIcon,
} from "lucide-react";
import { useEffect, useState, type ComponentProps } from "react";
import { FolderBar } from "@/components/FolderPicker";
import { NewProjectDialog } from "@/components/project/NewProjectDialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { api } from "@/lib/api";
import { baseName } from "@/lib/format";
import type { ProjectView } from "@/lib/types";
import { WORK_MODES, type WorkMode } from "@/lib/workflow";
import { cn } from "@/lib/utils";

const chip =
  "inline-flex h-11 sm:h-8 max-w-full items-center gap-1.5 rounded-full border border-border/80 px-2.5 text-small text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-50 data-[state=open]:bg-accent";
const PURPOSE: Record<WorkMode, string> = {
  chat: "Explore an idea or ask a question together.",
  work: "Build and edit files in a working folder.",
  council: "Get independent perspectives, then a shared answer.",
  verification: "Create, check, repair — with evidence.",
  tournament: "Compare prototypes before choosing what to build.",
  debate: "Test opposing positions with an independent judge.",
};
const MODES: WorkMode[] = [
  "chat",
  "work",
  "council",
  "verification",
  "tournament",
  "debate",
];

/** The method belongs to the conversation, never to the navigation or project. */
export function ModePicker({
  mode,
  onSelect,
  disabled = false,
}: {
  mode: WorkMode;
  onSelect: (mode: WorkMode) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const Icon = WORK_MODES[mode].icon;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        disabled={disabled}
        className={chip}
        aria-label={`Conversation mode: ${WORK_MODES[mode].title}`}
      >
        <Icon className="size-3.5 shrink-0" />
        <span>{WORK_MODES[mode].title}</span>
        <ChevronDownIcon className="size-3 opacity-60" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="scroll-thin max-h-[var(--radix-popover-content-available-height)] w-[min(390px,calc(100vw-32px))] overflow-y-auto rounded-2xl p-2"
      >
        <p className="px-3 pb-2 pt-2 text-meta font-medium text-faint">
          How should the agents help?
        </p>
        <div role="group" aria-label="Conversation modes">
          {MODES.map((key) => {
            const item = WORK_MODES[key],
              Mark = item.icon;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={mode === key}
                onClick={() => {
                  setOpen(false);
                  onSelect(key);
                }}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                  mode === key && "bg-accent",
                )}
              >
                <Mark className="size-[18px] shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block text-small font-medium">
                    {item.title}
                  </span>
                  <span className="mt-0.5 block text-meta leading-snug text-muted-foreground">
                    {PURPOSE[key]}
                  </span>
                </span>
                {mode === key ? (
                  <CheckIcon className="size-4 shrink-0" />
                ) : null}
              </button>
            );
          })}
        </div>
        <p className="px-3 pb-2 pt-3 text-meta leading-relaxed text-faint">
          Keep one conversation. Choose a different approach whenever you need
          it.
        </p>
      </PopoverContent>
    </Popover>
  );
}

/** Project membership does not change execution mode or move any files. */
export function ProjectPicker({
  value,
  name,
  onSelect,
  disabled = false,
  workspace,
}: {
  value: string | null;
  name?: string;
  onSelect: (key: string | null) => void;
  disabled?: boolean;
  /** Creation only: the working location lives inside the same context picker. */
  workspace?: ComponentProps<typeof FolderBar>;
}) {
  const [open, setOpen] = useState(false),
    [creating, setCreating] = useState(false);
  const [projects, setProjects] = useState<ProjectView[]>([]),
    [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null),
    [loading, setLoading] = useState(false),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    if (!open && !value) return;
    setLoading(true);
    setError(null);
    void api<{ projects: ProjectView[] }>("GET", "/api/projects")
      .then(({ projects }) => {
        if (alive) setProjects(projects);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, value, retry]);
  const select = (key: string | null) => {
    setOpen(false);
    setQuery("");
    onSelect(key);
  };
  const label = value
    ? name || projects.find((p) => p.key === value)?.name || baseName(value)
    : workspace
      ? workspace.folder
        ? baseName(workspace.folder)
        : "New folder"
      : "No project";
  const matches = projects.filter((p) =>
    `${p.name ?? ""} ${p.key}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          type="button"
          disabled={disabled}
          className={chip}
          aria-label={`${workspace ? "Work context" : "Project"}: ${label}`}
          title={
            workspace
              ? (workspace.folder ??
                "A new working folder will be created for this conversation")
              : (value ?? "Keep this conversation outside a project")
          }
        >
          {workspace?.worktree ? (
            <GitBranchIcon className="size-3.5 shrink-0" />
          ) : (
            <FolderIcon className="size-3.5 shrink-0" />
          )}
          <span className="max-w-40 truncate">{label}</span>
          <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="scroll-thin max-h-[var(--radix-popover-content-available-height)] w-[min(360px,calc(100vw-32px))] overflow-y-auto rounded-2xl p-2"
        >
          {workspace ? (
            <p className="px-3 pb-2 pt-2 text-small font-medium">
              Where should we work?
            </p>
          ) : null}
          <div className="m-1 mb-2 flex items-center gap-2 rounded-lg border border-border px-2.5">
            <SearchIcon className="size-3.5 text-faint" />
            <input
              aria-label="Find a project"
              placeholder="Find a project…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-9 min-w-0 flex-1 bg-transparent text-small outline-none"
            />
          </div>
          <button
            type="button"
            onClick={() => select(null)}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-small hover:bg-accent"
          >
            <FolderIcon className="size-4 text-faint" />
            <span className="flex-1">
              {workspace ? "Standalone conversation" : "No project"}
              {workspace ? (
                <span className="mt-0.5 block text-meta text-faint">
                  Keep files with this conversation.
                </span>
              ) : null}
            </span>
            {!value ? <CheckIcon className="size-4" /> : null}
          </button>
          <div
            className="scroll-thin max-h-60 overflow-y-auto"
            aria-label="Projects"
          >
            {matches.map((p) => (
              <button
                key={p.hash}
                type="button"
                onClick={() => select(p.key)}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-accent"
              >
                <FolderIcon className="size-4 shrink-0 text-faint" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-small">
                    {p.name || baseName(p.key)}
                  </span>
                  <span className="block truncate text-meta text-faint">
                    {p.key}
                  </span>
                </span>
                {value === p.key ? (
                  <CheckIcon className="size-4 shrink-0" />
                ) : null}
              </button>
            ))}
          </div>
          {error ? (
            <button
              type="button"
              onClick={() => setRetry((n) => n + 1)}
              className="w-full p-3 text-left text-meta text-destructive"
            >
              Couldn’t load projects. Retry
            </button>
          ) : loading ? (
            <p className="px-3 py-2 text-meta text-faint">Loading projects…</p>
          ) : !matches.length ? (
            <p className="px-3 py-2 text-meta text-faint">
              {query
                ? "No matching projects."
                : "Create a project to bring related conversations together."}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setCreating(true);
            }}
            className="mt-2 flex w-full items-center gap-2 border-t border-border px-3 pb-2 pt-3 text-small hover:bg-accent"
          >
            <PlusIcon className="size-4" />
            New project
          </button>
          {workspace ? (
            <div className="mt-2 border-t border-border px-3 pb-2 pt-3">
              <p className="mb-2 text-meta font-medium text-muted-foreground">
                Working folder
              </p>
              <FolderBar {...workspace} />
              <p className="mt-2 text-meta leading-relaxed text-faint">
                {workspace.folder
                  ? "Agents will work in this folder."
                  : "Created automatically when you send your first message."}
              </p>
            </div>
          ) : null}
        </PopoverContent>
      </Popover>
      <NewProjectDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(p) => {
          setProjects((all) => [...all.filter((x) => x.hash !== p.hash), p]);
          select(p.key);
        }}
      />
    </>
  );
}
