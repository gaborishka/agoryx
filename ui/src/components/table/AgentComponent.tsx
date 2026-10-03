import { ArchiveIcon, ArrowUpRightIcon, CheckCircle2Icon, ChevronDownIcon, FileIcon, LayoutPanelTopIcon, ListChecksIcon, LoaderCircleIcon, ScanEyeIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { stepChecked } from "@agora/table";
import type { WorkComponentView, WorkRef } from "@agora/work-table";
import { Clamp } from "@/components/common/Clamp";
import { Markdown } from "@/components/md/Markdown";
import { Avatar, Name } from "@/components/room/bits";
import { Button } from "@/components/ui/button";
import { local } from "@/lib/api";
import { useStore } from "@/lib/store";
import type { RoomState, TableOption } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FilePreview } from "./OpCard";

/** Sources and controls stay native, outside any agent-authored HTML. */
export function WorkSources({ refs, className, onNavigate }: { refs: WorkRef[]; className?: string; onNavigate?: () => void }) {
  const goToRef = useStore(s => s.goToRef);
  const openChanges = useStore(s => s.openChanges);
  if (!refs.length) return null;
  return <div className={cn("flex flex-wrap items-center gap-1.5", className)}>{refs.map(ref => (
    <button key={ref.id} type="button" disabled={ref.kind === "missing"} title={ref.text ?? ref.id}
      onClick={() => { onNavigate?.(); if (ref.kind === "turn") openChanges({ scope: "turn", turn: ref.id, acts: true }); else goToRef(ref.kind === "message" ? `m-${ref.id}` : ref.id); }}
      className={cn("inline-flex min-h-6 items-center gap-1 rounded-md px-1.5 font-mono text-micro text-muted-foreground ring-1 ring-border transition hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring", ref.kind === "missing" && "line-through opacity-60")}>
      {ref.id}<ArrowUpRightIcon className="size-2.5" />
    </button>
  ))}</div>;
}

const KIND = {
  comparison: ["Порівняння", LayoutPanelTopIcon], plan: ["План", ListChecksIcon], checks: ["Перевірки", ScanEyeIcon], artifact: ["Результат", FileIcon], custom: ["Компонент", LayoutPanelTopIcon],
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
    <article id={`component-${component.id}`} data-work-component={component.kind} className="min-w-0 scroll-mt-4 overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
      <header className="flex items-start gap-2.5 px-4 py-3.5">
        {component.source === "authored" ? <Avatar handle={component.by} size={25} /> : <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-secondary text-muted-foreground"><Icon className="size-4" /></span>}
        <div className="min-w-0 flex-1">
          <h3 className="text-body leading-snug font-semibold text-pretty">{component.title}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-meta text-muted-foreground">
            {component.source === "authored" ? <><Name handle={component.by} /> · створено для цієї задачі</> : <>Із подій кімнати · {label.toLowerCase()}</>}
            {component.updatedBy && component.updatedBy !== component.by ? <span>· оновив <Name handle={component.updatedBy} /></span> : null}
            {component.source === "authored" ? <span className="font-mono text-micro">{component.id} · #{component.updatedSeq}</span> : null}
            {component.stale ? <span className="text-amber">Дані змінилися</span> : null}
            {archived ? <span className="text-muted-foreground">Архів</span> : null}
          </div>
        </div>
        <Button size="icon-sm" variant="ghost" onClick={toggle} aria-label={collapsed ? "Розгорнути компонент" : "Згорнути компонент"} aria-expanded={!collapsed} aria-controls={`body-${component.id}`}><ChevronDownIcon className={cn("size-4 transition", !collapsed && "rotate-180")} /></Button>
      </header>
      {!collapsed ? <div id={`body-${component.id}`} className="min-w-0 border-t border-border/60 px-4 py-3.5">
        <ComponentBody component={component} room={room} action={action} />
      </div> : null}
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 bg-secondary/20 px-4 py-2">
        <WorkSources refs={component.refs} />
        {archive && component.source === "authored" ? <Button variant="ghost" size="xs" disabled={archiving || action.disabled || !!action.pending} onClick={archiveComponent} className="ml-auto text-muted-foreground">
          {archiving ? <LoaderCircleIcon className="size-3 animate-spin" /> : <ArchiveIcon className="size-3" />} {archiving ? "Архівуємо…" : "В архів"}
        </Button> : null}
      </footer>
    </article>
  );
}

function ComponentBody({ component, room, action }: { component: WorkComponentView; room: RoomState; action: ComponentAction }) {
  const { table } = room;
  const ids = new Set(component.refs.map(ref => ref.id));
  const questions = table.questions.filter(q => ids.has(q.id));
  const options = table.options.filter(o => ids.has(o.id) || questions.some(q => q.id === o.q));
  const steps = table.next.filter(step => ids.has(step.id) || (step.target && ids.has(step.target)));
  const notes = table.notes.filter(note => ids.has(note.id) || ids.has(note.target));
  const claims = [...table.facts, ...table.settled].filter(claim => ids.has(claim.id));
  if (component.kind === "custom") return <>
    {component.body ? <Markdown text={component.body} source={`w:${component.id}`} className="text-ui" /> : null}
    {component.file ? <FilePreview file={component.file} seq={component.contentSeq ?? component.seq} /> : null}
    {!component.body && !component.file ? <p className="text-small text-muted-foreground">Компонент ще не має вмісту.</p> : null}
  </>;
  return <>
    {component.body ? <Clamp max={110} more="Контекст"><Markdown text={component.body} source={`w:${component.id}`} className="mb-3 text-ui text-muted-foreground" /></Clamp> : null}
    {component.kind === "comparison" ? <div className="grid gap-3 @xl:grid-cols-2">
      {options.slice(0, 6).map(option => {
        const chosenBy = option.status === "chosen" ? table.decisions.findLast(decision => decision.option === option.id)?.by : undefined;
        return <div key={option.id} className="flex min-w-0 flex-col rounded-xl border border-border p-3">
        <div className="flex items-center gap-2 text-meta text-muted-foreground"><Name handle={option.by} /><span className="ml-auto font-mono">{option.id}</span></div>
        <h4 className="mt-2 text-body font-semibold text-pretty">{option.title}</h4>
        {chosenBy ? <div className="mt-1.5 flex flex-wrap items-center gap-1 text-meta text-muted-foreground">Обрав <Name handle={chosenBy} /> · {chosenBy === room.human ? "людина" : "агент"}</div> : null}
        {option.file ? <FilePreview file={option.file} seq={option.seq} /> : null}
        {option.body ? <Clamp max={120} more="Деталі"><Markdown text={option.body} source={`o:${option.id}`} className="mt-2 text-small text-muted-foreground" /></Clamp> : null}
        <Button size="sm" variant={option.status === "chosen" ? "secondary" : "outline"} disabled={action.disabled || !!action.pending || option.status !== "open" || (!!option.q && table.questions.find(q => q.id === option.q)?.status !== "open")} className="mt-3 self-start" onClick={() => action.choose(option)}>
          {action.pending === option.id ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : null}{option.status === "chosen" ? "Обрано" : option.status === "withdrawn" ? "Відкликано" : "Обрати"}
        </Button>
      </div>;
      })}
      {!options.length ? <p className="text-small text-muted-foreground">Пов’язаних варіантів зараз немає.</p> : null}
    </div> : null}
    {component.kind === "plan" || component.kind === "checks" ? <div className="flex flex-col divide-y divide-border/60">
      {steps.slice(0, 8).map(step => {
        const findings = table.notes.filter(note => note.target === step.id && note.kind === "object");
        const status = step.done ? (stepChecked(step) ? "Перевірено" : "Завершено без перевірки") : step.review ? (findings.length ? "Є зауваження" : "Чекає перевірки") : "Наступний крок";
        return <div key={step.id} className="flex min-w-0 items-start gap-2.5 py-2.5 first:pt-0 last:pb-0">
          {stepChecked(step) ? <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-add-ink" /> : <ScanEyeIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
          <div className="min-w-0 flex-1"><p className="line-clamp-3 text-ui leading-snug">{step.text}</p><div className="mt-1 flex flex-wrap items-center gap-1.5 text-meta text-muted-foreground"><Name handle={step.review ?? step.by} /> · <span className={findings.length && !stepChecked(step) ? "text-amber" : ""}>{status}</span></div>
            {component.kind === "checks" && findings.length && !stepChecked(step) ? <p className="mt-2 line-clamp-2 text-small text-amber">{findings[0]!.text}</p> : null}
          </div><WorkSources refs={component.refs.filter(ref => ref.id === step.id)} />
        </div>;
      })}
      {!steps.length ? notes.slice(0, 5).map(note => <div key={note.id} className="py-2.5 text-ui"><p className="line-clamp-3">{note.text}</p><div className="mt-1 text-meta text-muted-foreground"><Name handle={note.by} /> · {note.kind === "object" ? "Зауваження" : note.kind === "support" ? "Підтримка" : "Доказ"}</div></div>) : null}
      {claims.slice(0, 5).map(claim => <div key={claim.id} className="py-2.5 text-ui"><p className={cn("line-clamp-3", claim.withdrawn && "text-muted-foreground line-through")}>{claim.text}</p><div className="mt-1 flex flex-wrap items-center gap-1.5 text-meta text-muted-foreground"><Name handle={claim.by} /> · {claim.withdrawn ? "Відкликано" : claim.id.startsWith("F") ? "Записаний факт" : "Висновок"}<WorkSources refs={component.refs.filter(ref => ref.id === claim.id)} /></div></div>)}
      {!steps.length && !notes.length && !claims.length ? <p className="text-small text-muted-foreground">Пов’язаних кроків або перевірок зараз немає.</p> : null}
    </div> : null}
    {component.kind === "artifact" ? <>
      {options.slice(0, 3).map(option => <div key={option.id} className="mb-3 last:mb-0">{options.length > 1 ? <h4 className="mb-2 text-small font-semibold">{option.title}</h4> : null}{option.file ? <FilePreview file={option.file} seq={option.seq} /> : option.body ? <Clamp max={300} more="Відкрити результат"><Markdown text={option.body} source={`o:${option.id}`} className="text-ui" /></Clamp> : null}</div>)}
      {component.file ? <FilePreview file={component.file} seq={component.contentSeq ?? component.seq} /> : null}
      {!options.length && !component.file && !component.body ? <p className="text-small text-muted-foreground">Результат ще не опублікований.</p> : null}
    </> : component.file ? <FilePreview file={component.file} seq={component.contentSeq ?? component.seq} /> : null}
  </>;
}
