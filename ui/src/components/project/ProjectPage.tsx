import { FolderIcon, PlusIcon, Settings2Icon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorNote, Loading } from "@/components/common/states";
import { Tip } from "@/components/room/bits";
import { NavButton } from "@/components/room/RoomHeader";
import { Button } from "@/components/ui/button";
import { api, Unauthorized } from "@/lib/api";
import { ago, baseName, shortPath } from "@/lib/format";
import { errText } from "@/lib/load";
import { type ProjectTab, useStore } from "@/lib/store";
import type { ProjectView, RoomSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Block } from "./Block";
import { Library, Threads, useOverview } from "./OverviewSections";

/**
 * A project: the folder Work rooms work in, with a name, a goal and instructions that outlive one room. Its page is
 * its overview — the rooms and threads working in it beside its library; what it holds is set in its settings
 * (the gear), where anyone in it can write, and every write says who made it.
 */

/** A line that says what is not there yet, and where to set it. */
function Placeholder({ children, onClick }: { children: string; onClick?: () => void }) {
  return onClick ? (
    <button type="button" onClick={onClick} className="text-left text-small text-faint transition hover:text-muted-foreground">
      {children}
    </button>
  ) : (
    <p className="text-small text-faint">{children}</p>
  );
}

function Rooms({ rooms, onNew }: { rooms: RoomSummary[]; onNew: () => void }) {
  const go = useStore((s) => s.go);
  return (
    <Block title="Rooms" aside={rooms.length ? `${rooms.length}` : undefined}>
      {rooms.length ? (
        <ul className="flex flex-col divide-y divide-border/60 rounded-xl border border-border/70">
          {rooms.map((room) => (
            <li key={room.id}>
              <button
                type="button"
                onClick={() => go({ kind: "room", id: room.id })}
                className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition hover:bg-foreground/[0.03]"
              >
                <span className={cn("size-1.5 shrink-0 rounded-full", room.running ? "animate-breathe bg-foreground/60" : "bg-transparent")} />
                <span className="min-w-0 flex-1 truncate text-ui">{room.name}</span>
                {room.branch ? <span className="hidden truncate font-mono text-meta text-faint sm:inline">{room.branch}</span> : null}
                <span className="shrink-0 text-meta text-faint">{ago(room.updatedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Placeholder onClick={onNew}>No Work room here yet — start one</Placeholder>
      )}
    </Block>
  );
}

export function ProjectPage({ hash }: { hash: string }) {
  const go = useStore((s) => s.go);
  const rooms = useStore((s) => s.rooms);
  const openDialog = useStore((s) => s.openDialog);
  const settingsOpen = useStore((s) => s.dialog?.kind === "project");
  const [project, setProject] = useState<ProjectView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { overview, error: overviewError } = useOverview(hash);

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
    setProject(null);
    void load();
  }, [load]);
  // What the settings wrote shows here once they close.
  const wasOpen = useRef(settingsOpen);
  useEffect(() => {
    if (wasOpen.current && !settingsOpen) void load();
    wasOpen.current = settingsOpen;
  }, [settingsOpen, load]);

  const title = project ? project.name || baseName(project.key) : "Project";
  useEffect(() => {
    document.title = `${title} · Agoryx`;
  }, [title]);

  const settings = (tab?: ProjectTab) => openDialog({ kind: "project", hash, ...(tab ? { tab } : {}) });
  const newRoom = () => project && go({ kind: "new", dir: project.key });
  // Rooms, not threads: a thread is on the board, under the room it came from.
  const members = rooms.filter((room) => room.projectHash === hash && !room.parent);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/70 px-3 sm:px-5">
        <NavButton />
        <FolderIcon className="size-4 shrink-0 text-faint" />
        <h1 className="min-w-0 shrink truncate font-display text-lead font-semibold">{title}</h1>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Tip tip="Project settings">
            <Button variant="ghost" size="icon" className="size-8" aria-label="Project settings" disabled={!project} onClick={() => settings()}>
              <Settings2Icon className="size-4" />
            </Button>
          </Tip>
          <Button className="h-8 gap-1.5" disabled={!project} onClick={newRoom}>
            <PlusIcon className="size-4" /> <span className="hidden sm:inline">New room here</span>
            <span className="sm:hidden">Room</span>
          </Button>
        </div>
      </header>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1100px] flex-col gap-8 px-4 py-6 sm:px-6">
          {error ? (
            <ErrorNote>{error}</ErrorNote>
          ) : !project ? (
            <Loading lines={4} />
          ) : (
            <>
              <section className="flex flex-col gap-2">
                {project.goal ? (
                  <p className="max-w-[72ch] text-body leading-relaxed whitespace-pre-wrap">{project.goal}</p>
                ) : (
                  <Placeholder onClick={() => settings("general")}>No goal written — what is the work here for?</Placeholder>
                )}
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-faint">
                  <span className="font-mono" title={project.key}>
                    {shortPath(project.key)}
                  </span>
                  <button type="button" className="transition hover:text-muted-foreground" onClick={() => settings("context")}>
                    {project.context.length ? `+ ${project.context.length} context ${project.context.length === 1 ? "folder" : "folders"}` : "+ context folder"}
                  </button>
                  <button type="button" className="transition hover:text-muted-foreground" onClick={() => settings("memory")}>
                    {project.memory.length ? `${project.memory.length} in memory` : "nothing in memory"}
                  </button>
                  {project.instructions ? null : (
                    <button type="button" className="transition hover:text-muted-foreground" onClick={() => settings("general")}>
                      no instructions
                    </button>
                  )}
                </p>
              </section>
              <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
                <div className="flex min-w-0 flex-col gap-8">
                  <Rooms rooms={members} onNew={newRoom} />
                  {overview ? <Threads threads={overview.threads} /> : overviewError ? <ErrorNote>{overviewError}</ErrorNote> : <Loading lines={2} />}
                </div>
                <div className="flex min-w-0 flex-col gap-8">
                  {overview ? <Library entries={overview.library} rawBase={overview.rawBase} /> : overviewError ? null : <Loading lines={3} />}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
