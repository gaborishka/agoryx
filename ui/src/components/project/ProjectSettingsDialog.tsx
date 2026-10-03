import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ErrorNote, Hint, Loading } from "@/components/common/states";
import { Shell } from "@/components/dialogs/Dialogs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError, Unauthorized } from "@/lib/api";
import { ago, baseName, shortPath } from "@/lib/format";
import { errText } from "@/lib/load";
import { type ProjectTab, PROJECT_TABS, useStore } from "@/lib/store";
import type { ProjectEvent, ProjectView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Block } from "./Block";
import { ContextSection } from "./ContextSection";
import { MemorySection } from "./MemorySection";
import { Usage, useOverview } from "./OverviewSections";

/**
 * A project's settings: what its Work rooms' agents start with (name, goal, instructions), the folders they may work
 * in, its memory, what its rooms' turns took, and who changed what. Anyone in it may write — the human here, agents
 * with `agoryx project …` — and every write says who made it.
 */

type Fields = { name: string; goal: string; instructions: string };
const FIELDS: Array<{ id: keyof Fields; label: string; hint: string; rows?: number; placeholder: string }> = [
  { id: "name", label: "Name", hint: "Shown in the room list instead of the folder's name.", placeholder: "" },
  { id: "goal", label: "Goal", hint: "What the work in this folder is for. Agents get it when a session starts.", rows: 3, placeholder: "Ship the first public release" },
  {
    id: "instructions",
    label: "Instructions",
    hint: "How to work here, beyond what the repository's own CLAUDE.md or AGENTS.md says. Keep it short: it goes into every fresh session.",
    rows: 6,
    placeholder: "Run npm test before you say a step is done.\nNo new dependencies without asking.",
  },
];

const TAB_LABEL: Record<ProjectTab, string> = { general: "General", context: "Context", memory: "Memory", usage: "Usage", changes: "Changes" };

const fieldsOf = (project: ProjectView): Fields => ({ name: project.name ?? "", goal: project.goal ?? "", instructions: project.instructions ?? "" });

const changeText = (event: ProjectEvent): string => {
  switch (event.type) {
    case "project.changed":
      return `${event.value === null ? "cleared" : "wrote"} the ${event.field}`;
    case "memory.noted":
      return `kept ${event.id} (${event.entry.kind})`;
    case "memory.revised":
      return `revised ${event.id}`;
    case "memory.removed":
      return `removed ${event.id}`;
    case "context.added":
      return `added the context folder ${event.path}`;
    case "context.removed":
      return `removed the context folder ${event.path}`;
  }
};

const who = (event: ProjectEvent) => (event.from ? `${event.from.label} in “${event.from.roomName}”` : event.by);

function General({ project, onSaved, reload }: { project: ProjectView; onSaved: (project: ProjectView) => void; reload: () => void }) {
  const loadRooms = useStore((s) => s.loadRooms);
  const [draft, setDraft] = useState<Fields>(() => fieldsOf(project));
  const [busy, setBusy] = useState(false);
  /** Someone else wrote since this dialog loaded it: their version, until the human picks. */
  const [theirs, setTheirs] = useState<ProjectView | null>(null);
  useEffect(() => {
    setDraft(fieldsOf(project));
    setTheirs(null);
  }, [project]);

  const saved = fieldsOf(project);
  const changed = FIELDS.filter(({ id }) => draft[id].trim() !== saved[id].trim()).map(({ id }) => id);
  const save = async () => {
    if (!changed.length || busy) return;
    setBusy(true);
    try {
      // Sent with the version this dialog holds: if anyone wrote since, nothing is overwritten.
      const body: Record<string, unknown> = { seq: (theirs ?? project).fieldsSeq };
      for (const id of changed) body[id] = draft[id];
      const got = await api<{ project: ProjectView }>("PATCH", `/api/projects/${project.hash}`, body);
      onSaved(got.project);
      // The room list shows the name.
      if (changed.includes("name")) void loadRooms();
      toast.success("Saved. Agents get it with their next fresh session.");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.body.project) setTheirs(err.body.project as ProjectView);
      else if (!(err instanceof Unauthorized)) toast.error(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          void save();
        }
      }}
    >
      {project.seq === 0 ? (
        <Hint>
          Nothing is written for this folder yet. Its Work rooms start as they always did until you (or an agent, with{" "}
          <code className="font-mono text-meta">agoryx project set</code>) write something here.
        </Hint>
      ) : null}
      {FIELDS.map(({ id, label, hint, rows, placeholder }) => (
        <div key={id} className="flex flex-col gap-1.5">
          <label htmlFor={`project-${id}`} className="text-ui font-medium">
            {label}
          </label>
          <p className="text-small leading-relaxed text-muted-foreground">{hint}</p>
          {rows ? (
            <Textarea
              id={`project-${id}`}
              rows={rows}
              value={draft[id]}
              placeholder={placeholder}
              onChange={(event) => setDraft({ ...draft, [id]: event.target.value })}
              className="resize-y text-small leading-relaxed"
            />
          ) : (
            <Input id={`project-${id}`} value={draft[id]} placeholder={baseName(project.key)} onChange={(event) => setDraft({ ...draft, [id]: event.target.value })} />
          )}
          {theirs && (theirs[id] ?? "") !== (project[id] ?? "") ? (
            <div className="rounded-lg bg-amber-soft px-3 py-2 text-small">
              <span className="font-medium">Changed since you opened it:</span>{" "}
              <span className="whitespace-pre-wrap text-muted-foreground">{theirs[id] || "(cleared)"}</span>
            </div>
          ) : null}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        {theirs ? <span className="text-small text-amber-ink">Someone wrote here since you opened it. Saving now replaces what they wrote.</span> : null}
        <div className="ml-auto flex gap-2">
          {theirs ? (
            <Button type="button" variant="ghost" onClick={reload}>
              Take theirs
            </Button>
          ) : changed.length ? (
            <Button type="button" variant="ghost" onClick={() => setDraft(fieldsOf(project))}>
              Cancel
            </Button>
          ) : null}
          <Button type="submit" disabled={!changed.length || busy}>
            {theirs ? "Save mine" : "Save"}
          </Button>
        </div>
      </div>
    </form>
  );
}

function ProjectUsage({ hash }: { hash: string }) {
  const { overview, error } = useOverview(hash);
  if (error && !overview) return <ErrorNote>{error}</ErrorNote>;
  if (!overview) return <Loading lines={3} />;
  return <Usage usage={overview.usage} />;
}

function Changes({ project }: { project: ProjectView }) {
  const history = [...project.events].reverse();
  return (
    <Block title="Changes" aside={history.length ? `${history.length}` : undefined}>
      {history.length ? (
        <ul className="flex flex-col gap-1.5 text-small text-muted-foreground">
          {history.map((event) => (
            <li key={event.seq} className="flex gap-2">
              <span className="w-14 shrink-0 text-faint">{ago(event.ts)}</span>
              <span className="min-w-0 break-words">
                <span className="text-foreground">{who(event)}</span> {changeText(event)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Hint>Nothing written yet.</Hint>
      )}
    </Block>
  );
}

export function ProjectSettingsDialog({ hash, tab: first = "general" }: { hash: string; tab?: ProjectTab }) {
  const [tab, setTab] = useState<ProjectTab>(first);
  const [project, setProject] = useState<ProjectView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const got = await api<{ project: ProjectView }>("GET", `/api/projects/${hash}`);
      setProject(got.project);
      setError(null);
    } catch (err) {
      if (!(err instanceof Unauthorized)) setError(errText(err));
    }
  }, [hash]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Shell title={project ? `${project.name || baseName(project.key)} settings` : "Project settings"} sub={project ? <span title={project.key}>{shortPath(project.key)}</span> : undefined}>
      <div className="flex w-fit max-w-full flex-wrap gap-0.5 rounded-lg bg-muted p-0.5" role="tablist" aria-label="Project settings">
        {PROJECT_TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn("h-7 rounded-md px-3 text-small transition", tab === id ? "bg-background font-medium text-foreground shadow-edge ring-1 ring-border/70" : "text-muted-foreground hover:text-foreground")}
          >
            {TAB_LABEL[id]}
          </button>
        ))}
      </div>
      {error && !project ? (
        <ErrorNote>{error}</ErrorNote>
      ) : !project ? (
        <Loading lines={4} />
      ) : tab === "general" ? (
        <General project={project} onSaved={setProject} reload={() => void load()} />
      ) : tab === "context" ? (
        <ContextSection project={project} onChange={setProject} />
      ) : tab === "memory" ? (
        <MemorySection project={project} onChange={setProject} />
      ) : tab === "usage" ? (
        <ProjectUsage hash={hash} />
      ) : (
        <Changes project={project} />
      )}
    </Shell>
  );
}
