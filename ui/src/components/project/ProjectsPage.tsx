import { FoldersIcon, GitBranchIcon, MessagesSquareIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState, ErrorNote, Loading } from "@/components/common/states";
import { PageBar, PageTitle } from "@/components/common/PageBar";
import { Facepile } from "@/components/room/bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, Unauthorized } from "@/lib/api";
import { ago, baseName, plural, shortPath } from "@/lib/format";
import { errText } from "@/lib/load";
import { useStore } from "@/lib/store";
import type { ProjectView, RoomAgent, RoomSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { NewProjectDialog } from "./NewProjectDialog";

/**
 * Every project: each folder someone wrote something for, and each folder a Work room works in. A card shows what the
 * folder's rooms show — how many, how many threads are working, when anything last happened. Nothing here is counted
 * by Agoryx beyond what the rooms say.
 */

type Sort = "recent" | "name";

interface Card {
  project: ProjectView;
  title: string;
  rooms: RoomSummary[];
  working: number;
  threads: number;
  last: string | null;
}

const cardOf = (project: ProjectView, rooms: RoomSummary[]): Card => {
  const own = rooms.filter((room) => room.projectHash === project.hash);
  const threads = own.filter((room) => room.parent);
  const lastRoom = own.reduce<string | null>((last, room) => (!last || room.updatedAt > last ? room.updatedAt : last), null);
  const lastWrite = project.updatedAt ?? null;
  return {
    project,
    title: project.name || baseName(project.key),
    rooms: own,
    threads: threads.length,
    working: threads.filter((room) => room.running).length,
    last: lastRoom && lastWrite ? (lastRoom > lastWrite ? lastRoom : lastWrite) : (lastRoom ?? lastWrite),
  };
};

/** The first letter of the name, set large: a project has no logo, and a folder icon on every card says nothing. */
function Monogram({ title }: { title: string }) {
  return (
    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-foreground font-display text-[18px] font-semibold text-background" aria-hidden>
      {(title.match(/[\p{L}\p{N}]/u)?.[0] ?? "·").toUpperCase()}
    </span>
  );
}

function ProjectCard({ card, onOpen }: { card: Card; onOpen: () => void }) {
  const rooms = card.rooms.length - card.threads;
  const agents = useMemo(() => {
    const seen = new Map<string, RoomAgent>();
    for (const room of card.rooms) for (const agent of room.agents ?? []) if (!seen.has(agent.id)) seen.set(agent.id, agent as RoomAgent);
    return [...seen.values()];
  }, [card.rooms]);
  const working = useMemo(() => new Set(card.rooms.flatMap((room) => (room.working ?? []).map((turn) => turn.agent))), [card.rooms]);
  const live = card.rooms.some((room) => room.running);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex h-full min-h-[184px] w-full flex-col gap-4 rounded-2xl border border-border bg-card p-5 text-left transition hover:-translate-y-px hover:border-foreground/20 hover:shadow-soft focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <span className="flex items-start gap-3">
        <Monogram title={card.title} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate font-display text-[16px] leading-snug font-semibold">{card.title}</span>
          <span className="truncate text-meta text-faint" title={card.project.key}>
            {shortPath(card.project.key)}
            {card.project.context.length ? ` + ${plural(card.project.context.length, "folder", "folders")}` : ""}
          </span>
        </span>
        {live ? (
          <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-foreground/[0.06] px-2 py-0.5 text-micro font-medium">
            <span className="size-1.5 animate-breathe rounded-full bg-foreground" /> Working
          </span>
        ) : null}
      </span>
      <span className={cn("line-clamp-2 text-small leading-relaxed", card.project.goal ? "text-muted-foreground" : "text-faint")}>
        {card.project.goal || "No goal yet. Open it to write what the work here is for."}
      </span>
      <span className="mt-auto flex items-center gap-3 border-t border-border/70 pt-3.5 text-meta text-muted-foreground">
        <Facepile agents={agents} working={working} size={20} ring="ring-card" />
        <span className="flex items-center gap-1">
          <MessagesSquareIcon className="size-3.5 text-faint" />
          {rooms}
        </span>
        {card.threads ? (
          <span className="flex items-center gap-1">
            <GitBranchIcon className="size-3.5 text-faint" />
            {card.threads}
          </span>
        ) : null}
        {card.last ? <span className="ml-auto text-faint">{ago(card.last)}</span> : null}
      </span>
    </button>
  );
}

export function ProjectsPage() {
  const go = useStore((s) => s.go);
  const rooms = useStore((s) => s.rooms);
  const [projects, setProjects] = useState<ProjectView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("recent");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const got = await api<{ projects: ProjectView[] }>("GET", "/api/projects");
      setProjects(got.projects);
      setError(null);
    } catch (err) {
      if (!(err instanceof Unauthorized)) setError(errText(err));
    }
  }, []);
  useEffect(() => {
    document.title = "Projects · Agoryx";
    void load();
  }, [load]);

  const cards = useMemo(() => {
    if (!projects) return [];
    const needle = query.trim().toLowerCase();
    const all = projects.map((project) => cardOf(project, rooms));
    const shown = needle
      ? all.filter(({ title, project }) => [title, project.goal ?? "", project.key].some((text) => text.toLowerCase().includes(needle)))
      : all;
    return shown.sort((a, b) => (sort === "name" ? a.title.localeCompare(b.title) : (b.last ?? "").localeCompare(a.last ?? "")));
  }, [projects, rooms, query, sort]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageBar crumbs={[{ label: "Projects" }]}>
        <Button size="sm" className="gap-1.5" onClick={() => setCreating(true)}>
          <PlusIcon className="size-4" /> New project
        </Button>
      </PageBar>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1080px] flex-col gap-7 px-5 pt-9 pb-16 sm:px-8">
          <PageTitle title="Projects" sub="Folders connected to your chats. Keep a shared goal, instructions and memory for each project." />
          {projects && projects.length ? (
            <div className="flex flex-wrap items-center gap-2">
              <label className="relative min-w-0 flex-1 sm:max-w-sm">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
                <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name, goal or folder" className="pl-9" aria-label="Search projects" />
              </label>
              <span className="ml-auto hidden text-small text-faint sm:inline">{plural(projects.length, "project", "projects")}</span>
              <div className="flex rounded-lg bg-muted p-0.5" role="group" aria-label="Sort">
                {(["recent", "name"] as const).map((id) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={sort === id}
                    onClick={() => setSort(id)}
                    className={cn(
                      "h-8 rounded-md px-3 text-small font-medium transition",
                      sort === id ? "bg-background text-foreground shadow-edge ring-1 ring-border/70" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {id === "recent" ? "Recent" : "Name"}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {error ? (
            <ErrorNote>{error}</ErrorNote>
          ) : !projects ? (
            <Loading lines={4} />
          ) : !projects.length ? (
            <EmptyState
              large
              icon={FoldersIcon}
              title="No projects yet"
              text="Connect chats to a folder and keep their goal, instructions, memory and reference folders together."
            >
              <Button onClick={() => setCreating(true)}>
                <PlusIcon className="size-4" /> New project
              </Button>
            </EmptyState>
          ) : !cards.length ? (
            <p className="text-small text-muted-foreground">No project matches “{query.trim()}”.</p>
          ) : (
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {cards.map((card) => (
                <li key={card.project.hash}>
                  <ProjectCard card={card} onOpen={() => go({ kind: "project", hash: card.project.hash })} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <NewProjectDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(project) => {
          void load();
          go({ kind: "project", hash: project.hash });
        }}
      />
    </div>
  );
}
