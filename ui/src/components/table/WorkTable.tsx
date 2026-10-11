import { ArrowRightIcon, ArrowUpIcon, CheckIcon, ChevronDownIcon, CircleHelpIcon, HistoryIcon, LayoutPanelTopIcon, LoaderCircleIcon, MessageSquareIcon, PlayIcon, SquareIcon, WifiOffIcon } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createWorkRefResolver, workTableView, type WorkComponentView, type WorkDecision, type WorkEvent, type WorkRef } from "@agora/work-table";
import { Clamp } from "@/components/common/Clamp";
import { Markdown } from "@/components/md/Markdown";
import { Avatar, Name } from "@/components/room/bits";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { local } from "@/lib/api";
import { ago } from "@/lib/format";
import { useStore } from "@/lib/store";
import type { TableOption } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AgentComponent, WorkSources } from "./AgentComponent";
import { TableAssistActions, TableAssistActivity, TableAssistButton } from "./TableAssist";

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const linkClass = "inline-flex min-h-8 items-center gap-1 text-small text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";
const eventLabels: Record<WorkEvent["kind"], string> = { decision: "Decision", question: "Question", reopened: "Reopened", review: "Ready for review", done: "Done", objection: "Objection", fact: "Fact", conclusion: "Conclusion", concession: "Position changed", artifact: "Result", component: "Component", error: "Error", run: "Run", workspace: "Workspace", pr: "Pull request", direction: "Direction" };

/** The table's first look is the state of work. The full argument remains one action away. */
export function WorkTable({ beside, onArguments }: { beside: boolean; onArguments: () => void }) {
  const snap = useStore(s => s.snap);
  const connection = useStore(s => s.connection);
  const post = useStore(s => s.post);
  const flash = useStore(s => s.flash);
  const setView = useStore(s => s.setView);
  const goToRef = useStore(s => s.goToRef);
  const openSession = useStore(s => s.openSession);
  const room = snap?.state;
  const model = useMemo(() => room ? workTableView(room, snap?.events ?? [], snap?.ops ?? []) : null, [room, snap?.events, snap?.ops]);
  const resolve = useMemo(() => room ? createWorkRefResolver(room) : null, [room]);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deferredQ, setDeferredQ] = useState<string | null>(null);
  const [context, setContext] = useState<{ title: string; refs: WorkRef[]; text?: string } | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const contextTrigger = useRef<HTMLButtonElement | null>(null);
  const [allComponents, setAllComponents] = useState(false);
  const [history, setHistory] = useState(false);
  const [allDecisions, setAllDecisions] = useState(false);
  const [archivesOpen, setArchivesOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const pendingRef = useRef(false);
  useEffect(() => { setPending(null); setError(null); setNotice(null); setDeferredQ(null); setAllComponents(false); setHistory(false); setAllDecisions(false); setArchivesOpen(false); setContextOpen(false); }, [room?.id]);
  useEffect(() => {
    if (!flash || (!flash.ref.startsWith("W") && flash.ref !== "brief")) return;
    if (flash.ref.startsWith("W")) { setAllComponents(true); setArchivesOpen(true); }
    // A folded card opens in the same render. No shared scroll position changes until then.
    const timer = setTimeout(() => {
      const node = host.current?.querySelector<HTMLElement>(flash.ref === "brief" ? "#table-headsup" : `#component-${CSS.escape(flash.ref)}`);
      node?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
      if (node) { node.classList.remove("animate-flash"); void node.offsetWidth; node.classList.add("animate-flash"); }
    }, 60);
    return () => clearTimeout(timer);
  }, [flash]);
  if (!snap || !room || !model || !resolve) return null;
  const disabled = !snap.driven || connection !== "live";
  const attention = model.headsUp.awaiting;
  const working = model.runtime.status === "working" || model.runtime.status === "active";
  const canContinue = model.runtime.status === "stopped" || model.runtime.status === "budget" || model.runtime.status === "quiet";
  const runLabel = model.runtime.status === "working" ? `${model.runtime.working} ${model.runtime.working === 1 ? "agent working" : "agents working"}` : ({ active: "Work is in progress", quiet: "Agents have finished their turns", stopped: "Stopped", budget: "Turn limit reached", idle: "Ready to start" }[model.runtime.status] ?? "Work is in progress");
  const perform = async (key: string, suffix: string, body: unknown, success: string): Promise<boolean> => {
    if (disabled || pendingRef.current) return false;
    const id = room.id;
    pendingRef.current = true; setPending(key); setError(null); setNotice(null);
    try {
      await post(suffix, body);
      if (useStore.getState().snap?.state.id === id) setNotice(success);
      return true;
    } catch (cause) {
      if (useStore.getState().snap?.state.id === id) setError(errorText(cause));
      return false;
    } finally {
      pendingRef.current = false;
      if (useStore.getState().snap?.state.id === id) setPending(null);
    }
  };
  const choose = (option: TableOption) => { void perform(option.id, "/table", { op: "decide", target: option.id }, "Decision recorded. Agents will see it in the shared context."); };
  const action = { pending, disabled, choose };
  const components = allComponents ? model.components : model.components.slice(0, 2);
  const tools = model.components.filter(component => component.kind === "interactive");
  const archived = (room.table.components ?? []).filter(component => component.archived);
  const focusComposer = () => { const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]'); input?.focus(); };
  const authored = model.headsUp.source === "authored";
  return (
    <div ref={host} className="scroll-thin @container min-h-0 flex-1 overflow-y-auto bg-canvas [overflow-wrap:anywhere]" data-work-table>
      <div className={cn("mx-auto flex w-full max-w-[1320px] flex-col gap-5 px-3 pb-6", beside ? "pt-3" : "pt-5 @sm:px-6")}>
        <header className="flex flex-wrap items-center gap-2.5">
          <h1 className="mr-auto flex items-center gap-2 font-display text-display leading-tight font-semibold"><LayoutPanelTopIcon className="size-5 text-muted-foreground" />Work table</h1>
          <Button size="sm" variant="ghost" onClick={onArguments} className="text-muted-foreground"><MessageSquareIcon className="size-3.5" />Arguments</Button>
          <TableAssistButton kind="tool" />
          <TableAssistActions compact />
        </header>
        {tools.length ? <nav aria-label="Interactive tools on this table" className="flex flex-wrap items-center gap-2"><span className="mr-1 text-meta font-medium text-muted-foreground">Your tools</span>{tools.map(tool => <button type="button" key={tool.id} onClick={() => goToRef(tool.id)} className="inline-flex min-h-9 max-w-full items-center gap-2 rounded-xl border border-border bg-card px-3 py-1.5 text-small transition hover:border-codex/40 hover:bg-codex-soft/30 focus-visible:outline-2 focus-visible:outline-ring"><LayoutPanelTopIcon className="size-3.5 shrink-0 text-codex" /><span className="truncate">{tool.title}</span><span className="font-mono text-micro text-muted-foreground">{tool.id}</span></button>)}</nav> : null}
        <TableAssistActivity />
        {connection !== "live" || !snap.driven ? <p className="flex items-start gap-2 rounded-xl bg-secondary px-3 py-2 text-small text-muted-foreground" role="status"><WifiOffIcon className="mt-0.5 size-3.5 shrink-0" />{!snap.driven ? "View only: another process is driving this room." : connection === "offline" ? "Offline. Showing the last received state; actions will be available after reconnecting." : "Reconnecting. Showing the last received state."}</p> : null}
        <section id="table-headsup" className="scroll-mt-4 border-b border-border pb-5" aria-labelledby="work-headsup">
          <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
            <h2 id="work-headsup" className="text-small font-semibold text-muted-foreground">HEADS-UP</h2>
            <button className={cn(linkClass, "max-w-full min-w-0 flex-wrap text-left")} type="button" onClick={event => { contextTrigger.current = event.currentTarget; setContext({ title: "What this overview is based on", refs: model.headsUp.refs, text: authored ? `Overview by ${model.headsUp.by ?? "agent"}, context through event #${model.headsUp.asOfSeq}.` : "This overview comes from the current room state: turns, questions, decisions and results." }); setContextOpen(true); }}>
              {authored ? <><Name handle={model.headsUp.by ?? "agoryx"} /> · </> : null}{model.headsUp.stale ? "New events · sources" : "Sources"}<ArrowRightIcon className="size-3" />
            </button>
          </div>
          <p className="max-w-[760px] [overflow-wrap:anywhere] text-lead leading-relaxed text-pretty tracking-tight @sm:text-title">{model.headsUp.now}</p>
          {authored && model.headsUp.changes.length ? <Clamp max={96} more="Full update" className="mt-3 max-w-[760px]"><ul className="flex flex-col gap-1.5 text-small text-muted-foreground">{model.headsUp.changes.slice(0, 3).map((change, index) => <li key={index} className="flex items-start gap-2"><span className="mt-2 size-1 shrink-0 rounded-full bg-current" /><span className="min-w-0 [overflow-wrap:anywhere]">{change}</span></li>)}</ul></Clamp> : null}
          {model.headsUp.stale ? <p className="mt-2 text-small text-amber-ink">The overview needs an update. The events and decisions below are current.</p> : null}
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-small text-muted-foreground">
            {model.headsUp.next ? <span className="inline-flex items-start gap-1.5"><ArrowRightIcon className="mt-0.5 size-3.5 shrink-0" />Next: {model.headsUp.next}</span> : null}
            <span className={cn("rounded-lg px-2 py-1 text-meta", attention && deferredQ !== attention.q ? "bg-amber-soft text-amber-ink" : "bg-secondary text-muted-foreground")}>
              {attention ? deferredQ === attention.q ? "Hidden for now" : "Your decision is needed" : "No new requests for you"}
            </span>
            {!attention && model.counts.openQuestions ? <button type="button" className={linkClass} onClick={onArguments}>Open questions: {model.counts.openQuestions}</button> : null}
          </div>
          <div className="mt-3.5 flex flex-wrap items-center gap-2">
            <span className="mr-auto inline-flex items-center gap-1.5 text-meta text-muted-foreground"><span className={cn("size-1.5 rounded-full", working ? "animate-breathe bg-add-ink" : "bg-faint")} />{runLabel}</span>
            {!beside ? <Button size="sm" variant="ghost" disabled={disabled} onClick={focusComposer}><ArrowUpIcon className="size-3.5" />Give direction</Button> : null}
            {working || canContinue ? <Button size="sm" variant="outline" disabled={disabled || !!pending} title={working ? "End this run and interrupt active turns. Results stay in the room." : "Start a new run with the same context; interrupted commands are not resumed."}
              onClick={() => void perform("runtime", working ? "/stop" : "/continue", {}, working ? "Run stopped; results are preserved." : "Requested continued work with the current context.")}>
              {pending === "runtime" ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : working ? <SquareIcon className="size-3 fill-current" /> : <PlayIcon className="size-3 fill-current" />}{pending === "runtime" ? "Sending…" : working ? "Stop" : "Continue"}
            </Button> : null}
          </div>
        </section>
        {error ? <p role="alert" className="rounded-xl border border-destructive/25 bg-destructive-soft px-3 py-2.5 text-small text-destructive">Action failed: {error}. You can try again.</p> : null}
        {notice ? <p role="status" aria-live="polite" className="flex items-start gap-2 rounded-xl bg-add/50 px-3 py-2 text-small text-add-ink"><CheckIcon className="mt-0.5 size-3.5 shrink-0" />{notice}</p> : null}
        {model.warnings.filter(warning => !["stale_brief", "budget", "stopped"].includes(warning.code)).slice(0, 2).map(warning => <div key={`${warning.code}-${warning.ref ?? warning.by ?? ""}`} className="flex flex-wrap items-start gap-2 rounded-xl border border-amber/20 bg-amber-soft/50 px-3 py-2 text-small text-amber-ink" role={warning.code === "agent_error" ? "alert" : "status"}>{warning.by ? <Name handle={warning.by} /> : null}<span className="min-w-0 flex-1 line-clamp-2">{warning.text}</span>{warning.ref ? <WorkSources refs={[resolve(warning.ref)]} /> : null}</div>)}
        <div className={cn("grid items-start gap-5 @3xl:grid-cols-[minmax(0,1fr)_240px]", attention && "@3xl:grid-rows-[min-content_minmax(0,1fr)]")}>
          {attention ? <div className="min-w-0 @3xl:col-start-1 @3xl:row-start-1">
            {attention ? deferredQ === attention.q ? <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-border p-3 text-small text-muted-foreground"><CircleHelpIcon className="size-3.5" /><span className="min-w-0 flex-1 truncate">Hidden for now: {attention.text}</span><Button size="xs" variant="ghost" onClick={() => setDeferredQ(null)}>Show</Button></div> : (
              <section className="rounded-2xl border border-border bg-card p-4 shadow-soft" aria-labelledby="work-decision-title">
                <div className="flex flex-wrap items-center justify-between gap-2 text-meta"><span className="font-semibold text-amber-ink">YOUR DECISION NEEDED</span><span className="font-mono text-muted-foreground">{attention.q}</span></div>
                <h2 id="work-decision-title" className="mt-2 text-title leading-snug font-semibold text-pretty [overflow-wrap:anywhere]">{attention.text}</h2>
                {attention.recommendation && !attention.stale ? <div className="mt-2 flex items-center gap-1.5 text-small text-muted-foreground"><Avatar handle={attention.by} size={18} /><Name handle={attention.by} /> recommends {attention.options.find(option => option.id === attention.recommendation)?.title ?? attention.recommendation}</div> : null}
                {attention.stale ? <p className="mt-2 text-small text-amber-ink">The request context has changed. The options below are still open.</p> : null}
                <div className="mt-3 grid gap-2.5 @xl:grid-cols-2">
                  {attention.options.slice(0, 3).map(option => {
                    const recommended = option.id === attention.recommendation && !attention.stale;
                    return <div key={option.id} className={cn("flex min-w-0 flex-col rounded-xl border p-3", recommended ? "border-primary/40 bg-secondary/35" : "border-border")}>
                      <div className="flex items-center gap-1.5 text-meta text-muted-foreground"><Name handle={option.by} /><span className="ml-auto font-mono">{option.id}</span></div>
                      <h3 className="mt-1.5 text-body leading-snug font-semibold text-pretty [overflow-wrap:anywhere]">{option.title}</h3>
                      {option.body ? <Clamp max={75} more="Context"><Markdown text={option.body} className="mt-2 text-small text-muted-foreground" /></Clamp> : null}
                      <Button size="sm" variant={recommended ? "default" : "outline"} className="mt-3 self-start" aria-label={`Choose ${option.title}${recommended ? " (recommended)" : ""}`} disabled={disabled || !!pending} onClick={() => choose(option)}>
                        {pending === option.id ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : null}{pending === option.id ? "Saving…" : recommended ? "Choose recommended" : "Choose"}
                      </Button>
                    </div>;
                  })}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                  <button type="button" className={linkClass} onClick={() => goToRef(attention.q)}>{attention.options.length > 3 ? `All ${attention.options.length} options and arguments` : "Arguments and evidence"}<ArrowRightIcon className="size-3" /></button>
                  {!attention.options.length ? <TableAssistButton kind="conclusion" target={attention.q} /> : null}
                  <Button size="xs" variant="ghost" disabled={!!pending} onClick={() => setDeferredQ(attention.q)} className="ml-auto text-muted-foreground" title="Hide this question for now. The work and the question stay unchanged.">Later</Button>
                </div>
              </section>
            ) : null}
          </div> : null}
          <div id="work-results" className={cn("flex min-w-0 flex-col gap-4 @3xl:col-start-1", attention ? "@3xl:row-start-2" : "@3xl:row-start-1")}>
            {components.map(component => <AgentComponent key={component.id} component={component} room={room} action={action} archive={id => perform(`archive-${id}`, "/table", { op: "archive", target: id }, "Component archived. Its history is preserved.")} />)}
            {model.components.length > 2 ? <Button size="sm" variant="ghost" className="self-start text-muted-foreground" onClick={() => setAllComponents(!allComponents)} aria-expanded={allComponents} aria-controls="work-results"><ChevronDownIcon className={cn("size-3.5", allComponents && "rotate-180")} />{allComponents ? "Show main results only" : `Show the rest · ${model.components.length - 2}`}</Button> : null}
            {!components.length ? <section className="rounded-2xl border border-dashed border-border p-5"><h2 className="text-body font-semibold">A working surface for your next idea</h2><p className="mt-1 max-w-lg text-small leading-relaxed text-muted-foreground">Ask an agent to build a calculator, an interactive comparison or a visual explorer from this conversation. Change the inputs, explore the result, and save a scenario for the team.</p><Button size="sm" variant="ghost" onClick={() => setView("chat")} className="mt-3 -ml-2 text-muted-foreground"><MessageSquareIcon className="size-3.5" />Open conversation</Button></section> : null}
            {archived.length ? <section className="border-t border-border/70 pt-3">
              <Button size="sm" variant="ghost" onClick={() => setArchivesOpen(!archivesOpen)} aria-expanded={archivesOpen} className="text-muted-foreground"><HistoryIcon className="size-3.5" />Component archive · {archived.length}<ChevronDownIcon className={cn("size-3.5", archivesOpen && "rotate-180")} /></Button>
              {archivesOpen ? <div className="mt-3 flex flex-col gap-3">{archived.map(component => {
                const view: WorkComponentView = { ...component, refs: component.refs.map(id => resolve(id)), source: "authored", stale: false };
                return <div key={component.id}><AgentComponent component={view} room={room} action={{ ...action, disabled: true }} archived /><div className="mt-1.5 flex justify-end"><Button size="xs" variant="ghost" disabled={disabled || !!pending} onClick={() => void perform(`restore-${component.id}`, "/table", { op: "restore", target: component.id }, "Component restored to the table.")}>{pending === `restore-${component.id}` ? "Restoring…" : "Restore to table"}</Button></div></div>;
              })}</div> : null}
            </section> : null}
          </div>
          <aside className={cn("grid min-w-0 gap-4 rounded-xl border border-border bg-card/40 p-3 @xl:grid-cols-2 @3xl:col-start-2 @3xl:row-start-1 @3xl:grid-cols-1 @3xl:border-0 @3xl:bg-transparent @3xl:p-0", attention && "@3xl:row-span-2")} aria-label="Team, changes and decisions">
            <section className="min-w-0">
              <div className="flex items-center justify-between gap-2"><h2 className="text-small font-semibold text-muted-foreground">Important changes</h2><button type="button" className={linkClass} onClick={() => setView("chat")}>All</button></div>
              <ol className="mt-2.5 flex flex-col gap-3">{model.events.map(event => <li key={`${event.kind}-${event.seq}-${event.ref ?? ""}`} className="border-l-2 border-border pl-2.5"><p className="line-clamp-3 text-small leading-relaxed [overflow-wrap:anywhere]" title={event.text}>{event.text}</p><div className="mt-1 flex flex-wrap items-center gap-1.5 text-meta text-muted-foreground"><span>{event.kind === "error" && event.status === "interrupted" ? "Interrupted" : event.kind === "component" && event.status === "archive" ? "Archived" : event.kind === "component" && event.status === "restore" ? "Restored" : eventLabels[event.kind]}</span>{event.by ? <><span>·</span><Name handle={event.by} /></> : null}{event.ts ? <span>· {ago(event.ts)}</span> : null}{event.ref ? <WorkSources refs={[resolve(event.ref)]} /> : null}</div></li>)}{!model.events.length ? <li className="text-small text-muted-foreground">No new events yet.</li> : null}</ol>
            </section>
            <section className="min-w-0 border-t border-border/70 pt-4 @xl:border-t-0 @xl:pt-0 @3xl:border-t @3xl:pt-4">
              <div className="flex items-center justify-between gap-2"><h2 className="text-small font-semibold text-muted-foreground">Current decisions{model.counts.currentDecisions ? ` · ${model.counts.currentDecisions}` : ""}</h2><Button variant="ghost" size="xs" onClick={() => setHistory(!history)} className="text-muted-foreground" aria-expanded={history}><HistoryIcon className="size-3" />History</Button></div>
              <div className="mt-3 flex flex-col gap-3">{(allDecisions ? model.decisions : model.decisions.slice(0, 3)).map(decision => <DecisionSummary key={decision.id} decision={decision} resolve={resolve} disabled={disabled || !!pending} reopening={pending === `reopen-${decision.id}`} reopen={() => void perform(`reopen-${decision.id}`, "/table", { op: "reopen", target: decision.option }, "Choice reopened. The previous decision remains in history.")} />)}{!model.decisions.length ? <p className="text-small text-muted-foreground">No current decisions.</p> : null}</div>
              {model.decisions.length > 3 ? <Button size="xs" variant="ghost" className="mt-2 text-muted-foreground" aria-expanded={allDecisions} onClick={() => setAllDecisions(!allDecisions)}>{allDecisions ? "Collapse decisions" : `More current decisions · ${model.decisions.length - 3}`}</Button> : null}
              {model.counts.currentDecisions > model.decisions.length ? <button type="button" className={cn(linkClass, "mt-2")} onClick={onArguments}>All current decisions · {model.counts.currentDecisions}<ArrowRightIcon className="size-3" /></button> : null}
              {history ? <div className="mt-4 border-t border-border/70 pt-3"><h3 className="mb-2 text-meta font-semibold text-muted-foreground">Recent decision history</h3>{model.historicalDecisions.length ? model.historicalDecisions.map(decision => <DecisionSummary key={decision.id} decision={decision} resolve={resolve} />) : <p className="text-small text-muted-foreground">No past decisions.</p>}{model.counts.historicalDecisions > model.historicalDecisions.length ? <button type="button" className={cn(linkClass, "mt-2")} onClick={onArguments}>Full history · {model.counts.historicalDecisions}<ArrowRightIcon className="size-3" /></button> : null}</div> : null}
            </section>
            <section className="min-w-0 border-t border-border/70 pt-3 @xl:col-span-2 @3xl:col-span-1">
              <h2 className="text-small font-semibold text-muted-foreground">Team</h2>
              <div className="mt-2 grid gap-1 @xl:grid-cols-2 @3xl:grid-cols-1">{model.team.map(agent => {
                const stateLabel = snap.presence[agent.id] === "native" ? "Own session" : ({ working: "Working", queued: "Queued", idle: "Ready", error: "Needs attention", interrupted: "Stopped" }[agent.state]);
                const detail = agent.activity ?? ({ working: "Working on the task", queued: "Waiting for a turn", idle: "Waiting for new context", error: "Turn failed", interrupted: "Turn interrupted" }[agent.state]);
                return <button key={agent.id} type="button" onClick={() => openSession(agent.id)} aria-label={`Open ${agent.label}'s session: ${stateLabel}`} title={detail} className="flex min-h-10 min-w-0 items-start gap-2 rounded-lg px-1 py-2 text-left transition hover:bg-accent">
                  <Avatar handle={agent.id} size={22} /><span className="min-w-0 flex-1"><span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1"><span className="text-small font-semibold [overflow-wrap:anywhere]">{agent.label}</span><span className={cn("rounded-md px-1.5 py-0.5 text-meta", agent.state === "working" ? "bg-add/50 text-add-ink" : agent.state === "error" ? "bg-destructive-soft text-destructive" : "bg-secondary text-muted-foreground")}>{stateLabel}</span></span>{agent.activity ? <span className="mt-1 block text-small text-muted-foreground [overflow-wrap:anywhere]">{agent.activity}</span> : null}</span>
                </button>;
              })}{!model.team.length ? <p className="text-small text-muted-foreground">No agents in the room yet.</p> : null}</div>
            </section>
          </aside>
        </div>
        {beside ? <SteeringField disabled={disabled || !!pending} roomId={room.id} send={text => perform("steering", "/messages", { text }, "Direction added to the shared conversation. Agents will receive it in their context.")} /> : null}
      </div>
      <Dialog open={contextOpen} onOpenChange={setContextOpen}><DialogContent className="max-h-[80vh] overflow-y-auto [overflow-wrap:anywhere]" onCloseAutoFocus={event => { event.preventDefault(); if (contextTrigger.current?.isConnected) contextTrigger.current.focus({ preventScroll: true }); }}><DialogHeader><DialogTitle>{context?.title}</DialogTitle><DialogDescription>{context?.text}</DialogDescription></DialogHeader><ul className="flex flex-col gap-3">{context?.refs.map(ref => <li key={ref.id} className="rounded-xl border border-border p-3"><WorkSources refs={[ref]} onNavigate={() => setContextOpen(false)} /><p className="mt-2 text-small text-muted-foreground">{ref.kind === "missing" ? "This source is no longer available." : ref.text ?? "Open related context"}</p>{ref.by ? <div className="mt-1 text-meta text-faint"><Name handle={ref.by} /></div> : null}</li>)}</ul>{!context?.refs.length ? <p className="text-small text-muted-foreground">No related sources yet.</p> : null}</DialogContent></Dialog>
    </div>
  );
}

function DecisionSummary({ decision, resolve, disabled = true, reopening = false, reopen }: { decision: WorkDecision; resolve: (id: string) => WorkRef; disabled?: boolean; reopening?: boolean; reopen?: () => void }) {
  return <div className="mb-3 last:mb-0"><p className="text-small leading-snug font-medium [overflow-wrap:anywhere]">{decision.title}</p>{decision.note ? <p className="mt-1 line-clamp-2 text-meta text-muted-foreground [overflow-wrap:anywhere]" title={decision.note}>{decision.note}</p> : null}<div className="mt-1 flex flex-wrap items-center gap-1.5 text-meta text-muted-foreground"><Name handle={decision.by} /> · {decision.human ? "Chosen by the human" : "Agent decision"}{!decision.current ? <span>· no longer current</span> : null}<WorkSources refs={[resolve(decision.id)]} />{decision.current && reopen ? <Button size="xs" variant="ghost" disabled={disabled} onClick={reopen} className="text-muted-foreground" title="Reopen this choice for review. The previous decision stays in history.">{reopening ? "Reopening…" : "Reopen"}</Button> : null}</div></div>;
}

function SteeringField({ disabled, roomId, send }: { disabled: boolean; roomId: string; send: (text: string) => Promise<boolean> }) {
  const key = `table.steer.${roomId}`;
  const [text, setText] = useState(() => local.get(key) ?? "");
  useEffect(() => { setText(local.get(key) ?? ""); }, [key]);
  const submit = async (event: FormEvent) => { event.preventDefault(); const value = text.trim(); if (!value || disabled) return; if (await send(value)) { setText(""); local.set(key, null); } };
  return <form className="sticky bottom-0 -mx-3 border-t border-border bg-canvas/95 px-3 pt-3 pb-1 backdrop-blur-sm" onSubmit={submit}>
    <label htmlFor={`table-steer-${roomId}`} className="mb-2 block text-small font-medium">Give the team direction</label>
    <div className="flex items-center gap-2"><Input id={`table-steer-${roomId}`} value={text} maxLength={10000} disabled={disabled} placeholder="What should change or be checked next?" onChange={event => { setText(event.target.value); local.set(key, event.target.value || null); }} className="min-w-0 bg-card" /><Button type="submit" size="icon" disabled={disabled || !text.trim()} aria-label="Send direction to the team"><ArrowUpIcon className="size-4" /></Button></div>
    <p className="mt-1.5 text-meta text-muted-foreground">Shared context · mention an @agent to address them</p>
  </form>;
}
