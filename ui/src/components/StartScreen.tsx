import {
  ArrowRightIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  InfinityIcon,
  LayoutTemplateIcon,
  MinusIcon,
  PlusIcon,
  RepeatIcon,
  ScrollTextIcon,
  SearchCodeIcon,
  UserIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { FolderBar, useFolderGit } from "@/components/FolderPicker";
import { Avatar } from "@/components/room/bits";
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
import { DEFAULT_AGENTS, ink, participant } from "@/lib/room";
import { useStore } from "@/lib/store";
import type { RoomAgent } from "@/lib/types";
import { cn } from "@/lib/utils";

const EXAMPLES = [
  {
    icon: ScrollTextIcon,
    title: "Спроєктувати разом",
    text: "Спроєктуйте разом формат журналу подій і запишіть рішення в README",
  },
  {
    icon: SearchCodeIcon,
    title: "Рев'ю репозиторію",
    text: "Перегляньте цей репозиторій і домовтеся, що виправити першим",
  },
  {
    icon: LayoutTemplateIcon,
    title: "Живий прототип",
    text: "Зробіть інтерактивний прототип сторінки тарифів і покажіть його тут",
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

/** You and the agents at one table (Claude and Codex unless agents.json says otherwise): the lines are the conversation between all of you. */
function Seats({ agents }: { agents: RoomAgent[] }) {
  /** The line to the seat next to you, in that agent's colour (its own shade when its kind repeats). */
  const Line = ({ agent }: { agent: RoomAgent | undefined }) => {
    const who = participant({ agents }, agent?.id ?? "");
    const tone = who.tone === "codex" ? "codex" : "claude";
    return (
      <span
        style={ink(who)}
        className={cn(
          "relative block h-px w-10 sm:w-16",
          tone === "claude"
            ? "bg-gradient-to-r from-claude/50 to-human/40"
            : "bg-gradient-to-r from-human/40 to-codex/50",
        )}
      >
        <span
          className={cn(
            "absolute top-1/2 size-1.5 -translate-y-1/2 rounded-full opacity-0 motion-safe:animate-travel",
            tone === "claude" ? "bg-claude" : "bg-codex [animation-delay:1.6s]",
          )}
        />
      </span>
    );
  };
  const Seat = ({
    label,
    children,
  }: {
    label: string;
    children: React.ReactNode;
  }) => (
    <span className="flex flex-col items-center gap-1.5">
      {children}
      <span className="text-meta font-medium tracking-wide text-muted-foreground">
        {label}
      </span>
    </span>
  );
  const seat = (agent: RoomAgent) => (
    <Seat key={agent.id} label={agent.label}>
      <Avatar handle={agent.id} roster={agents} size={44} />
    </Seat>
  );
  const left = agents.slice(0, Math.ceil(agents.length / 2));
  const right = agents.slice(left.length);
  return (
    <div className="flex items-start">
      <span className="flex gap-3">{left.map(seat)}</span>
      <span className="mx-1.5 mt-[22px]">
        <Line agent={left.at(-1)} />
      </span>
      <Seat label="Ви">
        <span className="grid size-11 place-items-center rounded-[30%] bg-human-soft text-human ring-1 ring-human/25 ring-inset">
          <UserIcon className="size-5" />
        </span>
      </Seat>
      {right.length ? (
        <>
          <span className="mx-1.5 mt-[22px]">
            <Line agent={right[0]} />
          </span>
          <span className="flex gap-3">{right.map(seat)}</span>
        </>
      ) : null}
    </div>
  );
}

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
          {budget === null ? "без ліміту ходів" : plural(budget, "хід", "ходи", "ходів")}
        </span>
        <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 rounded-xl p-3">
        <PopHead
          title="Ходів на ваше повідомлення"
          text="Без ліміту агенти працюють, доки комусь є що додати: кімната стихає сама, коли всі пасують, а зупинити її можна будь-коли. З лімітом — після стількох ходів кімната чекає на вас."
        />
        <div className="mt-3 flex items-center gap-2">
          <div className="grid flex-1 grid-cols-5 gap-1 rounded-lg bg-muted p-1">
            <button
              type="button"
              aria-label="Без ліміту"
              title="Без ліміту"
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
              aria-label="Менше"
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
              aria-label="Більше"
              onClick={() => set(step + 1)}
              className="grid size-8 place-items-center text-muted-foreground hover:text-foreground"
            >
              <PlusIcon className="size-3.5" />
            </button>
          </div>
        </div>
        {budget !== null && (
          <p className="mt-2.5 text-meta text-faint">
            Незалежні перші відповіді теж рахуються — це вже 2 ходи.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

function Steps({ budget }: { budget: number | null }) {
  const steps = [
    {
      title: "Разом",
      text: "Беруться одночасно з того самого місця й кажуть по ходу, хто що робить.",
    },
    {
      title: "По черзі",
      text:
        budget === null
          ? "Бачать усе сказане й продовжують, доки комусь є що додати; стихають, коли всі пасують."
          : `Бачать усе сказане й продовжують — до ${plural(budget, "ходу", "ходів", "ходів")}, потім чекають на вас.`,
    },
    {
      title: "Стіл",
      text: "Пропозиції, підтримка й рішення — окремо від балачок.",
    },
  ];
  return (
    <ol className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
      {steps.map((step, i) => (
        <li key={step.title} className="flex gap-2.5">
          <span className="tabular mt-px grid size-5 shrink-0 place-items-center rounded-full border border-border text-micro font-semibold text-muted-foreground">
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
  const who = names(agents.map((a) => a.label));
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
    document.title = "Нова кімната · Agoryx";
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
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px] opacity-70 dark:opacity-40"
        style={{
          background:
            "radial-gradient(520px 260px at 38% -40px, color-mix(in oklab, var(--claude) 14%, transparent), transparent 70%), radial-gradient(520px 260px at 62% -40px, color-mix(in oklab, var(--codex) 14%, transparent), transparent 70%)",
        }}
      />
      <header className="relative flex h-14 shrink-0 items-center px-3 lg:hidden">
        <NavButton />
      </header>
      <div className="scroll-thin relative flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col justify-center gap-8 px-4 py-10 sm:px-6">
          <div className="flex flex-col items-center gap-5 text-center">
            <Seats agents={agents} />
            <div className="flex flex-col items-center gap-2.5">
              <h1 className="font-serif text-[clamp(28px,4.4vw,40px)] leading-[1.1] font-semibold tracking-tight text-balance">
                {first
                  ? `Спільна кімната для вас, ${who}`
                  : "Про що поговоримо?"}
              </h1>
              <p className="max-w-[52ch] text-body leading-relaxed text-pretty text-muted-foreground">
                Одна розмова на всіх. Кожен агент працює у власній рідній
                сесії, з усіма своїми інструментами, і бачить усе, що сказано в
                кімнаті.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <form
              onSubmit={submit}
              className="rounded-3xl border border-input bg-card shadow-lift transition focus-within:border-ring/35"
            >
              <div className="flex flex-wrap items-start gap-x-2 gap-y-1 rounded-t-3xl border-b border-border/80 bg-muted/50 px-3 py-2">
                <span className="pr-0.5 pl-1 text-meta leading-8 text-faint">
                  Працюють у
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
                placeholder={`Опишіть задачу чи питання для ${who}…`}
                aria-label="Перше повідомлення"
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
                <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
                <BudgetChip budget={budget} onBudget={changeBudget} />
                <Button
                  type="submit"
                  size="icon"
                  className="ml-auto size-9 rounded-full"
                  disabled={busy || !text.trim() || Boolean(rosterError)}
                  aria-label="Почати"
                  title="Почати (Enter)"
                >
                  <ArrowUpIcon className="size-4.5" />
                </Button>
              </div>
            </form>
            {rosterError ? (
              <div role="alert" className="flex flex-col gap-1.5 rounded-2xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-small">
                <span className="font-semibold text-destructive">Склад агентів не читається — кімнату не почати, доки його не виправлено</span>
                <span className="font-mono text-meta break-words whitespace-pre-wrap text-muted-foreground">{rosterError}</span>
                <Button type="button" variant="outline" size="sm" className="self-start" onClick={loadRoster}>
                  Перевірити знову
                </Button>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 text-meta text-faint">
              <span>
                Назва кімнати — з першого рядка; змінити можна будь-коли
              </span>
              <span className="hidden items-center gap-1 sm:inline-flex">
                <Kbd>Enter</Kbd> почати · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd>{" "}
                новий рядок
              </span>
            </div>
          </div>

          <div className="grid gap-2.5 sm:grid-cols-3">
            {EXAMPLES.map(({ icon: Icon, title, text: example }) => (
              <button
                key={title}
                type="button"
                onClick={() => {
                  change(example);
                  ta.current?.focus();
                }}
                className="group flex flex-col gap-1.5 rounded-2xl border border-border bg-card/60 p-3.5 text-left transition hover:-translate-y-px hover:border-input hover:bg-card hover:shadow-soft"
              >
                <span className="flex items-center gap-2 text-small font-semibold">
                  <span className="grid size-6 place-items-center rounded-lg bg-secondary text-primary">
                    <Icon className="size-3.5" />
                  </span>
                  {title}
                  <ArrowRightIcon className="ml-auto size-3.5 -translate-x-1 text-faint opacity-0 transition group-hover:translate-x-0 group-hover:opacity-100" />
                </span>
                <span className="text-small leading-snug text-muted-foreground">
                  {example}
                </span>
              </button>
            ))}
          </div>

          <div className="border-t border-border/70 pt-5">
            <Steps budget={budget} />
          </div>
        </div>
      </div>
    </div>
  );
}
