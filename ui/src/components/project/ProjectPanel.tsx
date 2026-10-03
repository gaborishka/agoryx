import { FoldersIcon, Settings2Icon } from "lucide-react";
import { useState } from "react";
import { EmptyState, ErrorNote, Loading } from "@/components/common/states";
import { Tip } from "@/components/room/bits";
import { Button } from "@/components/ui/button";
import { baseName } from "@/lib/format";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Library, Threads, Usage, useOverview } from "./OverviewSections";

/**
 * The room's project beside the conversation: its threads, its library and what its rooms' turns took — the project
 * page's overview, narrow. Its settings are behind the gear; the whole page is a click on its name.
 */

const SECTIONS = [
  { id: "threads", label: "Threads" },
  { id: "library", label: "Library" },
  { id: "usage", label: "Usage" },
] as const;
type Section = (typeof SECTIONS)[number]["id"];

function Body({ hash }: { hash: string }) {
  const [section, setSection] = useState<Section>("threads");
  const { overview, error, reload } = useOverview(hash);
  return (
    <>
      <div className="flex gap-1 px-4 pt-3" role="tablist" aria-label="Project">
        {SECTIONS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={section === id}
            onClick={() => setSection(id)}
            className={cn("h-7 rounded-md px-2.5 text-small transition", section === id ? "bg-foreground/[0.07] text-foreground" : "text-muted-foreground hover:text-foreground")}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {error && !overview ? (
          <ErrorNote>{error}</ErrorNote>
        ) : !overview ? (
          <Loading lines={3} />
        ) : section === "threads" ? (
          <Threads threads={overview.threads} />
        ) : section === "library" ? (
          <Library entries={overview.library} rawBase={overview.rawBase} hash={hash} onChange={reload} />
        ) : (
          <Usage usage={overview.usage} />
        )}
      </div>
    </>
  );
}

export function ProjectPanel() {
  const go = useStore((s) => s.go);
  const openDialog = useStore((s) => s.openDialog);
  const chat = useStore((s) => s.snap?.state.mode === "chat");
  const summary = useStore((s) => s.rooms.find((room) => room.id === s.snap?.state.id));
  const hash = summary?.projectHash;
  if (chat || !hash) {
    return <EmptyState icon={FoldersIcon} title="No project" text="A Work room is in its folder’s project; a Chat room is in none." />;
  }
  const name = summary.projectName || baseName(summary.workspace);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border/70 px-4 py-2.5">
        <FoldersIcon className="size-4 shrink-0 text-faint" />
        <Tip tip="Open the project">
          <button type="button" className="min-w-0 truncate text-ui font-medium hover:underline" onClick={() => go({ kind: "project", hash })}>
            {name}
          </button>
        </Tip>
        <Tip tip="Project settings">
          <Button variant="ghost" size="icon" className="ml-auto size-7" aria-label="Project settings" onClick={() => openDialog({ kind: "project", hash })}>
            <Settings2Icon className="size-3.5" />
          </Button>
        </Tip>
      </div>
      <Body key={hash} hash={hash} />
    </div>
  );
}
