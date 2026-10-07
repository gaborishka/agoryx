import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ChevronDownIcon, CircleHelpIcon, FootprintsIcon, LightbulbIcon, LoaderCircleIcon, PinIcon, Settings2Icon, SlidersHorizontalIcon, SparklesIcon, SquareIcon, XIcon } from "lucide-react";
import { create } from "zustand";
import { useEffect, useRef, useState } from "react";
import { tableAssistRequests } from "@agora/table-assist";
import { tableAssistRetry } from "@agora/table-assist-retry";
import type { TableAssistKind } from "@agora/types";
import { Name } from "@/components/room/bits";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { local } from "@/lib/api";
import { requestNonce } from "@/lib/request-nonce";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { createWorkRefResolver } from "@agora/work-table";
import { WorkSources } from "./AgentComponent";

const ACTIONS = {
  tool: { label: "Create a tool", prepared: "Interactive tool ready", verb: "create an interactive tool", Icon: SlidersHorizontalIcon },
  question: { label: "Find questions", prepared: "Question review ready", verb: "find questions", Icon: CircleHelpIcon },
  options: { label: "Explore options", prepared: "Options ready for review", verb: "explore options", Icon: LightbulbIcon },
  conclusion: { label: "Summarize findings", prepared: "Findings summarized", verb: "summarize findings", Icon: PinIcon },
  steps: { label: "Plan next steps", prepared: "Next steps prepared", verb: "plan next steps", Icon: FootprintsIcon },
} as const;
const TOOL_PRESETS = [
  { label: "Explore scenarios", guidance: "Build a what-if tool with the few inputs that matter, clear assumptions, and outcomes that update as I change them." },
  { label: "Compare options", guidance: "Compare the actual alternatives side by side on the same criteria. Make tradeoffs and missing evidence visible." },
  { label: "Explain a process", guidance: "Make the current process easy to understand with clear stages, a timeline, and expandable detail where useful." },
  { label: "Browse evidence", guidance: "Organize the available evidence into a searchable, sortable table with source references and explicit gaps." },
] as const;
type Request = { kind: TableAssistKind; agent: string; target?: string; guidance?: string; nonce: string };
type Choice = Pick<Request, "kind" | "agent" | "guidance">;
type UI = { agent?: string; guidance?: string; choosing?: Choice; pending?: Request; error?: string; dismissed?: string };
const EMPTY: UI = {};
const useAssistUI = create<Record<string, UI>>(() => ({}));
const update = (id: string, patch: Partial<UI>) => useAssistUI.setState(state => ({ [id]: { ...state[id], ...patch } }));
const pendingKey = (id: string) => `table.assist.pending.${id}`;
const selectedAgent = (id: string, agents: Array<{ id: string }>, ui: UI) => {
  const preferred = ui.agent ?? local.get(`table.assist.agent.${id}`);
  return agents.find(agent => agent.id === preferred)?.id ?? agents[0]?.id ?? "";
};
const recovered = (id: string): Request | undefined => {
  try {
    const value = JSON.parse(local.get(pendingKey(id)) ?? "null") as Request | null;
    return value && Object.hasOwn(ACTIONS, value.kind) && typeof value.agent === "string" && typeof value.nonce === "string" && (value.target === undefined || typeof value.target === "string") && (value.guidance === undefined || typeof value.guidance === "string") ? value : undefined;
  } catch { return undefined; }
};
const openConversation = () => {
  useStore.getState().setView("chat");
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea[data-composer]')?.focus());
};
const focusAction = () => {
  requestAnimationFrame(() => (document.querySelector<HTMLElement>('[data-table-assist-options]:not(:disabled)') ?? document.querySelector<HTMLElement>('[data-table-assist-menu]') ?? document.querySelector<HTMLElement>('[data-table-assist-status]'))?.focus());
};
const cancelChoice = (id: string) => { update(id, { choosing: undefined }); focusAction(); };

/** A click records intent. The agent authors the result; the shell never fabricates one. */
async function request(kind: TableAssistKind, target?: string, retry?: Request, choice?: Choice) {
  const { snap, connection, post } = useStore.getState();
  if (!snap || !snap.driven || connection !== "live") return;
  const room = snap.state;
  const ui = useAssistUI.getState()[room.id] ?? EMPTY;
  const requests = tableAssistRequests(room, snap.ops);
  const waiting = ui.pending ?? recovered(room.id);
  if (!retry && waiting && !requests.some(item => item.nonce === waiting.nonce)) return;
  if (ui.pending && !ui.error || requests.some(item => item.status === "queued" || item.status === "running")) return;
  const agent = retry?.agent ?? choice?.agent ?? selectedAgent(room.id, room.agents, ui);
  if (!agent) { useStore.getState().openDialog({ kind: "agents" }); return; }
  const guidance = choice ? choice.guidance : ui.guidance?.trim();
  if (!retry && kind === "options" && !target) {
    const open = room.table.questions.filter(question => question.status === "open");
    if (open.length > 1) { update(room.id, { choosing: { kind, agent, ...(guidance ? { guidance } : {}) }, error: undefined, dismissed: undefined }); return; }
    if (open.length === 1) target = open[0]!.id;
  }
  const payload: Request = retry ?? { kind, agent, ...(target ? { target } : {}), ...(guidance ? { guidance } : {}), nonce: requestNonce() };
  update(room.id, { pending: payload, error: undefined, choosing: undefined, dismissed: undefined });
  local.set(pendingKey(room.id), JSON.stringify(payload));
  if (choice) focusAction();
  try {
    await post("/table-assist", payload);
    // SSE can confirm this request before HTTP returns. A later request owns its own recovery state.
    if (useAssistUI.getState()[room.id]?.pending?.nonce === payload.nonce) update(room.id, { pending: undefined, error: undefined });
    if (recovered(room.id)?.nonce === payload.nonce) local.set(pendingKey(room.id), null);
  } catch (error) {
    if (useAssistUI.getState()[room.id]?.pending?.nonce === payload.nonce) update(room.id, { error: error instanceof Error ? error.message : String(error) });
  }
}

function retryAttempt(previous: Request) {
  const snap = useStore.getState().snap;
  if (!snap) return;
  try {
    const next = tableAssistRetry(previous, requestNonce(), snap.state.agents);
    void request(next.kind, next.target, next);
  } catch (error) {
    update(snap.state.id, { error: error instanceof Error ? error.message : String(error) });
  }
}

export function TableAssistButton({ kind, target, onRequested }: { kind: TableAssistKind; target?: string; onRequested?: () => void }) {
  const [toolOpen, setToolOpen] = useState(false);
  const [toolFocus, setToolFocus] = useState("");
  const [toolAgent, setToolAgent] = useState("");
  const snap = useStore(state => state.snap);
  const connection = useStore(state => state.connection);
  const ui = useAssistUI(state => snap ? state[snap.state.id] ?? EMPTY : EMPTY);
  useEffect(() => { setToolOpen(false); }, [snap?.state.id, target]);
  if (!snap?.driven) return null;
  const room = snap.state;
  const requests = tableAssistRequests(room, snap.ops);
  const waiting = ui.pending ?? recovered(room.id);
  const busy = !!ui.pending && !ui.error || !!waiting && !requests.some(item => item.nonce === waiting.nonce) || requests.some(item => item.status === "queued" || item.status === "running");
  const agent = selectedAgent(room.id, room.agents, ui);
  const { label: defaultLabel, verb, Icon } = ACTIONS[kind];
  const label = kind === "tool" && target ? "Refine tool" : defaultLabel;
  const owner = room.table.components?.find(c => c.id === target)?.by;
  const defaultAuthor = kind === "tool" && room.agents.some(a => a.id === owner) ? owner! : agent;
  const name = room.agents.find(item => item.id === defaultAuthor)?.label;
  return <><Button variant="outline" size="sm" data-table-assist-options={kind === "options" && !target ? "" : undefined} aria-label={target ? `${label} for ${target}${name ? ` with ${name}` : ""}` : undefined} className="h-auto min-h-8 max-w-full rounded-lg bg-card py-1.5 text-small whitespace-normal text-left pointer-coarse:min-h-11" disabled={connection !== "live" || busy} onClick={() => { if (kind === "tool") { if (!agent) { useStore.getState().openDialog({ kind: "agents" }); return; } setToolAgent(defaultAuthor); setToolFocus(ui.guidance ?? ""); setToolOpen(true); } else { onRequested?.(); void request(kind, target); } }} title={name ? `${name} will ${verb} using this room's context${target ? ` and ${target}` : ""}.` : "Add an agent to prepare this from context."}>
    <Icon className="size-3.5 shrink-0" />{label}
  </Button><Dialog open={toolOpen} onOpenChange={setToolOpen}><DialogContent className="max-w-lg"><DialogHeader><DialogTitle>{target ? "Refine this tool" : "An interface for this moment"}</DialogTitle><DialogDescription>{target ? "Tell the agent how this tool could better support the task." : "Your agent will compose a tool from the conversation. Explore a scenario, compare alternatives, or make a complex idea tangible."}</DialogDescription></DialogHeader>
    <label className="space-y-2 text-small font-medium">What would help right now?<textarea aria-label="Describe your tool" autoFocus value={toolFocus} maxLength={2000} onChange={e => setToolFocus(e.target.value)} placeholder="For example: let me vary team size and scope to compare delivery scenarios…" className="mt-2 min-h-28 w-full resize-y rounded-xl border border-input bg-background p-3 text-ui font-normal" /></label>
    {!target ? <div className="flex flex-wrap gap-2">{TOOL_PRESETS.map(example => <button key={example.label} type="button" onClick={() => setToolFocus(example.guidance)} className="rounded-lg border border-border px-2.5 py-2 text-meta text-muted-foreground hover:bg-accent">{example.label}</button>)}</div> : null}
    <div className="flex flex-wrap items-end justify-between gap-3"><label className="flex flex-col gap-1.5 text-small text-muted-foreground">Build with<select aria-label="Tool author" value={room.agents.some(a => a.id === toolAgent) ? toolAgent : agent} onChange={e => setToolAgent(e.target.value)} className="h-9 rounded-lg border border-input bg-background px-2 text-foreground">{room.agents.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}</select></label><Button disabled={connection !== "live" || busy || !agent} onClick={() => { setToolOpen(false); onRequested?.(); void request("tool", target, undefined, { kind: "tool", agent: room.agents.some(a => a.id === toolAgent) ? toolAgent : agent, guidance: toolFocus.trim() }); }}><SparklesIcon className="size-4" />{target ? "Ask for changes" : "Create tool"}</Button></div>
    <p className="text-meta text-muted-foreground">{target ? <>Scope: <span className="font-mono">{target}</span>{room.table.components?.find(c => c.id === target)?.title ? ` · ${room.table.components.find(c => c.id === target)!.title}` : ""}</> : "Built from room context · results stay on the table"}</p>
    {target && owner && toolAgent && toolAgent !== owner ? <p className="text-meta text-muted-foreground">This agent will create a linked alternative. Only the original author can refine the existing tool in place.</p> : null}
  </DialogContent></Dialog></>;
}

export function TableAssistActions({ compact = false, onRequested }: { compact?: boolean; onRequested?: () => void }) {
  const snap = useStore(state => state.snap);
  const ui = useAssistUI(state => snap ? state[snap.state.id] ?? EMPTY : EMPTY);
  const [open, setOpen] = useState(false);
  if (!snap?.driven) return null;
  const room = snap.state;
  const agent = selectedAgent(room.id, room.agents, ui);
  if (compact) return <Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild><Button data-table-assist-menu="" size="sm" variant="outline"><SparklesIcon className="size-3.5" />Ask agents<ChevronDownIcon className="size-3" /></Button></PopoverTrigger><PopoverContent align="end" className="w-80 max-w-[calc(100vw-24px)] rounded-xl p-4" onCloseAutoFocus={event => { if (useAssistUI.getState()[room.id]?.choosing) event.preventDefault(); }}><p className="mb-3 text-small font-semibold">What should the agent prepare?</p><TableAssistActions onRequested={() => setOpen(false)} /></PopoverContent></Popover>;
  return <div className="flex max-w-full flex-wrap items-center gap-1.5" aria-label="Ask agents to prepare table content">
    {(Object.keys(ACTIONS) as TableAssistKind[]).map(kind => <TableAssistButton key={kind} kind={kind} onRequested={onRequested} />)}
    <Popover><PopoverTrigger asChild><Button variant="ghost" size="sm" aria-label="Adjust agent requests" title="Choose the agent or add optional focus" className="max-w-full text-meta text-muted-foreground"><Settings2Icon className="size-3.5" />{agent ? <>With <Name handle={agent} /></> : "Add an agent"}</Button></PopoverTrigger><PopoverContent align="end" className="w-80 max-w-[calc(100vw-24px)] space-y-3 rounded-xl p-4">
      <p className="text-small font-medium">Prepared from this room's context</p>
      {room.agents.length ? <label className="flex flex-col gap-1.5 text-small">Agent<select aria-label="Agent for table requests" value={agent} onChange={event => { update(room.id, { agent: event.target.value }); local.set(`table.assist.agent.${room.id}`, event.target.value); }} className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-ui">{room.agents.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label> : <Button size="sm" onClick={() => useStore.getState().openDialog({ kind: "agents" })}>Add an agent</Button>}
      <label className="flex flex-col gap-1.5 text-small">Optional focus<Input aria-label="Optional focus for table requests" placeholder="For example: simplicity or performance" value={ui.guidance ?? ""} onChange={event => update(room.id, { guidance: event.target.value })} maxLength={1000} /></label>
      <p className="text-meta text-muted-foreground">The agent prepares the content. You keep control of decisions and execution.</p>
    </PopoverContent></Popover>
  </div>;
}

/** Durable requests and real publications survive navigation and reconnecting. */
export function TableAssistActivity() {
  const snap = useStore(state => state.snap);
  const connection = useStore(state => state.connection);
  const ui = useAssistUI(state => snap ? state[snap.state.id] ?? EMPTY : EMPTY);
  const picker = useRef<HTMLElement>(null);
  useEffect(() => { if (ui.choosing) picker.current?.focus(); }, [ui.choosing]);
  useEffect(() => {
    if (!snap) return;
    const pending = ui.pending ?? recovered(snap.state.id);
    if (pending && snap.state.messages.some(message => message.tableAssist?.nonce === pending.nonce)) {
      if (recovered(snap.state.id)?.nonce === pending.nonce) local.set(pendingKey(snap.state.id), null);
      if (useAssistUI.getState()[snap.state.id]?.pending?.nonce === pending.nonce) update(snap.state.id, { pending: undefined, error: undefined });
    }
  }, [snap, ui.pending, ui.error]);
  if (!snap) return null;
  const room = snap.state;
  const requests = [...tableAssistRequests(room, snap.ops)].sort((a, b) => b.requestSeq - a.requestSeq);
  const latest = requests[0];
  const waiting = ui.pending ?? recovered(room.id);
  const unconfirmed = waiting && !requests.some(item => item.nonce === waiting.nonce) ? waiting : undefined;
  const usable = snap.driven && connection === "live";
  const resolve = createWorkRefResolver(room);
  if (ui.choosing) return <section ref={picker} tabIndex={-1} className="rounded-xl border border-codex/20 bg-codex-soft/30 p-4" aria-label="Choose context for agent request">
    <div className="flex items-start justify-between gap-3"><div><h2 className="text-body font-semibold">Which question should we explore?</h2><p className="mt-1 text-small text-muted-foreground">Choose the context. <Name handle={ui.choosing.agent} /> will prepare alternatives.</p></div><Button variant="ghost" size="icon-sm" aria-label="Cancel question selection" onClick={() => cancelChoice(room.id)}><XIcon className="size-4" /></Button></div>
    {!room.agents.some(agent => agent.id === ui.choosing!.agent) ? <p role="alert" className="mt-2 text-small text-muted-foreground">The selected agent is no longer in this room. Cancel and choose a current agent.</p> : null}
    <div className="mt-3 flex flex-col gap-2">{room.table.questions.filter(item => item.status === "open").map(question => <Button key={question.id} variant="outline" className="h-auto min-h-10 justify-start py-2 text-left whitespace-normal [overflow-wrap:anywhere]" disabled={!usable || !room.agents.some(agent => agent.id === ui.choosing!.agent)} onClick={() => void request("options", question.id, undefined, ui.choosing)}><span className="font-mono text-meta text-muted-foreground">{question.id}</span>{question.text}</Button>)}<Button variant="ghost" size="sm" className="self-start" onClick={() => cancelChoice(room.id)}>Cancel</Button></div>
  </section>;
  if (unconfirmed) return <section data-table-assist-status="" tabIndex={-1} className="rounded-xl border border-border bg-card p-3.5" aria-label="Agent request status" aria-live="polite">
    <div className="flex flex-wrap items-center gap-2"><LoaderCircleIcon className={cn("size-4 text-muted-foreground", !!ui.pending && !ui.error && "animate-spin")} /><h2 className="text-small font-semibold">{ui.error || !ui.pending ? "Request not confirmed" : "Sending request…"}</h2><Name handle={unconfirmed.agent} className="text-small" /></div>
    <p className="mt-1 text-meta text-muted-foreground">{ACTIONS[unconfirmed.kind].label} · {unconfirmed.target ? `for ${unconfirmed.target}` : "from room context"}</p>
    {ui.error || !ui.pending ? <><p role="alert" className="mt-2 text-small text-muted-foreground">{ui.error ?? "Reconnect and check this request. Retrying keeps the same agent, scope and request identity."}</p><div className="mt-3 flex flex-wrap gap-2"><Button size="sm" disabled={!usable} title="Retry the same request with its original agent and context." onClick={() => void request(unconfirmed.kind, unconfirmed.target, unconfirmed)}>Retry request</Button><Button size="sm" variant="ghost" onClick={openConversation}>Open conversation</Button><Button size="sm" variant="ghost" onClick={() => { update(room.id, { pending: undefined, error: undefined }); local.set(pendingKey(room.id), null); }}>Dismiss</Button></div></> : null}
  </section>;
  if (!latest || ui.dismissed === latest.id) return null;
  const active = latest.status === "queued" || latest.status === "running";
  const problem = ["partial", "failed", "interrupted", "no-output", "unavailable"].includes(latest.status);
  const title = latest.status === "ready" ? ACTIONS[latest.kind].prepared : latest.status === "running" ? `${ACTIONS[latest.kind].label} · in progress` : latest.status === "queued" ? `${ACTIONS[latest.kind].label} · queued` : latest.status === "partial" ? "Some results were published before the turn stopped" : latest.status === "interrupted" ? "Request interrupted" : latest.status === "unavailable" ? "The requested agent is unavailable" : latest.status === "failed" ? "The agent could not finish this request" : "The turn ended without a table result";
  const refs = latest.refs.map(id => resolve(id));
  const available = refs.filter(ref => ref.kind !== "missing");
  const response = latest.turnId ? room.turns.find(turn => turn.id === latest.turnId)?.messageId : undefined;
  return <section data-table-assist-status="" tabIndex={-1} className={cn("rounded-xl border p-3.5", problem ? "border-amber/20 bg-amber-soft/30" : "border-border bg-card/60")} aria-label="Agent request status" aria-live="polite">
    <div className="flex flex-wrap items-start gap-2"><span className="mt-0.5 text-muted-foreground">{active ? <LoaderCircleIcon className="size-4 animate-spin" /> : <SparklesIcon className="size-4" />}</span><div className="min-w-0 flex-1"><h2 className="text-small font-semibold [overflow-wrap:anywhere]">{title}</h2><p className="mt-1 flex flex-wrap items-center gap-1.5 text-meta text-muted-foreground"><Name handle={latest.agent} />{latest.target ? <>· for {latest.target}</> : " · from room context"}{latest.status === "ready" ? " · prepared for review" : null}</p></div>{!active ? <Button size="icon-sm" variant="ghost" aria-label="Dismiss agent request status" onClick={() => update(room.id, { dismissed: latest.id })}><XIcon className="size-3.5" /></Button> : null}</div>
    {latest.status === "queued" ? <p className="mt-2 text-small text-muted-foreground">Waiting for the agent's next room turn.</p> : null}
    {latest.guidance ? <p className="mt-2 line-clamp-3 text-small text-muted-foreground [overflow-wrap:anywhere]" title={latest.guidance}>{latest.guidance}</p> : null}
    {latest.error ? <p className="mt-2 text-small text-muted-foreground">{latest.error}</p> : null}
    {ui.error ? <p role="alert" className="mt-2 text-small text-destructive">{ui.error}</p> : null}
    {refs.length ? <div className="mt-3 flex flex-wrap items-center gap-2"><WorkSources refs={refs} />{available.length ? <Button size="sm" variant="ghost" onClick={() => useStore.getState().goToRef(available.find(ref => ref.id.startsWith("W"))?.id ?? available[0]!.id)}>Show results</Button> : <span className="text-small text-muted-foreground">These results are no longer on the current table.</span>}</div> : null}
    <div className="mt-2 flex flex-wrap gap-2">{active ? <Button size="sm" variant="ghost" disabled={!usable} title="Stops all active and queued work in this room." onClick={() => void useStore.getState().post("/stop").catch(error => update(room.id, { error: String(error) }))}><SquareIcon className="size-3" />Stop run</Button> : problem ? <>{response ? <Button size="sm" variant="ghost" onClick={() => useStore.getState().goToRef(`m-${response}`)}>Read response</Button> : null}<Button size="sm" variant="outline" disabled={!usable || !room.agents.some(agent => agent.id === latest.agent)} title="Start a new attempt with the same agent, scope and instructions." onClick={() => retryAttempt(latest)}>Try again</Button></> : null}</div>
    {problem && !room.agents.some(agent => agent.id === latest.agent) ? <p role="alert" className="mt-2 text-small text-muted-foreground">The original agent is no longer in this room. Start a new request to choose another agent.</p> : null}
    {requests.length > 1 ? <details className="mt-2 text-small text-muted-foreground"><summary className="cursor-pointer py-1">Request history · {requests.length - 1}</summary><ul className="mt-2 max-h-72 space-y-2 overflow-y-auto">{requests.slice(1).map(item => <li key={item.id} className="flex flex-wrap items-center gap-1.5"><span>{ACTIONS[item.kind].label}</span>· <Name handle={item.agent} />· <span>{item.status === "ready" ? "Prepared" : item.status === "no-output" ? "No table result" : item.status}</span>{item.refs.length ? <WorkSources refs={item.refs.map(id => resolve(id))} /> : null}</li>)}</ul></details> : null}
  </section>;
}
