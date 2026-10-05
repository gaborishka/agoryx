import { useEffect, useMemo, useState } from "react";
import { ArrowRightIcon, HistoryIcon, PlusIcon, UsersIcon } from "lucide-react";
import type { WorkflowRun } from "@agora/workflow-types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, roomPath } from "@/lib/api";
import { useStore } from "@/lib/store";
import { activeWorkflow, useWorkflow } from "@/lib/workflow-state";
import { WORK_MODES, isProtocolMode, phaseName, type ProtocolMode } from "@/lib/workflow";
import { cn } from "@/lib/utils";
import { ModeCatalog } from "./ModeCatalog";

const STATUS: Record<string, string> = { running: "In progress", waiting_user: "Your decision", completed: "Completed", failed: "Needs attention", cancelled: "Stopped" };

export function WorkflowSessions() {
  const roomId = useStore((s) => s.snap?.state.id);
  const live = useWorkflow((s) => s.roomId === roomId ? s.run : null);
  const [saved, setSaved] = useState<WorkflowRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [filter, setFilter] = useState<ProtocolMode | "all">("all");
  const [choosing, setChoosing] = useState(false);
  useEffect(() => {
    let alive = true;
    setSaved([]); setLoading(true); setError(null);
    if (!roomId) return;
    void api<{ workflows: WorkflowRun[] }>("GET", roomPath(roomId, "/workflow/history"))
      .then((response) => { if (alive) setSaved(response.workflows ?? []); })
      .catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [roomId, live?.id, live?.status, retry]);
  const sessions = useMemo(() => {
    const all = new Map(saved.map((run) => [run.id, run]));
    if (live) all.set(live.id, live);
    return [...all.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [saved, live]);
  const running = activeWorkflow(live);
  return <div className="@container/sessions scroll-thin min-h-0 flex-1 overflow-y-auto bg-canvas">
    <div className="mx-auto max-w-[1100px] px-5 py-8 sm:px-8 sm:py-10">
      <header className="mb-7 grid gap-4 @min-[40rem]/sessions:flex @min-[40rem]/sessions:items-start">
        <div className="min-w-0 flex-1"><p className="mb-2 text-[10px] font-semibold tracking-[.16em] uppercase text-faint">In this chat</p><h1 className="font-display text-[30px] font-semibold tracking-tight">Sessions</h1><p className="mt-2 max-w-[60ch] text-small leading-relaxed text-muted-foreground">Every approach, every outcome. Run a new mode with this chat’s participants, or pick up an earlier result.</p></div>
        <Button className="mt-1 w-fit" onClick={() => setChoosing(true)} disabled={running}><PlusIcon className="size-4" />New session</Button>
      </header>
      {running && live ? <button type="button" onClick={() => roomId && useStore.getState().openWorkflow(roomId, live.mode, live.id)} className="mb-6 flex w-full items-center gap-3 rounded-xl border border-foreground/20 bg-card p-4 text-left hover:bg-accent"><span className="size-2 shrink-0 animate-pulse rounded-full bg-foreground" /><span className="min-w-0 flex-1"><span className="block text-small font-medium">{WORK_MODES[live.mode].title} is in progress</span><span className="mt-1 block text-meta text-muted-foreground">{phaseName(live.phase)} · One session runs at a time in this chat.</span></span><ArrowRightIcon className="size-4 shrink-0" /></button> : null}
      <div className="mb-5 flex flex-wrap gap-1.5" aria-label="Filter sessions">
        {(["all", "verification", "council", "tournament", "debate"] as const).map((mode) => <button key={mode} type="button" aria-pressed={filter === mode} onClick={() => setFilter(mode)} className={cn("rounded-full border px-3 py-1.5 text-meta transition focus-visible:ring-2 focus-visible:ring-ring", filter === mode ? "border-foreground bg-foreground text-background" : "border-border bg-card text-muted-foreground hover:text-foreground")}>{mode === "all" ? "All modes" : WORK_MODES[mode].title}</button>)}
      </div>
      {error ? <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-destructive/20 p-4 text-small text-destructive"><span className="flex-1">Couldn’t load saved sessions: {error}</span><Button variant="outline" size="sm" onClick={() => setRetry((n) => n + 1)}>Try again</Button></div> : null}
      {loading && !sessions.length ? <p className="py-10 text-center text-small text-muted-foreground">Loading sessions…</p> : <div className="space-y-3">
        {sessions.filter((run) => filter === "all" || run.mode === filter).map((run) => {
          const Icon = WORK_MODES[run.mode].icon;
          return <button key={run.id} type="button" aria-label={`Open ${WORK_MODES[run.mode].title} session: ${run.task}`} onClick={() => roomId && useStore.getState().openWorkflow(roomId, run.mode, run.id)} className="group flex w-full items-start gap-4 rounded-2xl border border-border bg-card p-5 text-left transition hover:border-foreground/30 hover:shadow-edge focus-visible:ring-2 focus-visible:ring-ring">
            <span className="mt-0.5 hidden size-10 shrink-0 place-items-center rounded-xl border border-border bg-canvas @min-[28rem]/sessions:grid"><Icon className="size-5 text-muted-foreground" /></span>
            <span className="min-w-0 flex-1"><span className="mb-2 flex flex-wrap items-center gap-2 text-meta"><span className="font-medium">{WORK_MODES[run.mode].title}</span><span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">{STATUS[run.status] ?? run.status.replaceAll("_", " ")}</span></span><span className="line-clamp-2 block text-[16px] font-medium leading-snug">{run.task}</span><span className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-faint"><span>{new Date(run.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span><span className="inline-flex items-center gap-1"><UsersIcon className="size-3.5" />{run.participants.length} participants</span></span></span>
            <ArrowRightIcon className="mt-1 size-4 shrink-0 text-faint transition group-hover:text-foreground" />
          </button>;
        })}
        {!sessions.some((run) => filter === "all" || run.mode === filter) && !error ? <div className="rounded-2xl border border-dashed border-border px-6 py-12 text-center"><HistoryIcon className="mx-auto mb-4 size-7 text-faint" /><h2 className="text-body font-medium">{filter === "all" ? "Your first session starts here" : `No ${WORK_MODES[filter].title.toLowerCase()} sessions yet`}</h2><p className="mx-auto mt-2 max-w-md text-small leading-relaxed text-muted-foreground">Choose a mode for a focused round of work. Its results stay here, alongside your conversation and table.</p><Button variant="outline" className="mt-5" disabled={running} onClick={() => setChoosing(true)}>Choose a mode<ArrowRightIcon className="size-4" /></Button></div> : null}
      </div>}
    </div>
    <Dialog open={choosing} onOpenChange={setChoosing}><DialogContent className="max-h-[88dvh] overflow-y-auto sm:max-w-[820px]"><DialogHeader><DialogTitle>Start a session in this chat</DialogTitle><DialogDescription>Your conversation, participants, and project stay together. Choose how the agents should work next.</DialogDescription></DialogHeader><ModeCatalog includeChat={false} onSelect={(mode) => { if (isProtocolMode(mode) && roomId) { setChoosing(false); useStore.getState().openWorkflow(roomId, mode, "new"); } }} /></DialogContent></Dialog>
  </div>;
}
