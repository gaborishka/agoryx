import { FolderIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ErrorNote, Hint, Loading } from "@/components/common/states";
import { NavButton } from "@/components/room/RoomHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError, Unauthorized } from "@/lib/api";
import { ago, baseName } from "@/lib/format";
import { errText } from "@/lib/load";
import { useStore } from "@/lib/store";
import type { ProjectEvent, ProjectView, RoomSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { MemorySection } from "./MemorySection";

/**
 * A project: the folder Work rooms work in, with a name, a goal and instructions that outlive one room. The agents
 * of its Work rooms get the goal and instructions with every fresh session. Anyone in it can write them — the human
 * here, agents with `agoryx project set` — and every write says who made it.
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
  }
};

const who = (event: ProjectEvent) => (event.from ? `${event.from.label} in “${event.from.roomName}”` : event.by);

export function Block({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <header className="flex items-baseline gap-3">
        <h2 className="font-display text-lead font-semibold">{title}</h2>
        {aside ? <span className="text-meta text-faint">{aside}</span> : null}
      </header>
      {children}
    </section>
  );
}

export function ProjectPage({ hash }: { hash: string }) {
  const go = useStore((s) => s.go);
  const rooms = useStore((s) => s.rooms);
  const loadRooms = useStore((s) => s.loadRooms);
  const [project, setProject] = useState<ProjectView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Fields>({ name: "", goal: "", instructions: "" });
  const [busy, setBusy] = useState(false);
  /** Someone else wrote since this page loaded it: their version, until the human picks. */
  const [theirs, setTheirs] = useState<ProjectView | null>(null);

  const load = useCallback(async () => {
    try {
      const got = await api<{ project: ProjectView }>("GET", `/api/projects/${hash}`);
      setProject(got.project);
      setDraft(fieldsOf(got.project));
      setTheirs(null);
      setError(null);
    } catch (err) {
      if (!(err instanceof Unauthorized)) setError(errText(err));
    }
  }, [hash]);
  useEffect(() => {
    setProject(null);
    void load();
  }, [load]);

  const title = project ? project.name || baseName(project.key) : "Project";
  useEffect(() => {
    document.title = `${title} · Agoryx`;
  }, [title]);

  const saved = project ? fieldsOf(project) : null;
  const changed = saved ? FIELDS.filter(({ id }) => draft[id].trim() !== saved[id].trim()).map(({ id }) => id) : [];
  const save = async () => {
    if (!project || !changed.length || busy) return;
    setBusy(true);
    try {
      // Sent with the version this page holds: if anyone wrote since, nothing is overwritten.
      const body: Record<string, unknown> = { seq: (theirs ?? project).fieldsSeq };
      for (const id of changed) body[id] = draft[id];
      const got = await api<{ project: ProjectView }>("PATCH", `/api/projects/${hash}`, body);
      setProject(got.project);
      setDraft(fieldsOf(got.project));
      setTheirs(null);
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

  const members = rooms.filter((room) => room.projectHash === hash);
  const history = project ? [...project.events].reverse().slice(0, 8) : [];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/70 px-3 sm:px-5">
        <NavButton />
        <FolderIcon className="size-4 text-faint" />
        <h1 className="max-w-[50%] shrink-0 truncate font-display text-lead font-semibold">{title}</h1>
        {project ? (
          <span className="hidden min-w-0 truncate font-mono text-meta text-faint sm:inline" title={project.key}>
            {project.key}
          </span>
        ) : null}
      </header>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[760px] flex-col gap-10 px-4 py-8 sm:px-6">
          {error ? (
            <ErrorNote>{error}</ErrorNote>
          ) : !project ? (
            <Loading lines={4} />
          ) : (
            <>
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
                      <Input
                        id={`project-${id}`}
                        value={draft[id]}
                        placeholder={baseName(project.key)}
                        onChange={(event) => setDraft({ ...draft, [id]: event.target.value })}
                      />
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
                  {theirs ? (
                    <span className="text-small text-amber-ink">Someone wrote here since you opened it. Saving now replaces what they wrote.</span>
                  ) : null}
                  <div className="ml-auto flex gap-2">
                    {theirs ? (
                      <Button type="button" variant="ghost" onClick={() => void load()}>
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

              <MemorySection project={project} onChange={setProject} />

              <Block title="Rooms" aside={`${members.length}`}>
                {members.length ? (
                  <ul className="flex flex-col divide-y divide-border/60 rounded-xl border border-border/70">
                    {members.map((room: RoomSummary) => (
                      <li key={room.id}>
                        <button
                          type="button"
                          onClick={() => go({ kind: "room", id: room.id })}
                          className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition hover:bg-foreground/[0.03]"
                        >
                          <span className={cn("size-1.5 shrink-0 rounded-full", room.running ? "animate-breathe bg-foreground/60" : "bg-transparent")} />
                          <span className="min-w-0 flex-1 truncate text-ui">{room.name}</span>
                          {room.branch ? <span className="truncate font-mono text-meta text-faint">{room.branch}</span> : null}
                          <span className="shrink-0 text-meta text-faint">{ago(room.updatedAt)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Hint>No Work room works in this folder yet.</Hint>
                )}
              </Block>

              {history.length ? (
                <Block title="Changes">
                  <ul className="flex flex-col gap-1.5 text-small text-muted-foreground">
                    {history.map((event) => (
                      <li key={event.seq} className="flex gap-2">
                        <span className="shrink-0 text-faint">{ago(event.ts)}</span>
                        <span className="min-w-0">
                          <span className="text-foreground">{who(event)}</span> {changeText(event)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Block>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
