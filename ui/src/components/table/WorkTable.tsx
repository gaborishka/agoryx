import { ArrowRightIcon, ArrowUpIcon, CheckIcon, ChevronDownIcon, CircleHelpIcon, HistoryIcon, LayoutPanelTopIcon, LoaderCircleIcon, MessageSquareIcon, PlayIcon, PlusIcon, SquareIcon, WifiOffIcon } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { workTableView, workRef, type WorkComponentView, type WorkDecision, type WorkEvent, type WorkRef } from "@agora/work-table";
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

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const linkClass = "inline-flex min-h-7 items-center gap-1 text-small text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";
const eventLabels: Record<WorkEvent["kind"], string> = { decision: "Рішення", question: "Питання", reopened: "Перегляд", review: "До перевірки", done: "Завершено", objection: "Зауваження", fact: "Факт", conclusion: "Висновок", concession: "Позицію змінено", artifact: "Результат", component: "Компонент", error: "Помилка", run: "Запуск", workspace: "Робочий простір", pr: "Pull request", direction: "Напрямок" };

/** The table's first look is the state of work. The full argument remains one action away. */
export function WorkTable({ beside, onArguments }: { beside: boolean; onArguments: () => void }) {
  const snap = useStore(s => s.snap);
  const connection = useStore(s => s.connection);
  const post = useStore(s => s.post);
  const flash = useStore(s => s.flash);
  const openDialog = useStore(s => s.openDialog);
  const setView = useStore(s => s.setView);
  const goToRef = useStore(s => s.goToRef);
  const openSession = useStore(s => s.openSession);
  const room = snap?.state;
  const model = useMemo(() => room ? workTableView(room, snap?.events ?? [], snap?.ops ?? []) : null, [room, snap?.events, snap?.ops]);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deferredQ, setDeferredQ] = useState<string | null>(null);
  const [context, setContext] = useState<{ title: string; refs: WorkRef[]; text?: string } | null>(null);
  const [allComponents, setAllComponents] = useState(false);
  const [history, setHistory] = useState(false);
  const [archivesOpen, setArchivesOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const pendingRef = useRef(false);
  useEffect(() => { setPending(null); setError(null); setNotice(null); setDeferredQ(null); setAllComponents(false); setHistory(false); setArchivesOpen(false); }, [room?.id]);
  useEffect(() => {
    if (!flash || (!flash.ref.startsWith("W") && flash.ref !== "brief")) return;
    if (flash.ref.startsWith("W")) { setAllComponents(true); setArchivesOpen(true); }
    // A folded card opens in the same render. No shared scroll position changes until then.
    const timer = setTimeout(() => {
      const node = host.current?.querySelector<HTMLElement>(flash.ref === "brief" ? "#table-headsup" : `#component-${CSS.escape(flash.ref)}`);
      node?.scrollIntoView({ behavior: "smooth", block: "center" });
      if (node) { node.classList.remove("animate-flash"); void node.offsetWidth; node.classList.add("animate-flash"); }
    }, 60);
    return () => clearTimeout(timer);
  }, [flash]);
  if (!snap || !room || !model) return null;
  const disabled = !snap.driven || connection !== "live";
  const attention = model.headsUp.awaiting;
  const working = model.runtime.status === "working" || model.runtime.status === "active";
  const canContinue = model.runtime.status === "stopped" || model.runtime.status === "budget" || model.runtime.status === "quiet";
  const runLabel = model.runtime.status === "working" ? `${model.runtime.working} ${model.runtime.working === 1 ? "агент працює" : "агенти працюють"}` : ({ active: "Робота триває", quiet: "Агенти завершили свої ходи", stopped: "Зупинено", budget: "Досягнуто ліміт ходів", idle: "Готові почати" }[model.runtime.status] ?? "Робота триває");
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
  const choose = (option: TableOption) => { void perform(option.id, "/table", { op: "decide", target: option.id }, "Рішення зафіксовано. Агенти побачать його у спільному контексті."); };
  const action = { pending, disabled, choose };
  const components = allComponents ? model.components : model.components.slice(0, 2);
  const archived = (room.table.components ?? []).filter(component => component.archived);
  const focusComposer = () => { const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]'); input?.focus(); };
  const authored = model.headsUp.source === "authored";
  return (
    <div ref={host} className="scroll-thin @container min-h-0 flex-1 overflow-y-auto bg-canvas" data-work-table>
      <div className={cn("mx-auto flex w-full max-w-[1320px] flex-col gap-5 px-3 pb-6", beside ? "pt-3" : "pt-5 @sm:px-6")}>
        <header className="flex flex-wrap items-center gap-2.5">
          <h1 className="mr-auto flex items-center gap-2 font-display text-display leading-tight font-semibold"><LayoutPanelTopIcon className="size-5 text-muted-foreground" />На столі</h1>
          <Button size="sm" variant="ghost" onClick={onArguments} className="text-muted-foreground"><MessageSquareIcon className="size-3.5" />Аргументи</Button>
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => openDialog({ kind: "table-form", op: "ask" })}><PlusIcon className="size-3.5" />Питання</Button>
        </header>
        {connection !== "live" || !snap.driven ? <p className="flex items-start gap-2 rounded-xl bg-secondary px-3 py-2 text-small text-muted-foreground" role="status"><WifiOffIcon className="mt-0.5 size-3.5 shrink-0" />{!snap.driven ? "Режим перегляду: цією кімнатою керує інший процес." : connection === "offline" ? "Немає зв’язку. Показано останній отриманий стан; дії стануть доступні після підключення." : "Оновлюємо зв’язок. Показано останній отриманий стан."}</p> : null}
        <section id="table-headsup" className="scroll-mt-4 border-b border-border pb-5" aria-labelledby="work-headsup">
          <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
            <h2 id="work-headsup" className="text-small font-semibold text-muted-foreground">HEADS-UP</h2>
            <button className={linkClass} type="button" onClick={() => setContext({ title: "На чому ґрунтується огляд", refs: model.headsUp.refs, text: authored ? `Огляд від ${model.headsUp.by ?? "агента"}, станом на подію #${model.headsUp.asOfSeq}.` : "Огляд сформовано з поточного стану кімнати: ходів, питань, рішень і результатів." })}>
              {authored ? <><Name handle={model.headsUp.by ?? "agoryx"} /> · </> : null}{model.headsUp.stale ? "Є нові події · джерела" : "Джерела"}<ArrowRightIcon className="size-3" />
            </button>
          </div>
          <p className="max-w-[760px] text-lead leading-relaxed text-pretty tracking-tight @sm:text-title">{model.headsUp.now}</p>
          {authored && model.headsUp.changes.length ? <ul className="mt-3 flex max-w-[760px] flex-col gap-1.5 text-small text-muted-foreground">{model.headsUp.changes.slice(0, 3).map((change, index) => <li key={index} className="flex items-start gap-2"><span className="mt-2 size-1 shrink-0 rounded-full bg-current" /><span className="line-clamp-2">{change}</span></li>)}</ul> : null}
          {model.headsUp.stale ? <p className="mt-2 text-small text-amber">Огляд потребує оновлення. Поточні події й рішення нижче вже актуальні.</p> : null}
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-small text-muted-foreground">
            {model.headsUp.next ? <span className="inline-flex items-start gap-1.5"><ArrowRightIcon className="mt-0.5 size-3.5 shrink-0" />Далі: {model.headsUp.next}</span> : null}
            <span className={cn("rounded-lg px-2 py-1 text-meta", attention && deferredQ !== attention.q ? "bg-amber-soft text-amber" : "bg-secondary text-muted-foreground")}>
              {attention ? deferredQ === attention.q ? "Рішення відкладено" : "Потрібне твоє рішення" : "Нових питань до тебе немає"}
            </span>
            {!attention && model.counts.openQuestions ? <button type="button" className={linkClass} onClick={onArguments}>Відкриті питання: {model.counts.openQuestions}</button> : null}
          </div>
          <div className="mt-3.5 flex flex-wrap items-center gap-2">
            <span className="mr-auto inline-flex items-center gap-1.5 text-meta text-muted-foreground"><span className={cn("size-1.5 rounded-full", working ? "animate-breathe bg-add-ink" : "bg-faint")} />{runLabel}</span>
            {!beside ? <Button size="sm" variant="ghost" disabled={disabled} onClick={focusComposer}><ArrowUpIcon className="size-3.5" />Дати напрямок</Button> : null}
            {working || canContinue ? <Button size="sm" variant="outline" disabled={disabled || !!pending} title={working ? "Завершити поточний запуск і перервати активні ходи. Результати залишаться в кімнаті." : "Почати новий запуск із тим самим контекстом; це не відновлює перервану команду."}
              onClick={() => void perform("runtime", working ? "/stop" : "/continue", {}, working ? "Запуск зупинено; результати збережені." : "Надіслано запит продовжити роботу з поточним контекстом.")}>
              {pending === "runtime" ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : working ? <SquareIcon className="size-3 fill-current" /> : <PlayIcon className="size-3 fill-current" />}{pending === "runtime" ? "Передаємо…" : working ? "Зупинити" : "Продовжити"}
            </Button> : null}
          </div>
        </section>
        {error ? <p role="alert" className="rounded-xl border border-destructive/25 bg-destructive-soft px-3 py-2.5 text-small text-destructive">Не вдалося виконати дію: {error}. Можна повторити.</p> : null}
        {notice ? <p role="status" aria-live="polite" className="flex items-start gap-2 rounded-xl bg-add/50 px-3 py-2 text-small text-add-ink"><CheckIcon className="mt-0.5 size-3.5 shrink-0" />{notice}</p> : null}
        {model.warnings.filter(warning => !["stale_brief", "budget", "stopped"].includes(warning.code)).slice(0, 2).map(warning => <div key={`${warning.code}-${warning.ref ?? warning.by ?? ""}`} className="flex flex-wrap items-start gap-2 rounded-xl border border-amber/20 bg-amber-soft/50 px-3 py-2 text-small text-amber" role={warning.code === "agent_error" ? "alert" : "status"}>{warning.by ? <Name handle={warning.by} /> : null}<span className="min-w-0 flex-1 line-clamp-2">{warning.text}</span>{warning.ref ? <WorkSources refs={[workRef(room, warning.ref)]} /> : null}</div>)}
        <div className="grid items-start gap-5 @3xl:grid-cols-[minmax(0,1fr)_240px]">
          <div className="flex min-w-0 flex-col gap-4">
            {attention ? deferredQ === attention.q ? <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-border p-3 text-small text-muted-foreground"><CircleHelpIcon className="size-3.5" /><span className="min-w-0 flex-1 truncate">Відкладено: {attention.text}</span><Button size="xs" variant="ghost" onClick={() => setDeferredQ(null)}>Показати</Button></div> : (
              <section className="rounded-2xl border border-border bg-card p-4 shadow-soft" aria-labelledby="work-decision-title">
                <div className="flex flex-wrap items-center justify-between gap-2 text-meta"><span className="font-semibold text-amber">ПОТРІБНЕ ТВОЄ РІШЕННЯ</span><span className="font-mono text-muted-foreground">{attention.q}</span></div>
                <h2 id="work-decision-title" className="mt-2 text-title leading-snug font-semibold text-pretty">{attention.text}</h2>
                {attention.recommendation && !attention.stale ? <div className="mt-2 flex items-center gap-1.5 text-small text-muted-foreground"><Avatar handle={attention.by} size={18} /><Name handle={attention.by} /> рекомендує {attention.options.find(option => option.id === attention.recommendation)?.title ?? attention.recommendation}</div> : null}
                {attention.stale ? <p className="mt-2 text-small text-amber">Контекст запиту змінився. Нижче показано варіанти, які залишаються відкритими.</p> : null}
                <div className="mt-3 grid gap-2.5 @xl:grid-cols-2">
                  {attention.options.slice(0, 3).map(option => {
                    const recommended = option.id === attention.recommendation && !attention.stale;
                    return <div key={option.id} className={cn("flex min-w-0 flex-col rounded-xl border p-3", recommended ? "border-primary/40 bg-secondary/35" : "border-border")}>
                      <div className="flex items-center gap-1.5 text-meta text-muted-foreground"><Name handle={option.by} /><span className="ml-auto font-mono">{option.id}</span></div>
                      <h3 className="mt-1.5 text-body leading-snug font-semibold text-pretty">{option.title}</h3>
                      {option.body ? <Clamp max={75} more="Контекст"><Markdown text={option.body} className="mt-2 text-small text-muted-foreground" /></Clamp> : null}
                      <Button size="sm" variant={recommended ? "default" : "outline"} className="mt-3 self-start" disabled={disabled || !!pending} onClick={() => choose(option)}>
                        {pending === option.id ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : null}{pending === option.id ? "Записуємо…" : recommended ? "Обрати рекомендоване" : "Обрати"}
                      </Button>
                    </div>;
                  })}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                  <button type="button" className={linkClass} onClick={() => goToRef(attention.q)}>{attention.options.length > 3 ? `Усі ${attention.options.length} варіанти й аргументи` : "Аргументи й докази"}<ArrowRightIcon className="size-3" /></button>
                  {!attention.options.length ? <Button size="sm" variant="outline" disabled={disabled} onClick={() => openDialog({ kind: "table-form", op: "settle", q: attention.q })}>Записати відповідь</Button> : null}
                  <Button size="xs" variant="ghost" disabled={!!pending} onClick={() => setDeferredQ(attention.q)} className="ml-auto text-muted-foreground" title="Приховати це питання на час перегляду; робота й саме питання не зміняться.">На потім</Button>
                </div>
              </section>
            ) : null}
            {components.map(component => <AgentComponent key={component.id} component={component} room={room} action={action} archive={id => perform(`archive-${id}`, "/table", { op: "archive", target: id }, "Компонент архівовано. Його історія збережена.")} />)}
            {model.components.length > 2 ? <Button size="sm" variant="ghost" className="self-start text-muted-foreground" onClick={() => setAllComponents(!allComponents)}><ChevronDownIcon className={cn("size-3.5", allComponents && "rotate-180")} />{allComponents ? "Залишити головні результати" : `Показати решту · ${model.components.length - 2}`}</Button> : null}
            {!components.length ? <section className="rounded-2xl border border-dashed border-border p-5"><h2 className="text-body font-semibold">Результати з’являться тут</h2><p className="mt-1 max-w-lg text-small leading-relaxed text-muted-foreground">План, порівняння, перевірка чи власний компонент агентів — під поточну задачу.</p><Button size="sm" variant="ghost" onClick={() => setView("chat")} className="mt-3 -ml-2 text-muted-foreground"><MessageSquareIcon className="size-3.5" />Відкрити розмову</Button></section> : null}
            {archived.length ? <section className="border-t border-border/70 pt-3">
              <Button size="sm" variant="ghost" onClick={() => setArchivesOpen(!archivesOpen)} aria-expanded={archivesOpen} className="text-muted-foreground"><HistoryIcon className="size-3.5" />Архів компонентів · {archived.length}<ChevronDownIcon className={cn("size-3.5", archivesOpen && "rotate-180")} /></Button>
              {archivesOpen ? <div className="mt-3 flex flex-col gap-3">{archived.map(component => {
                const view: WorkComponentView = { ...component, refs: component.refs.map(id => workRef(room, id)), source: "authored", stale: false };
                return <div key={component.id}><AgentComponent component={view} room={room} action={{ ...action, disabled: true }} archived /><div className="mt-1.5 flex justify-end"><Button size="xs" variant="ghost" disabled={disabled || !!pending} onClick={() => void perform(`restore-${component.id}`, "/table", { op: "restore", target: component.id }, "Компонент повернуто на стіл.")}>{pending === `restore-${component.id}` ? "Повертаємо…" : "Повернути на стіл"}</Button></div></div>;
              })}</div> : null}
            </section> : null}
          </div>
          <aside className="grid min-w-0 gap-5 @xl:grid-cols-2 @3xl:grid-cols-1" aria-label="Команда, зміни й рішення">
            <section>
              <h2 className="text-small font-semibold text-muted-foreground">Хто над чим працює</h2>
              <div className="mt-3 flex flex-col gap-3.5">{model.team.map(agent => <button key={agent.id} type="button" onClick={() => openSession(agent.id)} className="flex min-w-0 items-start gap-2.5 text-left hover:text-primary">
                <Avatar handle={agent.id} size={25} /><span className="min-w-0"><span className="block text-small font-semibold">{agent.label}</span><span className="mt-0.5 block line-clamp-2 text-ui">{agent.activity ?? ({ working: "Працює над задачею", queued: "Чекає свого ходу", idle: "Очікує новий контекст", error: "Помилка під час ходу", interrupted: "Хід перервано" }[agent.state])}</span><span className="mt-1 block text-meta text-muted-foreground">{snap.presence[agent.id] === "native" ? "У власній сесії" : ({ working: "Працює", queued: "У черзі", idle: "Готовий", error: "Потрібна увага", interrupted: "Зупинено" }[agent.state])}</span></span>
              </button>)}{!model.team.length ? <p className="text-small text-muted-foreground">У кімнаті ще немає агентів.</p> : null}</div>
            </section>
            <section className="@3xl:border-t @3xl:border-border/70 @3xl:pt-4">
              <div className="flex items-center justify-between gap-2"><h2 className="text-small font-semibold text-muted-foreground">Важливі зміни</h2><button type="button" className={linkClass} onClick={() => setView("chat")}>Усі</button></div>
              <ol className="mt-2.5 flex flex-col gap-3">{model.events.map(event => <li key={`${event.kind}-${event.seq}-${event.ref ?? ""}`} className="border-l-2 border-border pl-2.5"><p className="line-clamp-3 text-small leading-relaxed">{event.text}</p><div className="mt-1 flex flex-wrap items-center gap-1.5 text-meta text-muted-foreground"><span>{event.kind === "error" && event.status === "interrupted" ? "Перервано" : event.kind === "component" && event.status === "archive" ? "Архівовано" : event.kind === "component" && event.status === "restore" ? "Повернуто" : eventLabels[event.kind]}</span>{event.by ? <><span>·</span><Name handle={event.by} /></> : null}{event.ts ? <span>· {ago(event.ts)}</span> : null}{event.ref ? <WorkSources refs={[workRef(room, event.ref)]} /> : null}</div></li>)}{!model.events.length ? <li className="text-small text-muted-foreground">Нових подій поки немає.</li> : null}</ol>
            </section>
            <section className="border-t border-border/70 pt-4 @xl:col-span-2 @3xl:col-span-1">
              <div className="flex items-center justify-between gap-2"><h2 className="text-small font-semibold text-muted-foreground">Чинні рішення</h2><Button variant="ghost" size="xs" onClick={() => setHistory(!history)} className="text-muted-foreground" aria-expanded={history}><HistoryIcon className="size-3" />Історія</Button></div>
              <div className="mt-3 flex flex-col gap-3">{model.decisions.slice(0, 3).map(decision => <DecisionSummary key={decision.id} decision={decision} roomId={room.id} disabled={disabled || !!pending} reopening={pending === `reopen-${decision.id}`} reopen={() => void perform(`reopen-${decision.id}`, "/table", { op: "reopen", target: decision.option }, "Вибір відкрито для перегляду. Попереднє рішення залишилося в історії.")} />)}{!model.decisions.length ? <p className="text-small text-muted-foreground">Рішення ще не зафіксовані.</p> : null}</div>
              {history ? <div className="mt-4 border-t border-border/70 pt-3"><h3 className="mb-2 text-meta font-semibold text-muted-foreground">Попередні рішення</h3>{model.historicalDecisions.length ? model.historicalDecisions.map(decision => <DecisionSummary key={decision.id} decision={decision} roomId={room.id} />) : <p className="text-small text-muted-foreground">Попередніх рішень немає.</p>}</div> : null}
            </section>
          </aside>
        </div>
        {beside ? <SteeringField disabled={disabled || !!pending} roomId={room.id} send={text => perform("steering", "/messages", { text }, "Вказівку додано до спільної розмови. Агенти отримають її у своєму контексті.")} /> : null}
      </div>
      <Dialog open={!!context} onOpenChange={open => !open && setContext(null)}><DialogContent className="max-h-[80vh] overflow-y-auto"><DialogHeader><DialogTitle>{context?.title}</DialogTitle><DialogDescription>{context?.text}</DialogDescription></DialogHeader><ul className="flex flex-col gap-3">{context?.refs.map(ref => <li key={ref.id} className="rounded-xl border border-border p-3"><WorkSources refs={[ref]} onNavigate={() => setContext(null)} /><p className="mt-2 text-small text-muted-foreground">{ref.kind === "missing" ? "Це джерело більше не доступне." : ref.text ?? "Відкрити пов’язаний контекст"}</p>{ref.by ? <div className="mt-1 text-meta text-faint"><Name handle={ref.by} /></div> : null}</li>)}</ul>{!context?.refs.length ? <p className="text-small text-muted-foreground">Поки що немає пов’язаних джерел.</p> : null}</DialogContent></Dialog>
    </div>
  );
}

function DecisionSummary({ decision, roomId, disabled = true, reopening = false, reopen }: { decision: WorkDecision; roomId: string; disabled?: boolean; reopening?: boolean; reopen?: () => void }) {
  const room = useStore(s => s.snap?.state);
  if (!room || room.id !== roomId) return null;
  return <div className="mb-3 last:mb-0"><p className="text-small leading-snug font-medium">{decision.title}</p>{decision.note ? <p className="mt-1 line-clamp-2 text-meta text-muted-foreground">{decision.note}</p> : null}<div className="mt-1 flex flex-wrap items-center gap-1.5 text-meta text-muted-foreground"><Name handle={decision.by} /> · {decision.human ? "Обрано людиною" : "Рішення агента"}{!decision.current ? <span>· переглянуто</span> : null}<WorkSources refs={[workRef(room, decision.id)]} />{decision.current && reopen ? <Button size="xs" variant="ghost" disabled={disabled} onClick={reopen} className="text-muted-foreground" title="Зняти цей вибір і відкрити його для перегляду; попереднє рішення залишиться в історії.">{reopening ? "Відкриваємо…" : "Переглянути"}</Button> : null}</div></div>;
}

function SteeringField({ disabled, roomId, send }: { disabled: boolean; roomId: string; send: (text: string) => Promise<boolean> }) {
  const key = `table.steer.${roomId}`;
  const [text, setText] = useState(() => local.get(key) ?? "");
  useEffect(() => { setText(local.get(key) ?? ""); }, [key]);
  const submit = async (event: FormEvent) => { event.preventDefault(); const value = text.trim(); if (!value || disabled) return; if (await send(value)) { setText(""); local.set(key, null); } };
  return <form className="sticky bottom-0 -mx-3 border-t border-border bg-canvas/95 px-3 pt-3 pb-1 backdrop-blur-sm" onSubmit={submit}>
    <label htmlFor={`table-steer-${roomId}`} className="mb-2 block text-small font-medium">Дати напрямок команді</label>
    <div className="flex items-center gap-2"><Input id={`table-steer-${roomId}`} value={text} maxLength={10000} disabled={disabled} placeholder="Що змінити чи перевірити далі?" onChange={event => { setText(event.target.value); local.set(key, event.target.value || null); }} className="min-w-0 bg-card" /><Button type="submit" size="icon" disabled={disabled || !text.trim()} aria-label="Передати вказівку команді"><ArrowUpIcon className="size-4" /></Button></div>
    <p className="mt-1.5 text-meta text-muted-foreground">Спільний контекст · можна адресувати @агенту</p>
  </form>;
}
