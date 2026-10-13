import { useEffect, useMemo, useState, type ReactNode } from "react";
import { HistoryIcon, LoaderCircleIcon, SlidersHorizontalIcon } from "lucide-react";
import { defaultUIValues, parseIntelligentUI, type IntelligentUI, type UIValue } from "@agora/intelligent-ui";
import { workTableView } from "@agora/work-table";
import type { TableComponent } from "@agora/types";
import type { RoomState } from "@/lib/types";
import { api, roomPath } from "@/lib/api";
import { useStore } from "@/lib/store";
import { safeInputSnapshot } from "@/lib/tool-session";
import { toolEmbedState, type ToolEmbedView } from "@/lib/tool-embed";
import { Button } from "@/components/ui/button";
import { IntelligentTool } from "@/components/table/IntelligentTool";
import { ToolNode } from "@/components/table/ToolNode";
import "@/components/table/intelligent-ui.css";

type Embed = { pinned: TableComponent; messageSeq: number };

/**
 * A native table tool shown in a message as it was when the message was posted. Exploring it stays on this device;
 * saving belongs to the current version only, reached with an explicit switch.
 */
export function ToolEmbed({ id, message }: { id: string; message: string }) {
  const room = useStore(s => s.snap?.state);
  const events = useStore(s => s.snap?.events);
  const ops = useStore(s => s.snap?.ops);
  const [embed, setEmbed] = useState<Embed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ToolEmbedView>("pinned");
  const roomId = room?.id;

  useEffect(() => {
    if (!roomId) return;
    let live = true;
    setEmbed(null); setError(null); setView("pinned");
    api<Embed>("GET", roomPath(roomId, `/tool-embed?message=${encodeURIComponent(message)}&component=${encodeURIComponent(id)}`))
      .then(data => { if (live) setEmbed(data); })
      .catch(err => { if (live) setError(err instanceof Error ? err.message : String(err)); });
    return () => { live = false; };
  }, [roomId, message, id]);

  // Today's item comes from the live store, so a revision or a saved scenario shows without refetching.
  const current = room?.table.components?.find(item => item.id === id) ?? null;
  const currentView = useMemo(() => room && current && !current.archived ? workTableView(room, events ?? [], ops ?? []).components.find(item => item.id === id) ?? null : null, [room, current, events, ops, id]);

  if (error) return <Frame id={id}><p role="alert" className="text-small text-amber-ink">This tool cannot be shown here. {error}</p></Frame>;
  if (!embed || !room) return <Frame id={id}><p className="flex items-center gap-2 text-small text-muted-foreground"><LoaderCircleIcon className="size-3.5 animate-spin" />Loading the tool…</p></Frame>;

  const pinnedSeq = embed.pinned.contentSeq ?? embed.pinned.seq;
  const state = toolEmbedState(pinnedSeq, current);
  const showCurrent = view === "current" && state.reachable && currentView ? currentView : null;
  return (
    <Frame id={id} title={showCurrent ? showCurrent.title : embed.pinned.title} badge={showCurrent ? "Current version" : "As of this message"}
      action={state.reachable && currentView ? <Button size="xs" variant="ghost" onClick={() => setView(showCurrent ? "pinned" : "current")}>{showCurrent ? <><HistoryIcon className="size-3.5" />Show as of this message</> : <><SlidersHorizontalIcon className="size-3.5" />Show current</>}</Button> : null}>
      {state.note && !showCurrent ? <p className="mb-2 text-meta text-muted-foreground">{state.note}</p> : null}
      {showCurrent ? <IntelligentTool component={showCurrent} room={room} disabled={false} /> : <PinnedTool component={embed.pinned} room={room} />}
    </Frame>
  );
}

function PinnedTool({ component, room }: { component: TableComponent; room: RoomState }) {
  const parsed = useMemo(() => {
    try { return { spec: parseIntelligentUI(component.ui, component.refs) }; }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  }, [component.ui, component.refs]);
  if (!parsed.spec) return <p role="alert" className="text-small text-amber-ink">This tool could not be rendered. {parsed.error}</p>;
  return <PinnedSession key={component.contentSeq ?? component.seq} spec={parsed.spec} component={component} room={room} />;
}

function PinnedSession({ spec, component, room }: { spec: IntelligentUI; component: TableComponent; room: RoomState }) {
  // The inputs saved as of the message, kept historical: exploration here is never saved or sent.
  const initial = useMemo(() => safeInputSnapshot(spec, component.inputSnapshot).snapshot?.values ?? defaultUIValues(spec), [spec, component.inputSnapshot]);
  const [values, setValues] = useState<Record<string, UIValue>>(initial);
  const [version, setVersion] = useState(0);
  const changed = Object.keys(values).some(key => values[key] !== initial[key]);
  return (
    <div className="intelligent-tool">
      <ToolNode node={spec.root} spec={spec} values={values} change={(key, value) => setValues(previous => ({ ...previous, [key]: value }))} room={room} locked={false} inputResetVersion={version} onInputError={() => {}} />
      <div className="mt-2 flex items-center gap-2 text-meta text-muted-foreground">
        <span>Changes here stay on this device and are not saved.</span>
        {changed ? <Button size="xs" variant="ghost" onClick={() => { setValues(initial); setVersion(v => v + 1); }}>Reset</Button> : null}
      </div>
    </div>
  );
}

function Frame({ id, title, badge, action, children }: { id: string; title?: string; badge?: string | null; action?: ReactNode; children: ReactNode }) {
  return (
    <figure className="not-prose my-3 overflow-hidden rounded-xl border border-border bg-paper shadow-soft">
      {/* Wraps into rows on a narrow screen: the action takes its own row before the title or badge break words. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
        <div className="flex min-w-[12rem] flex-1 items-center gap-2">
          <span className="shrink-0 whitespace-nowrap font-mono">{id}</span>
          {title ? <span className="min-w-0 flex-1 truncate text-foreground">{title}</span> : null}
          {badge ? <span className="shrink-0 whitespace-nowrap rounded-md border border-border px-1.5 py-0.5 text-meta">{badge}</span> : null}
        </div>
        {action ? <span className="ml-auto shrink-0 whitespace-nowrap">{action}</span> : null}
      </div>
      <div className="p-3">{children}</div>
    </figure>
  );
}
