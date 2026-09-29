import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { AgentModels, RoomAgent } from "@/lib/types";
import { ink, participant, type Seating } from "@/lib/room";
import { cn } from "@/lib/utils";

export type ModelChange = { model?: string | null; effort?: string | null };

/**
 * One agent's model and effort: a compact button (name, model, effort) and a menu like Claude Code's — a check on the
 * current model, digits 1–N pick one, effort as chips. Used in a room's footer and on the start screen.
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
  /** Opens the agent's session (its full model picker); absent where there is no session yet. */
  onSession?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const kind = models?.[agent.kind];
  const choices = kind?.models ?? [];
  const model = choices.find((m) => m.id === agent.model);
  const levels = model?.efforts ?? kind?.efforts ?? [];
  const defaultEffort = model?.defaultEffort;
  const effort = agent.effort ?? defaultEffort;
  const who = participant(seating, agent.id);
  const set = (change: ModelChange) => {
    if ("model" in change && (change.model ?? undefined) === agent.model) return;
    if ("effort" in change && (change.effort ?? undefined) === agent.effort) return;
    onSet(change);
  };
  // Like Claude Code's menu: a digit picks the model at that place.
  const byDigit = (event: KeyboardEvent<HTMLDivElement>) => {
    const n = Number(event.key);
    if (!Number.isInteger(n) || n < 1 || n > choices.length + 1) return;
    event.preventDefault();
    setOpen(false);
    set({ model: n === 1 ? null : choices[n - 2]!.id });
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          className={cn("shrink-0 gap-1.5 font-normal data-[state=open]:bg-accent data-[state=open]:text-foreground", className)}
          title={`${agent.label}: модель і effort`}
        >
          <span className={cn("size-1.5 shrink-0 rounded-full", who.tone === "codex" ? "bg-codex" : "bg-claude", working && "animate-breathe")} style={ink(who)} />
          <span className="text-foreground/85">{agent.label}</span>
          {model || agent.model ? <span className="max-w-[9rem] truncate">{model?.label ?? agent.model}</span> : null}
          {effort ? <span className={cn(agent.effort ? "" : "text-faint")}>{effort}</span> : null}
          <ChevronDownIcon className="size-3 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side={side} className="w-[260px]" onKeyDown={byDigit}>
        <DropdownMenuLabel className="flex items-baseline justify-between text-[11.5px] font-normal text-muted-foreground">
          Модель {agent.label}
          {working ? <span className="text-faint">з наступного ходу</span> : null}
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => set({ model: null })} title="Та, що в налаштуваннях CLI">
          Типова <span className="text-faint">з CLI</span>
          <MenuMark on={!agent.model} n={1} />
        </DropdownMenuItem>
        <div className="scroll-thin max-h-[40vh] overflow-y-auto">
          {choices.map((m, i) => (
            <DropdownMenuItem key={m.id} onSelect={() => set({ model: m.id })} title={m.description}>
              <span className="truncate">{m.label}</span>
              <MenuMark on={agent.model === m.id} n={i + 2} />
            </DropdownMenuItem>
          ))}
          {agent.model && !model ? (
            <DropdownMenuItem disabled>
              <span className="truncate font-mono text-[12px]">{agent.model}</span>
              <MenuMark on />
            </DropdownMenuItem>
          ) : null}
          {!models ? <div className="px-2 py-1.5 text-[12px] text-faint">Завантажую моделі…</div> : null}
        </div>
        {levels.length ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11.5px] font-normal text-muted-foreground">Effort — наскільки глибоко думати</DropdownMenuLabel>
            <div className="flex flex-wrap gap-1 px-2 pb-1.5">
              {[null, ...levels].map((level) => {
                const on = (agent.effort ?? null) === level;
                return (
                  <button
                    key={level ?? "__default"}
                    type="button"
                    onClick={() => set({ effort: level })}
                    title={level ? undefined : `Типово${defaultEffort ? `: ${defaultEffort}` : ""}`}
                    className={cn(
                      "h-6 rounded-md border px-2 text-[12px] transition",
                      on ? "border-primary/50 bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    {level ?? "типово"}
                  </button>
                );
              })}
            </div>
          </>
        ) : null}
        {onSession ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onSession}>
              Сесія {agent.label}, інша модель…
              <ChevronRightIcon className="ml-auto size-4 opacity-60" />
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The right edge of a menu row: a check on the current choice, otherwise the digit that picks it. */
function MenuMark({ on, n }: { on: boolean; n?: number }) {
  if (on) return <CheckIcon className="ml-auto size-4 text-primary" />;
  return n ? <span className="tabular ml-auto text-[12px] text-faint">{n}</span> : <span className="ml-auto" />;
}
