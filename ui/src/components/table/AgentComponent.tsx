import { IntelligentTool } from "./IntelligentTool";
import { TableAssistButton } from "./TableAssist";
import { ArchiveIcon, ArrowUpRightIcon, CheckCircle2Icon, ChevronDownIcon, FileIcon, LayoutPanelTopIcon, ListChecksIcon, LoaderCircleIcon, ScanEyeIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { stepBuilder, stepChecked } from "@agora/table";
import { createWorkRefResolver, type WorkComponentView, type WorkRef } from "@agora/work-table";
import { Clamp } from "@/components/common/Clamp";
import { Markdown } from "@/components/md/Markdown";
import { Avatar, Name } from "@/components/room/bits";
import { Button } from "@/components/ui/button";
import { local } from "@/lib/api";
import { componentRecords, componentWindow, optionStanding } from "@/lib/component-records";
import { useStore } from "@/lib/store";
import type { RoomState, TableOption } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FilePreview, NoteSource } from "./OpCard";

/** Sources and controls stay native, outside any agent-authored HTML. */
export function WorkSources({ refs, className, onNavigate }: { refs: WorkRef[]; className?: string; onNavigate?: () => void }) {
  const goToRef = useStore(s => s.goToRef);
  const openChanges = useStore(s => s.openChanges);
  if (!refs.length) return null;
  return <div className={cn("flex flex-wrap items-center gap-1.5", className)}>{refs.map(ref => (
    <button key={ref.id} type="button" disabled={ref.kind === "missing"} title={ref.text ?? ref.id}
      aria-label={ref.kind === "missing" ? `Source ${ref.id} is unavailable` : `Open source ${ref.id}${ref.text ? `: ${ref.text}` : ""}`}
      onClick={() => { onNavigate?.(); if (ref.kind === "turn") openChanges({ scope: "turn", turn: ref.id, acts: true }); else goToRef(ref.kind === "message" ? `m-${ref.id}` : ref.id); }}
      className={cn("inline-flex min-h-8 items-center gap-1 rounded-md px-2 font-mono text-meta text-muted-foreground ring-1 ring-border transition hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11", ref.kind === "missing" && "line-through opacity-60")}>
      {ref.id}<ArrowUpRightIcon className="size-3" />
    </button>
  ))}</div>;
}

const KIND = {
  interactive: ["Interactive tool", LayoutPanelTopIcon], comparison: ["Comparison", LayoutPanelTopIcon], plan: ["Plan", ListChecksIcon], checks: ["Checks", ScanEyeIcon], artifact: ["Result", FileIcon], custom: ["Component", LayoutPanelTopIcon],
} as const;

export type ComponentAction = { pending: string | null; disabled: boolean; choose: (option: TableOption) => void };

export function AgentComponent({ component, room, action, archive, archived = false }: {
  component: WorkComponentView; room: RoomState; action: ComponentAction; archive?: (id: string) => Promise<boolean>; archived?: boolean;
}) {
  const key = `table.component.${room.id}.${component.id}`;
  const [collapsed, setCollapsed] = useState(() => local.get(key) === "collapsed" || (local.get(key) === null && archived));
  const [archiving, setArchiving] = useState(false);
  const flash = useStore(s => s.flash);
  const [label, Icon] = KIND[component.kind];
  const contentAuthor = component.contentBy ?? component.by;
  const provenance = `Created by ${component.by} at event #${component.seq}. Content published by ${contentAuthor} at event #${component.contentSeq ?? component.seq}. Last updated by ${component.updatedBy ?? component.by} at event #${component.updatedSeq}.`;
  useEffect(() => {
    setCollapsed(local.get(key) === "collapsed" || (local.get(key) === null && archived));
  }, [key, archived]);
  useEffect(() => {
    if (flash?.ref === component.id) { setCollapsed(false); local.set(key, null); }
  }, [flash, component.id, key]);
  const toggle = () => { local.set(key, collapsed ? null : "collapsed"); setCollapsed(!collapsed); };
  const archiveComponent = async () => {
    if (!archive || archiving) return;
    setArchiving(true);
    try { await archive(component.id); } finally { setArchiving(false); }
  };
  return (
    <article id={`component-${component.id}`} data-work-component={component.kind} className={cn("min-w-0 scroll-mt-4 overflow-hidden rounded-2xl border bg-card shadow-soft", component.kind === "interactive" ? "intelligent-component border-codex/25" : "border-border")}>
      {component.kind === "interactive" ? <div className="flex items-center gap-2 border-b border-codex/10 bg-codex-soft/30 px-4 py-2 text-micro font-semibold tracking-wider text-primary"><LayoutPanelTopIcon className="size-3.5" />BUILT FOR THIS TASK<span className="ml-auto font-normal tracking-normal text-muted-foreground">Interactive tool</span></div> : null}
      <header className="flex items-start gap-2.5 px-4 py-3.5">
        {component.source === "authored" ? <Avatar handle={contentAuthor} size={25} /> : <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-secondary text-muted-foreground"><Icon className="size-4" /></span>}
        <div className="min-w-0 flex-1">
          <h3 className="text-body leading-snug font-semibold text-pretty [overflow-wrap:anywhere]">{component.title}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-meta text-muted-foreground">
            {component.source === "authored" ? <span className="min-w-0 [overflow-wrap:anywhere]">by <Name handle={contentAuthor} /></span> : <>From room events · {label.toLowerCase()}</>}
            {component.source === "authored" && contentAuthor !== component.by ? <span className="min-w-0 [overflow-wrap:anywhere]">· created by <Name handle={component.by} /></span> : null}
            {component.source === "authored" ? <><span className="font-mono text-micro" title={provenance}>{component.id}</span><span className="sr-only">{provenance}</span></> : null}
            {component.stale ? <span className="rounded-md bg-amber-soft/70 px-1.5 py-0.5 text-amber-ink">Sources changed</span> : null}
            {archived ? <span className="rounded-md bg-secondary px-1.5 py-0.5 text-muted-foreground">Archived</span> : null}
          </div>
        </div>
        <Button size="icon-sm" variant="ghost" className="pointer-coarse:size-11" onClick={toggle} aria-label={`${collapsed ? "Expand" : "Collapse"} component: ${component.title}`} aria-expanded={!collapsed} aria-controls={`body-${component.id}`}><ChevronDownIcon className={cn("size-4 transition", !collapsed && "rotate-180")} /></Button>
      </header>
      {!collapsed ? <div id={`body-${component.id}`} className="min-w-0 border-t border-border/60 px-4 py-3.5">
        <ComponentBody component={component} room={room} action={action} />
      </div> : null}
      <footer className="flex flex-wrap items-start justify-between gap-2 border-t border-border/60 bg-secondary/20 px-4 py-2">
        {component.refs.length > 4 ? <details className="group min-w-0 flex-1">
          <summary aria-label={`Sources for ${component.title}, ${component.refs.length} references`} className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-md px-2 text-small text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
            <ChevronDownIcon className="size-3.5 transition group-open:rotate-180" />Sources · {component.refs.length}
          </summary>
          <div className="pt-2 pb-1"><WorkSources refs={component.refs} /></div>
        </details> : <WorkSources refs={component.refs} />}
        {component.kind === "interactive" && !archived && !action.disabled ? <TableAssistButton kind="tool" target={component.id} /> : null}
        {archive && component.source === "authored" ? <Button variant="ghost" size="sm" disabled={archiving || action.disabled || !!action.pending} onClick={archiveComponent} aria-label={`Archive component: ${component.title}`} className="ml-auto text-muted-foreground pointer-coarse:h-11">
          {archiving ? <LoaderCircleIcon className="size-3 animate-spin" /> : <ArchiveIcon className="size-3" />} {archiving ? "Archiving…" : "Archive"}
        </Button> : null}
      </footer>
    </article>
  );
}

function ComponentBody({ component, room, action }: { component: WorkComponentView; room: RoomState; action: ComponentAction }) {
  const { table } = room;
  const [expanded, setExpanded] = useState(false);
  const resolve = useMemo(() => createWorkRefResolver(room), [room]);
  const records = componentRecords(table, component.refs.map(ref => ref.id));
  const compact = componentWindow(records, component.kind, false);
  const { options, steps, notes, claims, omitted } = expanded ? componentWindow(records, component.kind, true) : compact;
  if (component.kind === "interactive") return <IntelligentTool component={component} room={room} disabled={action.disabled || !!action.pending} />;
  if (component.kind === "custom") return <>
    {component.body ? <Markdown text={component.body} source={`w:${component.id}`} className="text-ui [overflow-wrap:anywhere]" /> : null}
    {component.file ? <FilePreview file={component.file} seq={component.contentSeq ?? component.seq} revision={component.contentSeq ?? component.seq} /> : null}
    {!component.body && !component.file ? <p className="text-small text-muted-foreground">No content published yet.</p> : null}
  </>;
  return <>
    {component.body ? <Clamp max={110} more="Context"><Markdown text={component.body} source={`w:${component.id}`} className="mb-3 text-ui text-muted-foreground [overflow-wrap:anywhere]" /></Clamp> : null}
    <div id={`records-${component.id}`}>
    {component.kind === "comparison" ? <div className="grid gap-3 @xl:grid-cols-2">
      {options.map(option => {
        const standing = optionStanding(table, option);
        const chosenBy = option.status === "chosen" ? table.decisions.findLast(decision => decision.option === option.id)?.by : undefined;
        return <div key={option.id} className="flex min-w-0 flex-col rounded-xl border border-border p-3">
        <div className="flex items-center gap-2 text-meta text-muted-foreground"><Name handle={option.by} /><span className="ml-auto font-mono">{option.id}</span></div>
        <h4 className="mt-2 text-body font-semibold text-pretty [overflow-wrap:anywhere]">{option.title}</h4>
        {chosenBy ? <div className="mt-1.5 flex flex-wrap items-center gap-1 text-meta text-muted-foreground">Chosen by <Name handle={chosenBy} /> · {chosenBy === room.human ? "human" : "agent"}</div> : null}
        {option.file ? <FilePreview file={option.file} seq={option.seq} /> : null}
        {option.body ? <Clamp max={120} more="Details"><Markdown text={option.body} source={`o:${option.id}`} className="mt-2 text-small text-muted-foreground [overflow-wrap:anywhere]" /></Clamp> : null}
        <Button size="sm" variant={option.status === "chosen" ? "secondary" : "outline"} disabled={action.disabled || !!action.pending || !standing.canChoose} aria-label={`${standing.canChoose ? "Choose option" : standing.label}: ${option.title}`} className="mt-3 self-start pointer-coarse:h-11" onClick={() => action.choose(option)}>
          {action.pending === option.id ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : null}{standing.canChoose ? "Choose" : standing.label}
        </Button>
      </div>;
      })}
      {!options.length ? <p className="text-small text-muted-foreground">No related options are available.</p> : null}
    </div> : null}
    {component.kind === "plan" || component.kind === "checks" ? <div className="flex flex-col divide-y divide-border/60">
      {steps.map(step => {
        const findings = table.notes.filter(note => note.target === step.id && note.kind === "object");
        const status = step.done ? (stepChecked(step) ? "Checked" : "Done without a check") : step.review ? (findings.length ? "Has findings" : "Awaiting review") : "Next step";
        const builder = stepBuilder(step, room.human);
        const checker = stepChecked(step) ? step.checkedBy ?? (step.doneBy !== builder ? step.doneBy : undefined) : undefined;
        return <div key={step.id} className="flex min-w-0 items-start gap-2.5 py-2.5 first:pt-0 last:pb-0">
          {stepChecked(step) ? <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-add-ink" /> : <ScanEyeIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
          <div className="min-w-0 flex-1"><p className="line-clamp-3 text-ui leading-snug [overflow-wrap:anywhere]">{step.text}</p><div className="mt-1 flex flex-wrap items-center gap-1.5 text-meta text-muted-foreground"><Name handle={step.by} /> · <span className={findings.length && !stepChecked(step) ? "text-amber-ink" : ""}>{status}</span></div>
            {builder && builder !== step.by ? <div className="mt-1 text-meta text-muted-foreground">Built by <Name handle={builder} /></div> : null}
            {checker ? <div className="mt-1 text-meta text-muted-foreground">Checked by <Name handle={checker} /></div> : step.done && step.doneBy && step.doneBy !== step.by && step.doneBy !== builder ? <div className="mt-1 text-meta text-muted-foreground">Completed by <Name handle={step.doneBy} /></div> : null}
          </div><WorkSources refs={[resolve(step.id)]} />
        </div>;
      })}
      {notes.map(note => <div key={note.id} className="min-w-0 py-2.5 text-ui"><Clamp max={100} more="Details"><Markdown text={note.text} className={cn("text-small [overflow-wrap:anywhere]", note.kind === "object" ? "text-amber-ink" : "text-muted-foreground")} /></Clamp><div className="mt-1 flex flex-wrap items-center gap-1.5 text-meta text-muted-foreground"><Name handle={note.by} /> · {note.kind === "object" ? "Objection" : note.kind === "support" ? "Support" : "Evidence"}<WorkSources refs={[resolve(note.id), resolve(note.target)]} />{note.source ? <NoteSource source={note.source} /> : null}</div></div>)}
      {claims.map(claim => <div key={claim.id} className="min-w-0 py-2.5 text-ui"><p className={cn("line-clamp-3 [overflow-wrap:anywhere]", claim.withdrawn && "text-muted-foreground line-through")}>{claim.text}</p><div className="mt-1 flex flex-wrap items-center gap-1.5 text-meta text-muted-foreground"><Name handle={claim.by} /> · {claim.withdrawn ? "Withdrawn" : claim.id.startsWith("F") ? "Recorded fact" : "Conclusion"}<WorkSources refs={[resolve(claim.id)]} /></div></div>)}
      {!steps.length && !notes.length && !claims.length ? <p className="text-small text-muted-foreground">No related steps or checks are available.</p> : null}
    </div> : null}
    {component.kind === "artifact" ? <>
      {options.map(option => {
        const standing = optionStanding(table, option);
        const chosenBy = option.status === "chosen" ? table.decisions.findLast(decision => decision.option === option.id)?.by : undefined;
        return <div key={option.id} className="mb-4 min-w-0 last:mb-0"><h4 className={cn("text-small font-semibold [overflow-wrap:anywhere]", option.status === "withdrawn" && "text-muted-foreground line-through")}>{option.title}</h4><div className="mt-1 mb-2 flex flex-wrap items-center gap-1.5 text-meta text-muted-foreground"><Name handle={option.by} /> · {standing.label}<WorkSources refs={[resolve(option.id)]} /></div>{chosenBy ? <div className="mb-2 text-meta text-muted-foreground">Chosen by <Name handle={chosenBy} /> · {chosenBy === room.human ? "human" : "agent"}</div> : null}{option.file ? <FilePreview file={option.file} seq={option.seq} /> : null}{option.body ? <Clamp max={300} more="View result"><Markdown text={option.body} source={`o:${option.id}`} className="text-ui [overflow-wrap:anywhere]" /></Clamp> : null}{!option.body && !option.file ? <p className="text-small text-muted-foreground">No result published for this option yet.</p> : null}</div>;
      })}
      {component.file ? <FilePreview file={component.file} seq={component.contentSeq ?? component.seq} revision={component.contentSeq ?? component.seq} /> : null}
      {!options.length && !component.file && !component.body ? <p className="text-small text-muted-foreground">No result published yet.</p> : null}
    </> : component.file ? <FilePreview file={component.file} seq={component.contentSeq ?? component.seq} revision={component.contentSeq ?? component.seq} /> : null}
    </div>
    {compact.omitted ? <Button size="sm" variant="ghost" className="mt-3 text-muted-foreground pointer-coarse:h-11" aria-label={expanded ? `Collapse records in ${component.title}` : `Show ${omitted} more records in ${component.title}`} aria-expanded={expanded} aria-controls={`records-${component.id}`} onClick={() => setExpanded(!expanded)}><ChevronDownIcon className={cn("size-3.5", expanded && "rotate-180")} />{expanded ? "Collapse records" : `Show more · ${omitted}`}</Button> : null}
  </>;
}
