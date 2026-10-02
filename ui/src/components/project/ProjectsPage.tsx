import { FolderIcon, FoldersIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState, ErrorNote, Loading } from "@/components/common/states";
import { NavButton } from "@/components/room/RoomHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, Unauthorized } from "@/lib/api";
import { ago, baseName, shortPath } from "@/lib/format";
import { errText } from "@/lib/load";
import { useStore } from "@/lib/store";
import type { ProjectView, RoomSummary } from "@/lib/types";
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
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/70 px-3 sm:px-5">
        <NavButton />
        <h1 className="font-display text-lead font-semibold">Projects</h1>
        <Button className="ml-auto h-8 gap-1.5" onClick={() => setCreating(true)}>
          <PlusIcon className="size-4" /> New project
        </Button>
      </header>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1040px] flex-col gap-5 px-4 py-6 sm:px-6">
          {projects && projects.length ? (
            <div className="flex flex-wrap items-center gap-2">
              <label className="relative min-w-0 flex-1">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
                <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search projects" className="pl-9" aria-label="Search projects" />
              </label>
              <div className="flex rounded-lg border border-border/70 p-0.5" role="group" aria-label="Sort">
                {(["recent", "name"] as const).map((id) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={sort === id}
                    onClick={() => setSort(id)}
                    className={cn("h-7 rounded-md px-2.5 text-small", sort === id ? "bg-foreground/[0.07] text-foreground" : "text-muted-foreground hover:text-foreground")}
                  >
                    {id === "recent" ? "Recent activity" : "Name"}
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
              text="A project is a folder its Work rooms share: a name, a goal, instructions and memory every agent there starts with, and other folders they may work in too."
            >
              <Button onClick={() => setCreating(true)}>
                <PlusIcon className="size-4" /> New project
              </Button>
            </EmptyState>
          ) : !cards.length ? (
            <p className="text-small text-muted-foreground">No project matches “{query.trim()}”.</p>
          ) : (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {cards.map((card) => (
                <li key={card.project.hash}>
                  <button
                    type="button"
                    onClick={() => go({ kind: "project", hash: card.project.hash })}
                    className="flex h-full w-full flex-col gap-2 rounded-xl border border-border/70 bg-card px-4 py-3.5 text-left transition hover:border-foreground/25 hover:shadow-soft"
                  >
                    <span className="flex items-center gap-2">
                      <FolderIcon className="size-4 shrink-0 text-faint" />
                      <span className="min-w-0 flex-1 truncate font-medium text-ui">{card.title}</span>
                    </span>
                    <span className={cn("line-clamp-2 min-h-[2lh] text-small leading-snug", card.project.goal ? "text-muted-foreground" : "text-faint")}>
                      {card.project.goal || "No goal written"}
                    </span>
                    <span className="truncate font-mono text-meta text-faint" title={card.project.key}>
                      {shortPath(card.project.key)}
                      {card.project.context.length ? ` + ${card.project.context.length} context` : ""}
                    </span>
                    <span className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-faint">
                      <span>
                        {card.rooms.length - card.threads} {card.rooms.length - card.threads === 1 ? "room" : "rooms"}
                      </span>
                      {card.threads ? (
                        <span>
                          {card.threads} {card.threads === 1 ? "thread" : "threads"}
                          {card.working ? <span className="text-foreground"> · {card.working} working</span> : null}
                        </span>
                      ) : null}
                      {card.last ? <span className="ml-auto">{ago(card.last)}</span> : null}
                    </span>
                  </button>
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
