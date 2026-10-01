import {
  ArrowUpIcon,
  ChevronDownIcon,
  InfinityIcon,
  LayoutTemplateIcon,
  MinusIcon,
  PlusIcon,
  RepeatIcon,
  ScrollTextIcon,
  SearchCodeIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { FolderBar, useFolderGit } from "@/components/FolderPicker";
import { Agora } from "@/components/brand/Agora";
import { type ModelChange, ModelMenu } from "@/components/room/ModelMenu";
import { autosize } from "@/components/room/Composer";
import { NavButton } from "@/components/room/RoomHeader";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { api, local, Unauthorized } from "@/lib/api";
import { names, plural } from "@/lib/format";
import { useModels } from "@/lib/models";
import { DEFAULT_AGENTS } from "@/lib/room";
import { useStore } from "@/lib/store";
import type { RoomAgent } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Each starter is ruled in one of the square's voices: clay, water, laurel. */
const EXAMPLES = [
  {
    icon: ScrollTextIcon,
    voice: "var(--claude-0)",
    title: "Design together",
    text: "Design the event log format together and write the decision into the README",
  },
  {
    icon: SearchCodeIcon,
    voice: "var(--codex-0)",
    title: "Review the repo",
    text: "Review this repo and agree on what to fix first",
  },
  {
    icon: LayoutTemplateIcon,
    voice: "var(--human)",
    title: "Live prototype",
    text: "Build an interactive prototype of the pricing page and show it here",
  },
];

/** No limit: the room goes on until everyone passes, or you stop it. The same default as the daemon's. */
const DEFAULT_BUDGET: number | null = null;
const BUDGETS = [4, 8, 16, 32];

/** Model and effort chosen here for each agent, by id; a key that is present overrides the roster (null: the CLI's default). */
type Picks = Record<string, ModelChange>;

const readPicks = (): Picks => {
  try {
    const value: unknown = JSON.parse(local.get("start.models") ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Picks) : {};
  } catch {
    return {};
  }
};

/** The roster's agent with what was picked for it here. */
const withPick = (agent: RoomAgent, pick: ModelChange | undefined): RoomAgent => {
  if (!pick) return agent;
  const next = { ...agent };
  if ("model" in pick) {
    if (pick.model) next.model = pick.model;
    else delete next.model;
  }
  if ("effort" in pick) {
    if (pick.effort) next.effort = pick.effort;
    else delete next.effort;
  }
  return next;
};

/** An agent as the roster JSON the daemon checks: only the fields it takes. */
const rosterEntry = ({ id, kind, label, model, effort, profile }: RoomAgent) => ({
  id,
  kind,
  label,
  ...(model ? { model } : {}),
  ...(effort ? { effort } : {}),
  ...(profile === false ? { profile } : {}),
});

const footChip =
  "inline-flex h-8 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-small text-muted-foreground transition hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground";

function PopHead({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-ui font-semibold">{title}</div>
      <p className="text-small leading-relaxed text-muted-foreground">
        {text}
      </p>
    </div>
  );
}

function BudgetChip({
  budget,
  onBudget,
}: {
  budget: number | null;
  onBudget: (n: number | null) => void;
}) {
  const set = (n: number | null) => onBudget(n === null ? null : Math.min(100, Math.max(1, n)));
  // The stepper starts from a middling limit when there is none yet.
  const step = budget ?? BUDGETS[1]!;
  return (
    <Popover>
      <PopoverTrigger className={footChip}>
        {budget === null ? <InfinityIcon className="size-3.5 shrink-0" /> : <RepeatIcon className="size-3.5 shrink-0" />}
        <span className="tabular text-foreground">
          {budget === null ? "no turn limit" : plural(budget, "turn", "turns")}
        </span>
        <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 rounded-xl p-3">
        <PopHead
          title="Turns per message you send"
          text="With no limit, agents keep working while anyone has something to add: the room goes quiet by itself when everyone passes, and you can stop it any time. With a limit, the room waits for you after that many turns."
        />
        <div className="mt-3 flex items-center gap-2">
          <div className="grid flex-1 grid-cols-5 gap-1 rounded-lg bg-muted p-1">
            <button
              type="button"
              aria-label="No limit"
              title="No limit"
              onClick={() => set(null)}
              className={cn(
                "grid h-7 place-items-center rounded-md transition",
                budget === null ? "bg-card text-foreground shadow-soft" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <InfinityIcon className="size-3.5" />
            </button>
            {BUDGETS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => set(n)}
                className={cn(
                  "tabular h-7 rounded-md text-small transition",
                  budget === n
                    ? "bg-card font-semibold text-foreground shadow-soft"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {n}
              </button>
            ))}
          </div>
          <div className="flex items-center rounded-lg border border-input">
            <button
              type="button"
              aria-label="Fewer turns"
              onClick={() => set(step - 1)}
              className="grid size-8 place-items-center text-muted-foreground hover:text-foreground"
            >
              <MinusIcon className="size-3.5" />
            </button>
            <span className="tabular w-7 text-center text-small font-semibold">
              {budget ?? "—"}
            </span>
            <button
              type="button"
              aria-label="More turns"
              onClick={() => set(step + 1)}
              className="grid size-8 place-items-center text-muted-foreground hover:text-foreground"
            >
              <PlusIcon className="size-3.5" />
            </button>
          </div>
        </div>
        {budget !== null && (
          <p className="mt-2.5 text-meta text-faint">
            Independent first replies count too — that’s already 2 turns.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

function Steps({ budget }: { budget: number | null }) {
  const steps = [
    {
      title: "Together",
      text: "They start at the same time from the same point and say as they go who is doing what.",
    },
    {
      title: "In turns",
      text:
        budget === null
          ? "They see everything said and keep going while anyone has something to add; they go quiet when everyone passes."
          : `They see everything said and keep going — up to ${plural(budget, "turn", "turns")}, then wait for you.`,
    },
    {
      title: "Table",
      text: "Proposals, endorsements and decisions, kept apart from the chatter.",
    },
  ];
  return (
    <ol className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
      {steps.map((step, i) => (
        <li key={step.title} className="flex gap-2.5">
          <span className="tabular mt-px grid size-5 shrink-0 place-items-center rounded-full bg-foreground/[0.07] text-micro font-semibold text-muted-foreground">
            {i + 1}
          </span>
          <span className="flex flex-col gap-0.5">
            <span className="text-small font-semibold">{step.title}</span>
            <span className="text-small leading-snug text-muted-foreground">
              {step.text}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function StartScreen() {
  const rooms = useStore((s) => s.rooms);
  const loadRooms = useStore((s) => s.loadRooms);
  const go = useStore((s) => s.go);
  const ta = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(() => local.get("draft.new") ?? "");
  const [folder, setFolder] = useState<string | null>(() =>
    local.get("folder"),
  );
  const [worktree, setWorktree] = useState(() => local.get("worktree") === "1");
  const [base, setBase] = useState<string | null>(null);
  const [budget, setBudget] = useState<number | null>(() => {
    const n = Number.parseInt(local.get("budget") ?? "", 10);
    return n >= 1 && n <= 100 ? n : DEFAULT_BUDGET;
  });
  const pickFolder = (path: string | null) => {
    setFolder(path);
    setBase(null);
    local.set("folder", path);
  };
  const git = useFolderGit(folder, () => pickFolder(null));
  const toggleWorktree = (on: boolean) => {
    setWorktree(on);
    local.set("worktree", on ? "1" : null);
  };
  const changeBudget = (n: number | null) => {
    setBudget(n);
    local.set("budget", n === DEFAULT_BUDGET || n === null ? null : String(n));
  };
  const inWorktree = Boolean(folder && git?.head && worktree);
  const [busy, setBusy] = useState(false);
  // Who a new room seats: the daemon's roster (agents.json), Claude and Codex until it answers.
  const [agents, setAgents] = useState<RoomAgent[]>(DEFAULT_AGENTS);
  // A broken roster file (agents.json): said here, and no room is started until it reads again.
  const [rosterError, setRosterError] = useState<string | null>(null);
  // Named as they sit: Claudes first, then Codexes.
  const who = names([...agents.filter((a) => a.kind === "claude"), ...agents.filter((a) => a.kind !== "claude")].map((a) => a.label));
  const models = useModels();
  const [picks, setPicks] = useState<Picks>(readPicks);
  const seated = agents.map((agent) => withPick(agent, picks[agent.id]));
  // The roster goes with the new room only when a model or effort here differs from it.
  const picked = seated.some((agent, i) => agent.model !== agents[i]!.model || agent.effort !== agents[i]!.effort);
  const pick = (id: string, change: ModelChange) =>
    setPicks((prev) => {
      const next = { ...prev, [id]: { ...prev[id], ...change } };
      local.set("start.models", JSON.stringify(next));
      return next;
    });
  const loadRoster = useCallback(() => {
    api<{ agents?: RoomAgent[]; rosterError?: string }>("GET", "/api/info")
      .then((info) => {
        setRosterError(info.rosterError ?? null);
        if (info.agents?.length) setAgents(info.agents);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    document.title = "New room · Agoryx";
    setTimeout(() => ta.current?.focus(), 30);
    loadRoster();
  }, [loadRoster]);
  // Fixed in an editor meanwhile: read again when the window is back.
  useEffect(() => {
    if (!rosterError) return;
    window.addEventListener("focus", loadRoster);
    return () => window.removeEventListener("focus", loadRoster);
  }, [rosterError, loadRoster]);
  useLayoutEffect(() => autosize(ta.current, 0.4), [text]);
  const change = (value: string) => {
    setText(value);
    local.set("draft.new", value || null);
  };
  const submit = async (event?: { preventDefault: () => void }) => {
    event?.preventDefault();
    const body = text.trim();
    if (!body || busy || rosterError) return;
    setBusy(true);
    try {
      const { room } = await api<{ room: { id: string } }>(
        "POST",
        "/api/rooms",
        {
          text: body,
          ...(folder ? { dir: folder } : {}),
          ...(inWorktree ? { worktree: true, ...(base ? { base } : {}) } : {}),
          ...(budget !== DEFAULT_BUDGET ? { budget } : {}),
          ...(picked ? { agents: seated.map(rosterEntry) } : {}),
        },
      );
      local.set("draft.new", null);
      await loadRooms();
      go({ kind: "room", id: room.id });
    } catch (error) {
      if (!(error instanceof Unauthorized))
        toast.error(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };
  const first = !rooms.length;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <header className="relative flex h-14 shrink-0 items-center px-3 lg:hidden">
        <NavButton />
      </header>
      <div className="scroll-thin relative flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col justify-center gap-9 px-4 py-10 sm:px-6">
          <div className="flex flex-col items-center gap-9 text-center">
            <Agora agents={seated} label={`You, ${who}`} />
            <div className="flex flex-col items-center gap-3">
              <h1 className="font-display text-[clamp(34px,5.6vw,58px)] leading-[1.02] font-[650] text-balance">
                {first
                  ? `A shared room for you, ${who}`
                  : "What should we work on?"}
              </h1>
              <p className="max-w-[50ch] text-lead leading-relaxed text-pretty text-muted-foreground">
                One conversation for everyone. Each agent works in its own native
                session, with all its tools, and sees everything said in the
                room.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <form
              onSubmit={submit}
              className="rounded-[26px] border border-input bg-card shadow-lift transition focus-within:border-human/45 focus-within:ring-4 focus-within:ring-human/10"
            >
              <div className="flex flex-wrap items-start gap-x-2 gap-y-1 rounded-t-[26px] border-b border-border/80 bg-muted/40 px-3 py-2">
                <span className="pr-0.5 pl-1 text-meta leading-8 text-faint">
                  Working in
                </span>
                <FolderBar
                  folder={folder}
                  onFolder={pickFolder}
                  git={git}
                  worktree={worktree}
                  onWorktree={toggleWorktree}
                  base={base}
                  onBase={setBase}
                />
              </div>
              <textarea
                ref={ta}
                rows={3}
                value={text}
                onChange={(event) => change(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    void submit();
                  }
                }}
                placeholder={`Describe a task or question for ${who}…`}
                aria-label="First message"
                data-composer
                className="scroll-thin block min-h-[108px] w-full resize-none bg-transparent px-5 pt-4 text-lead leading-relaxed outline-none placeholder:text-faint"
              />
              <div className="flex flex-wrap items-center gap-1 px-2.5 pb-2.5">
                {seated.map((agent) => (
                  <ModelMenu
                    key={agent.id}
                    agent={agent}
                    seating={{ agents: seated }}
                    models={models}
                    side="bottom"
                    className="h-8 rounded-full px-2.5 text-small text-muted-foreground hover:text-foreground"
                    onSet={(change) => pick(agent.id, change)}
                  />
                ))}
                <span aria-hidden className="mx-0.5 hidden h-4 w-px bg-border sm:block" />
                <BudgetChip budget={budget} onBudget={changeBudget} />
                <Button
                  type="submit"
                  size="icon"
                  className="ml-auto size-9 rounded-full"
                  disabled={busy || !text.trim() || Boolean(rosterError)}
                  aria-label="Start"
                  title="Start (Enter)"
                >
                  <ArrowUpIcon className="size-4.5" />
                </Button>
              </div>
            </form>
            {rosterError ? (
              <div role="alert" className="flex flex-col gap-1.5 rounded-2xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-small">
                <span className="font-semibold text-destructive">Can’t read the agent roster — the room can’t start until it’s fixed</span>
                <span className="font-mono text-meta break-words whitespace-pre-wrap text-muted-foreground">{rosterError}</span>
                <Button type="button" variant="outline" size="sm" className="self-start" onClick={loadRoster}>
                  Check again
                </Button>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 text-meta text-faint">
              <span>
                The room is named after the first line; you can rename it any time
              </span>
              <span className="hidden items-center gap-1 sm:inline-flex">
                <Kbd>Enter</Kbd> start · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd>{" "}
                new line
              </span>
            </div>
          </div>

          <div className="grid gap-x-6 gap-y-1 sm:grid-cols-3">
            {EXAMPLES.map(({ icon: Icon, voice, title, text: example }) => (
              <button
                key={title}
                type="button"
                onClick={() => {
                  change(example);
                  ta.current?.focus();
                }}
                style={{ "--voice": voice } as React.CSSProperties}
                className="group flex flex-col gap-1 border-t-2 border-(--voice)/35 py-3 text-left transition-colors hover:border-(--voice)"
              >
                <span className="flex items-center gap-2 text-small font-semibold">
                  <Icon className="size-3.5 text-(--voice)" />
                  {title}
                </span>
                <span className="text-small leading-snug text-muted-foreground transition-colors group-hover:text-foreground">
                  {example}
                </span>
              </button>
            ))}
          </div>

          {/* How a room works, for the first one; after that the examples alone. */}
          {first ? (
            <div className="pt-1">
              <Steps budget={budget} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
