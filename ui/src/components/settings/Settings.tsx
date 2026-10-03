import {
  BotIcon,
  GaugeIcon,
  InfoIcon,
  type LucideIcon,
  PlusIcon,
  SlidersHorizontalIcon,
  SmartphoneIcon,
  Trash2Icon,
  UserRoundIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ErrorNote, Hint, Loading } from "@/components/common/states";
import { PhonePanel } from "@/components/dialogs/PhoneDialog";
import { Avatar } from "@/components/room/bits";
import { LimitsCard } from "@/components/room/Limits";
import { ModelMenu } from "@/components/room/ModelMenu";
import { RoleField } from "@/components/room/RoleField";
import { PageBar } from "@/components/common/PageBar";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, local, Unauthorized } from "@/lib/api";
import { keyLabel, withMod } from "@/lib/keys";
import { errText } from "@/lib/load";
import { handleFor, KIND_NAME, KIND_SHORT, MAX_ROLE, nameFor, rosterEntry as entry } from "@/lib/agents";
import { useModels } from "@/lib/models";
import { DEFAULT_AGENTS } from "@/lib/room";
import { type SettingsSection, useStore } from "@/lib/store";
import { type ThemePref, useTheme } from "@/lib/theme";
import type { AgentKind, LimitSnapshot, RoomAgent } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Agoryx's own settings, not a room's: how the page looks, what new rooms start with, the human's profile,
 * the agents new rooms seat, this computer's phone, the subscriptions' limits. A room's own settings stay in
 * the room (⋯ → Room settings).
 */

const SECTIONS: { id: SettingsSection; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", icon: SlidersHorizontalIcon },
  { id: "profile", label: "Profile", icon: UserRoundIcon },
  { id: "agents", label: "Agents", icon: BotIcon },
  { id: "phone", label: "Phone", icon: SmartphoneIcon },
  { id: "limits", label: "Limits", icon: GaugeIcon },
  { id: "about", label: "About Agoryx", icon: InfoIcon },
];

const fail = (error: unknown) => {
  if (!(error instanceof Unauthorized)) toast.error(errText(error));
};

function Section({ title, sub, children }: { title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-5">
      <header className="flex flex-col gap-1.5">
        <h2 className="font-display text-title font-semibold">{title}</h2>
        {sub ? <p className="max-w-[60ch] text-small leading-relaxed text-muted-foreground">{sub}</p> : null}
      </header>
      {children}
    </section>
  );
}

/** A labelled setting: the name and what it does on the left, the control on the right (under it on a phone). */
function Row({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-col gap-2 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={htmlFor} className="text-ui font-medium">
          {label}
        </label>
        {hint ? <p className="text-small leading-relaxed text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      {title ? <h3 className="text-small font-medium text-muted-foreground">{title}</h3> : null}
      <div className="flex flex-col divide-y divide-border rounded-xl border border-border bg-card px-4">{children}</div>
    </div>
  );
}

// --- general ------------------------------------------------------------------------------------

const THEMES: { id: ThemePref; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

const BUDGETS = [4, 8, 16, 32];

/** What the start screen remembers on this device (StartScreen.tsx reads the same keys). */
const readBudget = (): number | null => {
  const n = Number.parseInt(local.get("budget") ?? "", 10);
  return n >= 1 && n <= 100 ? n : null;
};

function General() {
  const { pref, set } = useTheme();
  const openDialog = useStore((s) => s.openDialog);
  const [budget, setBudget] = useState<number | null>(readBudget);
  const [worktree, setWorktree] = useState(() => local.get("worktree") === "1");
  return (
    <Section title="General" sub="How Agoryx looks and what new rooms start with on this device.">
      <Group title="Appearance">
        <Row label="Theme">
          <div role="radiogroup" aria-label="Theme" className="inline-flex rounded-lg bg-muted p-0.5">
            {THEMES.map((theme) => (
              <button
                key={theme.id}
                type="button"
                role="radio"
                aria-checked={pref === theme.id}
                onClick={() => set(theme.id)}
                className={cn(
                  "h-7 rounded-md px-3 text-small transition",
                  pref === theme.id ? "bg-card font-medium text-foreground shadow-edge" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {theme.label}
              </button>
            ))}
          </div>
        </Row>
      </Group>
      <Group title="New rooms">
        <Row
          label="Turn limit"
          hint={
            budget === null
              ? "No limit: agents work while anyone has something to add, and the room goes quiet when everyone passes."
              : `After your message, agents take at most ${budget} turns, then wait for you.`
          }
        >
          <Select
            value={budget === null ? "none" : String(budget)}
            onValueChange={(value) => {
              const next = value === "none" ? null : Number(value);
              setBudget(next);
              local.set("budget", next === null ? null : String(next));
            }}
          >
            <SelectTrigger className="w-40" aria-label="Turn limit">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No limit</SelectItem>
              {BUDGETS.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n} turns
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        <Row label="Separate branch for a git folder" hint="A room in a git repository works in a new worktree, and your folder stays as it is.">
          <Switch
            checked={worktree}
            onCheckedChange={(on) => {
              setWorktree(on);
              local.set("worktree", on ? "1" : null);
            }}
            aria-label="Separate branch for a git folder"
          />
        </Row>
      </Group>
      <Group title="Keyboard">
        <Row label="All shortcuts" hint={<>Search and all actions: <Kbd>{withMod("K")}</Kbd>. Settings: <Kbd>{keyLabel("settings")}</Kbd>.</>}>
          <Button variant="outline" size="sm" onClick={() => openDialog({ kind: "keys" })}>
            Show
          </Button>
        </Row>
      </Group>
    </Section>
  );
}

// --- profile ------------------------------------------------------------------------------------

interface ProfileFile {
  path: string;
  text: string;
  max: number;
}

function Profile() {
  const [file, setFile] = useState<ProfileFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<ProfileFile>("GET", "/api/profile")
      .then((got) => {
        setFile(got);
        setText(got.text);
      })
      .catch((err) => !(err instanceof Unauthorized) && setError(errText(err)));
  }, []);
  const dirty = file !== null && text !== file.text;
  const save = async () => {
    if (!dirty || busy) return;
    setBusy(true);
    try {
      const got = await api<ProfileFile>("PUT", "/api/profile", { text });
      setFile(got);
      setText(got.text);
      toast.success("Profile saved. Agents get it from their next turn.");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  const chars = text.trim().length;
  return (
    <Section
      title="Profile"
      sub="Who you are, how you work, what matters to you — in your own words. Agents in every room get it (except those you turned it off for in “Agents”). Agoryx never copies it anywhere: not into the folder, the room’s log or commits."
    >
      {error ? (
        <ErrorNote>{error}</ErrorNote>
      ) : !file ? (
        <Loading lines={2} block />
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                void save();
              }
            }}
            placeholder={"I write backends in Go and TypeScript.\nKeep replies short and to the point.\nAction first, then the explanation."}
            aria-label="Profile"
            className="min-h-[280px] resize-y font-mono text-small leading-relaxed"
          />
          <div className="flex flex-wrap items-center gap-3">
            <span className={cn("text-meta tabular-nums", chars > file.max ? "text-amber-ink" : "text-faint")}>
              {chars} / {file.max} characters{chars > file.max ? " — agents get only the beginning" : ""}
            </span>
            <span className="truncate font-mono text-meta text-faint" title={file.path}>
              {file.path}
            </span>
            <div className="ml-auto flex gap-2">
              {dirty ? (
                <Button type="button" variant="ghost" onClick={() => setText(file.text)}>
                  Cancel
                </Button>
              ) : null}
              <Button type="submit" disabled={!dirty || busy}>
                Save
              </Button>
            </div>
          </div>
        </form>
      )}
    </Section>
  );
}

// --- agents -------------------------------------------------------------------------------------

interface RosterFile {
  path: string;
  custom: boolean;
  agents?: RoomAgent[];
  rosterError?: string;
}

function Agents() {
  const models = useModels();
  const [file, setFile] = useState<RosterFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<RoomAgent[]>([]);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<AgentKind>("claude");
  const [model, setModel] = useState<string>("");
  const take = useCallback((got: RosterFile) => {
    setFile(got);
    setAgents(got.agents ?? DEFAULT_AGENTS);
  }, []);
  useEffect(() => {
    api<RosterFile>("GET", "/api/roster")
      .then(take)
      .catch((err) => !(err instanceof Unauthorized) && setError(errText(err)));
  }, [take]);
  const saved = JSON.stringify((file?.agents ?? DEFAULT_AGENTS).map(entry));
  const dirty = file !== null && JSON.stringify(agents.map(entry)) !== saved;
  const change = (id: string, patch: Partial<RoomAgent>) =>
    setAgents((list) =>
      list.map((agent) => {
        if (agent.id !== id) return agent;
        const next: RoomAgent = { ...agent, ...patch };
        for (const key of ["model", "effort", "role"] as const) if (key in patch && !patch[key]) delete next[key];
        if (next.profile !== false) delete next.profile;
        // A name made from the model follows the model ("Claude Opus" → "Claude Sonnet"); a name of one's own stays.
        const others = list.filter((a) => a.id !== id);
        if ("model" in patch && agent.label === nameFor(agent.kind, agent.model, models, others) && agent.label !== KIND_SHORT[agent.kind]) {
          next.label = nameFor(agent.kind, next.model, models, others);
          if (agent.id === handleFor(agent.label)) next.id = handleFor(next.label);
        }
        return next;
      }),
    );
  const name = nameFor(kind, model || undefined, models, agents);
  const add = () => {
    setAgents((list) => [...list, { id: handleFor(name), kind, label: name, ...(model ? { model } : {}) }]);
    setModel("");
  };
  const done = (got: RosterFile, message: string) => {
    take(got);
    // The start screen's own picks were on top of the old roster: the new one is what it starts from.
    local.set("start.models", null);
    toast.success(message);
  };
  const save = async () => {
    setBusy(true);
    try {
      done(await api<RosterFile>("PUT", "/api/roster", { agents: agents.map(entry) }), "Saved. New rooms will start with these agents.");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  const reset = async () => {
    setBusy(true);
    try {
      done(await api<RosterFile>("DELETE", "/api/roster"), "Back to Claude and Codex.");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section
      title="Agents"
      sub="Who sits in every new room, with which model, effort and role. Existing rooms stay as they are: change the model there at the bottom of the room."
    >
      {error ? (
        <ErrorNote>{error}</ErrorNote>
      ) : !file ? (
        <Loading lines={3} />
      ) : (
        <>
          {file.rosterError ? (
            <ErrorNote>
              Can’t read the agents file: {file.rosterError}. Save the list below to rewrite it, or go back to Claude and Codex.
            </ErrorNote>
          ) : null}
          <div className="flex flex-col divide-y divide-border rounded-xl border border-border bg-card">
            {agents.map((agent) => (
              <div key={agent.id} className="flex flex-col gap-3 px-4 py-3.5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <Avatar handle={agent.id} roster={agents} size={32} />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-ui font-medium">{agent.label}</span>
                      <span className="truncate text-meta text-muted-foreground">
                        @{agent.id} · {KIND_NAME[agent.kind]}
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <ModelMenu
                      agent={agent}
                      seating={{ agents }}
                      models={models}
                      side="bottom"
                      variant="field"
                      onSet={(patch) => change(agent.id, pick(patch))}
                    />
                    <label className="flex items-center gap-2 text-small text-muted-foreground" title="Whether this agent gets your profile">
                      Profile
                      <Switch
                        checked={agent.profile !== false}
                        onCheckedChange={(on) => change(agent.id, { profile: on ? undefined : false })}
                        aria-label={`Profile for ${agent.label}`}
                      />
                    </label>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 text-muted-foreground"
                      disabled={agents.length < 2}
                      aria-label={`Remove ${agent.label}`}
                      title={agents.length < 2 ? "A room needs at least one agent" : `Remove ${agent.label}`}
                      onClick={() => setAgents((list) => list.filter((a) => a.id !== agent.id))}
                    >
                      <Trash2Icon className="size-4" />
                    </Button>
                  </div>
                </div>
                <RoleField id={`roster-role-${agent.id}`} value={agent.role ?? ""} onChange={(role) => change(agent.id, { role })} name={agent.label} />
              </div>
            ))}
          </div>
          <form
            className="flex flex-col gap-2 sm:flex-row sm:items-center"
            onSubmit={(event) => {
              event.preventDefault();
              add();
            }}
          >
            <Select
              value={kind}
              onValueChange={(value) => {
                setKind(value as AgentKind);
                setModel("");
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="CLI">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude">Claude Code</SelectItem>
                <SelectItem value="codex">Codex</SelectItem>
              </SelectContent>
            </Select>
            <Select value={model || "default"} onValueChange={(value) => setModel(value === "default" ? "" : value)}>
              <SelectTrigger className="w-full sm:flex-1" aria-label="Model">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">CLI default model</SelectItem>
                {(models?.[kind]?.models ?? []).map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="submit" variant="outline" className="gap-1.5">
              <PlusIcon className="size-4" />
              Add
            </Button>
          </form>
          <Hint>
            Adds “{name}” (@{handleFor(name)}). Several agents of one CLI can sit together — e.g. Claude on Opus and Claude on Sonnet:
            each one’s name says which model it runs.
          </Hint>
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
            <span className="truncate font-mono text-meta text-faint" title={file.path}>
              {file.custom ? file.path : "Default: Claude and Codex"}
            </span>
            <div className="ml-auto flex gap-2">
              {file.custom ? (
                <Button variant="ghost" onClick={() => void reset()} disabled={busy}>
                  Reset to Claude and Codex
                </Button>
              ) : null}
              {dirty ? (
                <Button variant="ghost" onClick={() => setAgents(file.agents ?? DEFAULT_AGENTS)}>
                  Cancel
                </Button>
              ) : null}
              <Button onClick={() => void save()} disabled={!dirty || busy || agents.some((a) => (a.role?.length ?? 0) > MAX_ROLE)}>
                Save
              </Button>
            </div>
          </div>
        </>
      )}
    </Section>
  );
}

/** ModelMenu says only what changed: a key that is absent must stay as it was. */
const pick = (patch: { model?: string | null; effort?: string | null }): Partial<RoomAgent> => {
  const out: Partial<RoomAgent> = {};
  if ("model" in patch) out.model = patch.model ?? undefined;
  if ("effort" in patch) out.effort = patch.effort ?? undefined;
  return out;
};

// --- phone, limits, about ------------------------------------------------------------------------

function Phone() {
  const device = useStore((s) => s.device);
  return (
    <Section
      title={device ? "This device" : "Phone"}
      sub={device ? undefined : "Rooms on your phone: over Wi‑Fi or Tailscale, with a code or QR. Each device has its own key, and you can revoke it."}
    >
      <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4">
        <PhonePanel />
      </div>
    </Section>
  );
}

function Limits() {
  const [limits, setLimits] = useState<LimitSnapshot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ limits: LimitSnapshot[] }>("GET", "/api/limits")
      .then((got) => setLimits(got.limits))
      .catch((err) => !(err instanceof Unauthorized) && setError(errText(err)));
  }, []);
  return (
    <Section title="Subscription limits" sub="What each CLI last reported about your subscription’s limits. Agoryx limits nothing itself — it only shows them.">
      {error ? (
        <ErrorNote>{error}</ErrorNote>
      ) : !limits ? (
        <Loading lines={3} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <LimitsCard kind="claude" limits={limits} />
          <LimitsCard kind="codex" limits={limits} />
        </div>
      )}
    </Section>
  );
}

interface Info {
  version?: string | null;
  url: string;
  pid: number;
  home: string;
  rooms: number;
}

function About() {
  const openDialog = useStore((s) => s.openDialog);
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Info>("GET", "/api/info")
      .then(setInfo)
      .catch((err) => !(err instanceof Unauthorized) && setError(errText(err)));
  }, []);
  const line = (label: string, value: ReactNode, mono = false) => (
    <div className="flex flex-col gap-0.5 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
      <span className="text-small text-muted-foreground">{label}</span>
      <span className={cn("min-w-0 break-all text-small sm:text-right", mono && "font-mono")}>{value}</span>
    </div>
  );
  return (
    <Section title="About Agoryx" sub="A shared room for people and agents: each agent works in its own native session, with all its tools.">
      {error ? (
        <ErrorNote>{error}</ErrorNote>
      ) : !info ? (
        <Loading lines={4} />
      ) : (
        <div className="flex flex-col divide-y divide-border rounded-xl border border-border bg-card px-4">
          {line("Version", info.version ?? "unknown")}
          {line("Daemon", `${info.url} · pid ${info.pid}`, true)}
          {line("Data", info.home, true)}
          {line("Rooms", info.rooms)}
        </div>
      )}
      <div>
        <Button variant="outline" onClick={() => openDialog({ kind: "help" })}>
          How it works
        </Button>
      </div>
    </Section>
  );
}

// --- the screen ---------------------------------------------------------------------------------

const BODY: Record<SettingsSection, () => ReactNode> = {
  general: () => <General />,
  profile: () => <Profile />,
  agents: () => <Agents />,
  phone: () => <Phone />,
  limits: () => <Limits />,
  about: () => <About />,
};

export function Settings({ section }: { section: SettingsSection }) {
  const go = useStore((s) => s.go);
  useEffect(() => {
    document.title = "Settings · Agoryx";
  }, [section]);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageBar crumbs={[{ label: "Settings", onClick: () => go({ kind: "settings", section: "general" }) }, { label: SECTIONS.find(({ id }) => id === section)?.label ?? "" }]} />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav
          aria-label="Settings sections"
          className="scroll-thin flex shrink-0 gap-1 overflow-x-auto border-b border-border/70 px-3 py-2 md:w-56 md:flex-col md:overflow-visible md:border-r md:border-b-0 md:bg-sidebar/50 md:px-3 md:py-5"
        >
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              aria-current={section === id ? "page" : undefined}
              onClick={() => go({ kind: "settings", section: id })}
              className={cn(
                "flex h-8 shrink-0 items-center gap-2 rounded-lg px-2.5 text-small whitespace-nowrap transition",
                section === id ? "bg-background font-medium text-foreground shadow-edge ring-1 ring-border/70" : "text-muted-foreground hover:bg-foreground/[0.045] hover:text-foreground",
              )}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </nav>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          <div key={section} className="mx-auto flex w-full max-w-[720px] flex-col px-5 pt-9 pb-16 sm:px-8">
            {BODY[section]()}
          </div>
        </div>
      </div>
    </div>
  );
}
