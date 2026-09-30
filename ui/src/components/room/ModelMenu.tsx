import { CheckIcon, ChevronDownIcon, ChevronRightIcon, ChevronsUpDownIcon, DotIcon, GaugeIcon } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { AgentModels, RoomAgent } from "@/lib/types";
import { modelSwitch } from "@/lib/effort";
import { ink, participant, type Seating } from "@/lib/room";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

export type ModelChange = { model?: string | null; effort?: string | null };

/**
 * One agent's model and effort, the one picker for the room's footer, the start screen and the session panel.
 * Like Claude Code's menu: a check on the current model, a digit 1–N picks one (while the search is empty),
 * effort as chips. The search also takes a model the list does not know, by its exact id.
 */
export function ModelMenu({
  agent,
  seating,
  models,
  onSet,
  className,
  disabled = false,
  working = false,
  side = "top",
  align = "end",
  variant = "quiet",
  onSession,
}: {
  agent: RoomAgent;
  seating: Seating;
  models: AgentModels | null;
  onSet: (change: ModelChange) => void;
  className?: string;
  disabled?: boolean;
  working?: boolean;
  side?: "top" | "bottom";
  align?: "start" | "end";
  /** quiet: a line of text in a toolbar; field: an outlined control, as in the session panel. */
  variant?: "quiet" | "field";
  /** Opens the agent's session; absent where there is no session yet. */
  onSession?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const kind = models?.[agent.kind];
  const choices = kind?.models ?? [];
  const model = choices.find((m) => m.id === agent.model);
  const levels = model?.efforts ?? kind?.efforts ?? [];
  const defaultEffort = model?.defaultEffort;
  const effort = agent.effort ?? defaultEffort;
  const who = participant(seating, agent.id);
  const typed = query.trim();
  const show = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };
  const set = (change: ModelChange) => {
    if ("model" in change && (change.model ?? undefined) === agent.model) return;
    if ("effort" in change && (change.effort ?? undefined) === agent.effort) return;
    onSet(change);
  };
  const setModel = (id: string | null) => {
    show(false);
    set(modelSwitch(models, agent, id));
  };
  // A digit picks the model at that place — only while nothing is typed, so a search can still start with one.
  const byDigit = (event: KeyboardEvent<HTMLDivElement>) => {
    if (query || event.metaKey || event.ctrlKey || event.altKey || !/^[1-9]$/.test(event.key)) return;
    const n = Number(event.key);
    if (n > choices.length + 1) return;
    event.preventDefault();
    setModel(n === 1 ? null : choices[n - 2]!.id);
  };
  const digits = !query;

  return (
    <Popover open={open} onOpenChange={show}>
      <PopoverTrigger asChild>
        {variant === "field" ? (
          <Button variant="outline" size="sm" disabled={disabled} className={cn("h-8 min-w-0 justify-between gap-2 px-2.5 font-normal", className)} aria-label={t.model.of(agent.label)}>
            <span className="truncate">
              <span className="text-muted-foreground">Модель: </span>
              <span className={cn(agent.model ? "font-mono text-meta" : "text-muted-foreground")}>{model?.label ?? agent.model ?? "типова"}</span>
            </span>
            {effort ? (
              <span className={cn("inline-flex shrink-0 items-center gap-1", !agent.effort && "text-muted-foreground")}>
                <GaugeIcon className="size-3.5 text-muted-foreground" />
                {t.effort.level(effort)}
              </span>
            ) : null}
            <ChevronsUpDownIcon className="size-3.5 shrink-0 opacity-60" />
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            className={cn("shrink-0 gap-1.5 font-normal data-[state=open]:bg-accent data-[state=open]:text-foreground", className)}
            title={`${agent.label}: ${t.model.and}`}
          >
            <span className={cn("size-1.5 shrink-0 rounded-full", who.tone === "codex" ? "bg-codex" : "bg-claude", working && "animate-breathe")} style={ink(who)} />
            <span className="text-foreground/85">{agent.label}</span>
            {model || agent.model ? <span className="max-w-[9rem] truncate">{model?.label ?? agent.model}</span> : null}
            {effort ? <span className={cn(agent.effort ? "" : "text-faint")}>{t.effort.level(effort)}</span> : null}
            <ChevronDownIcon className="size-3 opacity-50" />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align={align} side={side} className="w-[300px] p-0">
        <Command onKeyDown={byDigit} loop>
          <div className="flex items-baseline justify-between px-3 pt-2.5 pb-1 text-meta text-muted-foreground">
            Модель {agent.label}
            {working ? <span className="text-faint">з наступного ходу</span> : null}
          </div>
          <CommandInput placeholder="Модель або її назва…" value={query} onValueChange={setQuery} />
          <CommandList className="scroll-thin max-h-[40vh]">
            <CommandGroup>
              <CommandItem value="__default типова з cli" onSelect={() => setModel(null)} title="Та, що в налаштуваннях CLI">
                Типова <span className="text-faint">з CLI</span>
                <Mark on={!agent.model} n={digits ? 1 : undefined} />
              </CommandItem>
              {choices.map((m, i) => (
                <CommandItem key={m.id} value={`${m.id} ${m.label}`} onSelect={() => setModel(m.id)} title={m.description}>
                  <span className="flex min-w-0 flex-col">
                    <span className="flex items-baseline gap-2">
                      <span className="truncate">{m.label}</span>
                      {m.label !== m.id ? <span className="truncate font-mono text-micro text-faint">{m.id}</span> : null}
                    </span>
                    {m.description ? <span className="line-clamp-1 text-meta text-muted-foreground">{m.description}</span> : null}
                  </span>
                  <Mark on={agent.model === m.id} n={digits ? i + 2 : undefined} />
                </CommandItem>
              ))}
              {agent.model && !model ? (
                <CommandItem value={`__current ${agent.model}`} disabled>
                  <span className="truncate font-mono text-meta">{agent.model}</span>
                  <Mark on />
                </CommandItem>
              ) : null}
            </CommandGroup>
            {typed && !choices.some((m) => m.id === typed) ? (
              <>
                <CommandSeparator />
                <CommandGroup forceMount>
                  <CommandItem forceMount value={`__typed ${typed}`} onSelect={() => setModel(typed)}>
                    <DotIcon className="size-4" />
                    <span className="truncate">
                      Узяти <span className="font-mono text-meta">{typed}</span>
                    </span>
                  </CommandItem>
                </CommandGroup>
              </>
            ) : null}
            {!models ? <div className="px-3 py-1.5 text-meta text-faint">Завантажую моделі…</div> : null}
          </CommandList>
          {levels.length ? (
            <div className="border-t border-border px-3 pt-2 pb-2.5">
              <div className="pb-1.5 text-meta text-muted-foreground">{t.effort.hint}</div>
              <div role="radiogroup" aria-label={t.effort.name} className="flex flex-wrap gap-1">
                {[null, ...levels].map((level) => {
                  const on = (agent.effort ?? null) === level;
                  return (
                    <button
                      key={level ?? "__default"}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => set({ effort: level })}
                      title={level ? undefined : t.effort.defaultIs(defaultEffort)}
                      className={cn(
                        "h-6 rounded-md border px-2 text-meta transition",
                        on ? "border-primary/50 bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
                      )}
                    >
                      {level ? t.effort.level(level) : t.effort.default}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
          {onSession ? (
            <button
              type="button"
              onClick={() => {
                show(false);
                onSession();
              }}
              className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-ui transition hover:bg-accent"
            >
              Сесія {agent.label}
              <ChevronRightIcon className="ml-auto size-4 opacity-60" />
            </button>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** The right edge of a row: a check on the current choice, otherwise the digit that picks it. */
function Mark({ on, n }: { on: boolean; n?: number }) {
  if (on) return <CheckIcon className="ml-auto size-4 text-primary" />;
  return n ? <span className="tabular ml-auto text-meta text-faint">{n}</span> : <span className="ml-auto" />;
}
