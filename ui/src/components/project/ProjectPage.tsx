import { BookOpenTextIcon, BrainIcon, FolderIcon, FolderPlusIcon, type LucideIcon, PlusIcon, Settings2Icon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorNote, Loading } from "@/components/common/states";
import { PageBar } from "@/components/common/PageBar";
import { Facepile, Tip } from "@/components/room/bits";
import { Button } from "@/components/ui/button";
import { api, Unauthorized } from "@/lib/api";
import { ago, baseName, plural, roomPreview, shortPath } from "@/lib/format";
import { errText } from "@/lib/load";
import { type ProjectTab, useStore } from "@/lib/store";
import type { ProjectView, RoomAgent, RoomSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Block, listBox, listRow } from "./Block";
import { Library, Threads, useOverview } from "./OverviewSections";

/**
 * A project: the folder Work rooms work in, with a name, a goal and instructions that outlive one room. Its page is
 * its overview — the rooms and threads working in it beside its library; what it holds is set in its settings
 * (the gear), where anyone in it can write, and every write says who made it.
 */

/** A room's last line, as the sidebar shows it: who said it and what. */
const lastLine = (room: RoomSummary) => roomPreview(room.lastMessage);

function Rooms({ rooms, onNew }: { rooms: RoomSummary[]; onNew: () => void }) {
  const go = useStore((s) => s.go);
  return (
    <Block title="Rooms" aside={rooms.length ? `${rooms.length}` : undefined}>
      {rooms.length ? (
        <ul className={listBox}>
          {rooms.map((room) => {
            const working = new Set((room.working ?? []).map((turn) => turn.agent));
            return (
              <li key={room.id}>
                <button type="button" onClick={() => go({ kind: "room", id: room.id })} className={listRow}>
                  <Facepile agents={(room.agents ?? []) as RoomAgent[]} working={working} size={24} max={2} ring="ring-card" className="w-[42px]" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 truncate text-ui font-medium">{room.name}</span>
                      {room.running ? <span className="size-1.5 shrink-0 animate-breathe rounded-full bg-foreground" aria-label="Working" /> : null}
                    </span>
                    <span className="truncate text-small text-muted-foreground">{lastLine(room)}</span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-0.5 self-start pt-0.5">
                    <span className="text-meta text-faint">{ago(room.updatedAt)}</span>
                    {room.unread ? <span className="tabular rounded-full bg-foreground px-1.5 text-micro font-semibold text-background">{room.unread}</span> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <button type="button" onClick={onNew} className="flex items-center gap-3 rounded-xl border border-dashed border-border px-4 py-4 text-left text-small text-muted-foreground transition hover:border-foreground/30 hover:text-foreground">
          <PlusIcon className="size-4" /> No Work room here yet. Start one.
        </button>
      )}
    </Block>
  );
}

/** What the project holds, at a glance: each a way into the settings where it is written. Missing ones say so. */
function Fact({ icon: Icon, children, missing, onClick, title }: { icon: LucideIcon; children: string; missing?: boolean; onClick: () => void; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "inline-flex h-8 max-w-full items-center gap-1.5 rounded-lg px-2.5 text-small transition",
        missing ? "border border-dashed border-border text-faint hover:border-foreground/30 hover:text-foreground" : "border border-border bg-card text-muted-foreground hover:border-foreground/25 hover:text-foreground",
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{children}</span>
    </button>
  );
}

export function ProjectPage({ hash }: { hash: string }) {
  const go = useStore((s) => s.go);
  const rooms = useStore((s) => s.rooms);
  const openDialog = useStore((s) => s.openDialog);
  const settingsOpen = useStore((s) => s.dialog?.kind === "project");
  const [project, setProject] = useState<ProjectView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { overview, error: overviewError, reload } = useOverview(hash);

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
      <PageBar crumbs={[{ label: "Projects", onClick: () => go({ kind: "projects" }) }, { label: title }]}>
        <Tip tip="Project settings">
          <Button variant="ghost" size="icon" className="size-8" aria-label="Project settings" disabled={!project} onClick={() => settings()}>
            <Settings2Icon className="size-4" />
          </Button>
        </Tip>
        <Button size="sm" className="gap-1.5" disabled={!project} onClick={newRoom}>
          <PlusIcon className="size-4" /> <span className="hidden sm:inline">New room</span>
          <span className="sm:hidden">Room</span>
        </Button>
      </PageBar>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1080px] flex-col gap-10 px-5 pt-9 pb-16 sm:px-8">
          {error ? (
            <ErrorNote>{error}</ErrorNote>
          ) : !project ? (
            <Loading lines={4} />
          ) : (
            <>
              <section className="flex flex-col gap-5">
                <div className="flex items-start gap-4">
                  <span className="mt-0.5 grid size-12 shrink-0 place-items-center rounded-2xl bg-foreground font-display text-[22px] font-semibold text-background" aria-hidden>
                    {(title.match(/[\p{L}\p{N}]/u)?.[0] ?? "·").toUpperCase()}
                  </span>
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <h1 className="font-display text-display leading-tight font-semibold break-words">{title}</h1>
                    {project.goal ? (
                      <p className="max-w-[68ch] text-body leading-relaxed whitespace-pre-wrap text-muted-foreground">{project.goal}</p>
                    ) : (
                      <button type="button" onClick={() => settings("general")} className="text-left text-body text-faint transition hover:text-muted-foreground">
                        No goal yet. Write what the work here is for.
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Fact icon={FolderIcon} onClick={() => settings("context")} title={project.key}>
                    {shortPath(project.key)}
                  </Fact>
                  <Fact icon={FolderPlusIcon} missing={!project.context.length} onClick={() => settings("context")}>
                    {project.context.length ? plural(project.context.length, "context folder", "context folders") : "Add a context folder"}
                  </Fact>
                  <Fact icon={BrainIcon} missing={!project.memory.length} onClick={() => settings("memory")}>
                    {project.memory.length ? `${project.memory.length} in memory` : "Memory is empty"}
                  </Fact>
                  <Fact icon={BookOpenTextIcon} missing={!project.instructions} onClick={() => settings("general")}>
                    {project.instructions ? "Instructions" : "Write instructions"}
                  </Fact>
                </div>
              </section>
              <div className="grid gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
                <div className="flex min-w-0 flex-col gap-10">
                  <Rooms rooms={members} onNew={newRoom} />
                  {overview ? <Threads threads={overview.threads} /> : overviewError ? <ErrorNote>{overviewError}</ErrorNote> : <Loading lines={2} />}
                </div>
                <div className="flex min-w-0 flex-col gap-10">
                  {overview ? <Library entries={overview.library} rawBase={overview.rawBase} hash={hash} onChange={reload} /> : overviewError ? null : <Loading lines={3} />}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
