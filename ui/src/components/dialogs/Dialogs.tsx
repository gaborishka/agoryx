import type { AgentUsage, RoomUsage, UsageTotals } from "@agora/usage";
import { ReceiptIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { ErrorNote, Hint, Loading } from "@/components/common/states";
import { Avatar, Stats } from "@/components/room/bits";
import { PhoneDialog } from "@/components/dialogs/PhoneDialog";
import { RefChip } from "@/components/table/OpCard";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError, roomPath, Unauthorized } from "@/lib/api";
import { keyLabel, SHORTCUTS, withMod } from "@/lib/keys";
import { cost, fullDate, names, plural, secs } from "@/lib/format";
import { errText, useLoad } from "@/lib/load";
import { DEFAULT_AGENTS, ink, participant } from "@/lib/room";
import { type DialogState, type TableFormOp, useStore } from "@/lib/store";
import type { FileChange, RoomAgent } from "@/lib/types";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

export const fail = (error: unknown) => {
  if (!(error instanceof Unauthorized)) toast.error(errText(error));
};

export function Shell({ title, sub, size = "md", children }: { title: ReactNode; sub?: ReactNode; size?: "sm" | "md" | "lg"; children: ReactNode }) {
  const openDialog = useStore((s) => s.openDialog);
  return (
    <Dialog open onOpenChange={(open) => !open && openDialog(null)}>
      <DialogContent
        className={cn(
          "flex max-h-[min(88vh,960px)] flex-col gap-0 overflow-hidden rounded-2xl p-0 shadow-lift",
          size === "sm" && "sm:max-w-md",
          size === "md" && "sm:max-w-2xl",
          size === "lg" && "sm:max-w-[min(1100px,94vw)]",
        )}
      >
        <DialogHeader className="shrink-0 gap-0.5 border-b border-border px-5 pt-4 pb-3.5 pr-12 text-left">
          <DialogTitle className="truncate text-lead">{title}</DialogTitle>
          <DialogDescription className={cn("truncate font-mono text-meta", !sub && "sr-only")}>{sub || title}</DialogDescription>
        </DialogHeader>
        <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 py-4 *:shrink-0">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

// --- returning the folder to a checkpoint --------------------------------------------

type RevertPlan = { to: string; undoOf?: number; subject: string; tree: string; changes: FileChange[]; since?: string[]; busy: string | null };

/** The daemon's refusals by code, in the room's words (its own text is for the CLI). */
const REVERT_ERRORS: Record<string, string> = {
  bad: "This room has no such checkpoint.",
  agent: "Only a human can revert the folder.",
  missing: "This checkpoint is no longer in the folder’s repository.",
  undone: "This revert has already been undone.",
  later: "Only the latest revert can be undone.",
  busy: "Agents are working in the folder. Stop them first.",
  changed: "The folder changed while you were looking. Here is what will change now.",
  same: "The folder already looks like this — nothing to change.",
  failed: "git couldn’t read or write the folder, so nothing was changed.",
};
const revertError = (error: unknown) => {
  const code = error instanceof ApiError ? error.body.code : undefined;
  return typeof code === "string" && REVERT_ERRORS[code] ? REVERT_ERRORS[code] : errText(error);
};

const REVERT_HOW: Record<string, { text: string; className: string }> = {
  A: { text: "comes back", className: "text-add-ink" },
  D: { text: "goes away", className: "text-del-ink" },
};

function RevertDialog({ sha, undo }: { sha?: string; undo?: number }) {
  const room = useStore((s) => s.snap?.state);
  const post = useStore((s) => s.post);
  const openDialog = useStore((s) => s.openDialog);
  const roomId = room?.id ?? "";
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const query = undo !== undefined ? `undo=${undo}` : sha ? `sha=${encodeURIComponent(sha)}` : null;
  const plan = useLoad(query ? `${roomId}:${query}:${nonce}` : null, () =>
    api<RevertPlan>("GET", `${roomPath(roomId, "/revert")}?${query}`).catch((error: unknown) => {
      throw error instanceof Unauthorized ? error : new Error(revertError(error));
    }),
  );
  if (!query) return <CheckpointsDialog />;
  const again = () => setNonce((n) => n + 1);
  const stop = async () => {
    setBusy(true);
    try {
      await post("/stop");
      again();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };
  const go = async () => {
    if (!plan.data) return;
    setBusy(true);
    try {
      await post("/revert", { ...(undo !== undefined ? { undo } : { sha: plan.data.to }), tree: plan.data.tree });
      toast.success(undo !== undefined ? "Revert undone" : "Folder reverted");
      openDialog(null);
    } catch (error) {
      const code = error instanceof ApiError ? error.body.code : undefined;
      if (!(error instanceof Unauthorized)) toast.error(revertError(error));
      // The folder or the room moved on: show what is true now.
      if (code === "changed" || code === "busy" || code === "same") again();
    } finally {
      setBusy(false);
    }
  };
  let body: ReactNode = <Loading />;
  if (plan.error) body = <ErrorNote>{plan.error}</ErrorNote>;
  else if (plan.data) {
    const { changes, subject } = plan.data;
    body = (
      <>
        {undo !== undefined ? (
          <Hint>Files will go back to how they were before this revert.</Hint>
        ) : (
          <Hint>
            The folder will match checkpoint <span className="font-mono text-foreground">{plan.data.to.slice(0, 7)}</span>: {subject}
          </Hint>
        )}
        {plan.data.busy ? (
          <div className="flex flex-wrap items-center gap-3 rounded-xl bg-destructive-soft px-3.5 py-3 text-small text-destructive">
            <span className="flex-1">Agents are working in the folder. Stop them before you revert it.</span>
            <Button size="sm" variant="outline" disabled={busy} onClick={stop}>
              Stop agents
            </Button>
          </div>
        ) : null}
        {plan.data.since?.length ? (
          <div className="rounded-xl bg-destructive-soft px-3.5 py-3 text-small text-destructive">
            Files in the folder changed after the revert — those changes will be lost too: <span className="font-mono">{plan.data.since.slice(0, 12).join(", ")}</span>
            {plan.data.since.length > 12 ? ` and ${plan.data.since.length - 12} more` : ""}.
          </div>
        ) : null}
        {changes.length ? (
          <div className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border">
            {changes.map((c) => {
              const how = REVERT_HOW[c.status] ?? { text: "changes", className: "text-foreground" };
              return (
                <div key={c.path} className="flex items-center gap-2 px-3 py-1.5 text-meta">
                  <span className="min-w-0 flex-1 truncate font-mono">{c.path}</span>
                  <Stats added={c.added} removed={c.removed} binary={c.added === null} />
                  <span className={cn("w-20 text-right", how.className)}>{how.text}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <Hint>The folder already looks like this — nothing to change.</Hint>
        )}
        <Hint>
          Agoryx saves the folder as it is first, so you can undo this. The conversation and the table stay; agents learn about it on their next turn. Files in
          .gitignore are not touched.
        </Hint>
      </>
    );
  }
  const count = plan.data?.changes.length ?? 0;
  return (
    <Shell title={undo !== undefined ? "Undo revert" : "Revert folder to here"} sub={room?.workspace} size="md">
      {body}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => openDialog(null)}>
          Cancel
        </Button>
        <Button type="button" variant="destructive" disabled={busy || !count || Boolean(plan.data?.busy)} onClick={go}>
          {undo !== undefined ? "Undo revert" : `Revert ${count ? plural(count, "file", "files") : "folder"}`}
        </Button>
      </DialogFooter>
    </Shell>
  );
}

/** No checkpoint picked: the room's checkpoints to pick from, or how to get them. */
function CheckpointsDialog() {
  const room = useStore((s) => s.snap?.state);
  const post = useStore((s) => s.post);
  const openDialog = useStore((s) => s.openDialog);
  const roomId = room?.id ?? "";
  const commits = [...(room?.commits ?? [])].reverse();
  const status = useLoad(commits.length ? null : `${roomId}:revert-status`, () => api<{ tracking: "git" | "shadow" | "none" }>("GET", roomPath(roomId, "/revert")));
  const turnOn = async () => {
    try {
      await post("/settings", { autoCommit: true });
      toast.success("Checkpoints turned on");
    } catch (error) {
      fail(error);
    }
  };
  let body: ReactNode;
  if (commits.length) {
    body = (
      <div className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border">
        {commits.map((c) => (
          <div key={c.sha} className="flex items-center gap-2 px-3 py-1.5 text-meta">
            <span className="font-mono text-muted-foreground">{c.sha.slice(0, 7)}</span>
            <span className="min-w-0 flex-1 truncate">{c.subject}</span>
            <Button variant="ghost" size="xs" onClick={() => openDialog({ kind: "revert", sha: c.sha })}>
              Revert to here
            </Button>
          </div>
        ))}
      </div>
    );
  } else if (status.error) body = <ErrorNote>{status.error}</ErrorNote>;
  else if (!status.data) body = <Loading />;
  else if (status.data.tracking !== "git") {
    body = (
      <Hint>
        A checkpoint is a git commit, and this folder isn’t a git repository, so the room doesn’t make them. Run <code className="font-mono">git init</code> in the
        folder and turn checkpoints on in the room settings.
      </Hint>
    );
  } else if (!room?.settings.autoCommit) {
    body = (
      <>
        <Hint>No checkpoints. Turn them on and the room makes a git commit after every round, so you can revert the folder to it.</Hint>
        <Button className="w-fit" size="sm" onClick={turnOn}>
          Turn on checkpoints
        </Button>
      </>
    );
  } else {
    body = <Hint>No checkpoints yet. The first one appears when agents finish a round in which they changed files.</Hint>;
  }
  return (
    <Shell title="Revert folder" sub={room?.workspace} size="md">
      {body}
    </Shell>
  );
}


// --- room settings -----------------------------------------------------------------------

function SettingsDialog() {
  const room = useStore((s) => s.snap?.state);
  const post = useStore((s) => s.post);
  const openDialog = useStore((s) => s.openDialog);
  const s = room?.settings;
  const [limited, setLimited] = useState(typeof s?.budget === "number");
  const [budget, setBudget] = useState(String(s?.budget ?? 8));
  const [access, setAccess] = useState<string>(s?.access ?? "workspace");
  const [network, setNetwork] = useState(s?.network ?? true);
  const [autoCommit, setAutoCommit] = useState(s?.autoCommit ?? true);
  const [doc, setDoc] = useState(s?.doc ?? "");
  const [busy, setBusy] = useState(false);
  if (!room || !s) return null;
  return (
    <Shell title="Room settings" sub={room.name} size="sm">
      <form
        className="flex flex-col gap-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            await post("/settings", {
              budget: limited ? Math.min(100, Math.max(1, Number.parseInt(budget, 10) || s.budget || 8)) : null,
              access,
              network,
              autoCommit,
              doc: doc.trim() || null,
            });
            openDialog(null);
            toast.success("Saved");
          } catch (error) {
            fail(error);
            setBusy(false);
          }
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center justify-between gap-3 text-sm">
            Turn limit after your message
            <Switch checked={limited} onCheckedChange={setLimited} />
          </label>
          {limited && (
            <Input id="s-budget" aria-label="Agent turns after your message" type="number" min={1} max={100} value={budget} onChange={(e) => setBudget(e.target.value)} className="w-28" />
          )}
          <Hint>
            {limited
              ? "How many turns agents take after your message before they stop and wait for you."
              : "No limit: agents work while anyone has something to add, and the room goes quiet when everyone passes. You can stop them at any time."}
          </Hint>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Agent access</Label>
          <Select value={access} onValueChange={setAccess}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="workspace">Read and write in the working folder</SelectItem>
              <SelectItem value="readonly">Read-only</SelectItem>
            </SelectContent>
          </Select>
          <Hint>Agents work as they do in your terminal: Claude with your settings, Codex in its own sandbox. “Read-only” or network off limits both.</Hint>
        </div>
        <label className="flex items-center justify-between gap-3 text-sm">
          Network for agent commands
          <Switch checked={network} onCheckedChange={setNetwork} />
        </label>
        <label className="flex items-center justify-between gap-3 text-sm">
          {t.checkpoint.setting}
          <Switch checked={autoCommit} onCheckedChange={setAutoCommit} />
        </label>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="s-doc">Shared document</Label>
          <Input id="s-doc" value={doc} onChange={(e) => setDoc(e.target.value)} placeholder="README.md" spellCheck={false} className="font-mono text-small" />
          <Hint>The file the room writes together. Leave empty for none.</Hint>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => openDialog(null)}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            Save
          </Button>
        </DialogFooter>
      </form>
    </Shell>
  );
}

// --- help -------------------------------------------------------------------------------------

function HelpDialog() {
  const openDialog = useStore((s) => s.openDialog);
  // The room's own agents (any number, any mix); outside a room — the default pair.
  const agents = useStore((s) => s.snap?.state.agents) ?? DEFAULT_AGENTS;
  const at = (agent: RoomAgent) => {
    const who = participant({ agents }, agent.id);
    return (
      <span
        key={agent.id}
        style={ink(who)}
        className={cn("rounded-md px-1.5 py-0.5 font-mono text-small", who.tone === "codex" ? "bg-codex-soft text-codex" : "bg-claude-soft text-claude")}
      >
        @{agent.id}
      </span>
    );
  };
  const li = "relative pl-5 before:absolute before:top-[0.6em] before:left-1 before:size-1.5 before:rounded-full before:bg-primary/50";
  return (
    <Shell title="How it works">
      <div className="flex flex-col gap-3.5 text-body leading-relaxed">
        <p>
          <b>A room</b> is one conversation for you and {names(agents.map((a) => a.label))}. Agoryx sets the context, not roles: agents work in their own native sessions
          with all their tools.
        </p>
        <ul className="flex flex-col gap-2">
          <li className={li}>
            Agents take on your message <b>at the same time</b>, from the same starting point, and tell each other along the way who is doing what.
          </li>
          <li className={li}>
            Then they talk <b>in turns</b>: each sees everything said before. An agent with nothing to add passes.
          </li>
          <li className={li}>With a turn limit set, the conversation stops after that many turns and waits for you. Set it in the room settings.</li>
          <li className={li}>
            {agents.map((agent, i) => [i ? (i === agents.length - 1 ? " or " : ", ") : null, at(agent)])} — to address just one.
          </li>
          <li className={li}>
            <b>Table</b> — questions, options, objections and decisions, when there are real alternatives.
          </li>
          <li className={li}>
            <b>Document</b> — one shared file, every version with its author.
          </li>
        </ul>
        <Hint className="text-small">
          Without a browser: <code className="font-mono">agoryx tail -f</code>, <code className="font-mono">agoryx say "…"</code>, <code className="font-mono">agoryx table</code>.
          You can open an agent’s session in Claude Code or Codex — the conversation there reaches the room too.{" "}
          <button type="button" className="font-medium text-primary underline-offset-2 hover:underline" onClick={() => openDialog({ kind: "keys" })}>
            Shortcuts
          </button>{" "}
          <Kbd>?</Kbd>

        </Hint>
      </div>
    </Shell>
  );
}

// --- keys ---------------------------------------------------------------------------------------

function KeysDialog() {
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))];
  return (
    <Shell title="Keyboard shortcuts" size="sm">
      <div className="flex flex-col gap-4">
        {groups.map((group) => (
          <section key={group} className="flex flex-col gap-1">
            <h3 className="text-meta font-medium text-muted-foreground">{group}</h3>
            <dl className="flex flex-col">
              {SHORTCUTS.filter((s) => s.group === group).map((s) => (
                <div key={s.id} className="flex items-center gap-3 border-b border-border/60 py-1.5 last:border-0">
                  <dt className="min-w-0 flex-1 text-ui">{s.label}</dt>
                  <dd>
                    <Kbd className="font-mono">{keyLabel(s.id)}</Kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Shell>
  );
}

// --- table forms --------------------------------------------------------------------------------

type Field = { name: string; label: string; area?: boolean; placeholder?: string; required?: boolean };
const FORMS: Record<TableFormOp, { title: string; fields: Field[] }> = {
  ask: { title: "New question", fields: [{ name: "text", label: "Question", area: true, placeholder: "What needs deciding?", required: true }] },
  propose: {
    title: "New proposal",
    fields: [
      { name: "title", label: "Short title", placeholder: "e.g. SQLite instead of JSON", required: true },
      { name: "body", label: "What and why", area: true },
      { name: "file", label: "File in the working folder (optional)", placeholder: "mockup.html" },
    ],
  },
  object: { title: "Objection", fields: [{ name: "text", label: "Why not", area: true, placeholder: "What exactly is wrong, and what would change your mind?", required: true }] },
  support: { title: "Support", fields: [{ name: "text", label: "Why", area: true, required: true }] },
  evidence: {
    title: "Evidence",
    fields: [
      { name: "text", label: "What was established", area: true, required: true },
      { name: "source", label: "Source (URL or file)" },
    ],
  },
  decide: { title: "Choose", fields: [{ name: "note", label: "Why this option (optional)", area: true }] },
  settle: { title: "Conclusion", fields: [{ name: "text", label: "What we now take as settled", area: true, required: true }] },
  next: { title: "Next step", fields: [{ name: "text", label: "A concrete action", area: true, required: true }] },
};

function TableFormDialog({ op, target, q }: { op: TableFormOp; target?: string; q?: string }) {
  const room = useStore((s) => s.snap?.state);
  const post = useStore((s) => s.post);
  const openDialog = useStore((s) => s.openDialog);
  const [values, setValues] = useState<Record<string, string>>({ q: q ?? "" });
  const [busy, setBusy] = useState(false);
  if (!room) return null;
  const form = FORMS[op];
  const option = target ? room.table.options.find((o) => o.id === target) : undefined;
  const open = room.table.questions.filter((x) => x.status === "open");
  const set = (name: string, value: string) => setValues((v) => ({ ...v, [name]: value }));
  const submit = async () => {
    const v = Object.fromEntries(Object.entries(values).map(([k, x]) => [k, x.trim()]));
    let body: Record<string, unknown> = { op };
    if (op === "propose") body = { op, title: v.title, ...(v.body ? { body: v.body } : {}), ...(v.file ? { file: v.file } : {}), ...(v.q ? { q: v.q } : {}) };
    else if (op === "decide") body = { op, target, ...(v.note ? { note: v.note } : {}) };
    else if (op === "object" || op === "support" || op === "evidence") body = { op, target, text: v.text, ...(v.source ? { source: v.source } : {}) };
    else if (op === "settle") body = { op, text: v.text, ...(v.q ? { q: v.q } : {}) };
    else body = { op, text: v.text };
    setBusy(true);
    try {
      await post("/table", body);
      openDialog(null);
    } catch (error) {
      fail(error);
      setBusy(false);
    }
  };
  const missing = form.fields.some((f) => f.required && !values[f.name]?.trim());
  return (
    <Shell title={op === "decide" ? `Choose ${target}` : form.title} size="sm">
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {option ? (
          <div className="flex items-start gap-2 rounded-xl border border-border bg-muted/50 px-3 py-2.5">
            <RefChip id={option.id} className="mt-0.5" />
            <div className="min-w-0">
              <b className="text-ui leading-snug">{option.title}</b>
              <div className="text-meta text-muted-foreground">{participant(room, option.by).label}</div>
            </div>
          </div>
        ) : null}
        {form.fields.map((f, index) => (
          <div key={f.name} className="flex flex-col gap-1.5">
            <Label htmlFor={`tf-${f.name}`}>{f.label}</Label>
            {f.area ? (
              <Textarea
                id={`tf-${f.name}`}
                autoFocus={index === 0}
                value={values[f.name] ?? ""}
                onChange={(e) => set(f.name, e.target.value)}
                placeholder={f.placeholder}
                className="min-h-24"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !missing) {
                    e.preventDefault();
                    void submit();
                  }
                }}
              />
            ) : (
              <Input id={`tf-${f.name}`} autoFocus={index === 0} value={values[f.name] ?? ""} onChange={(e) => set(f.name, e.target.value)} placeholder={f.placeholder} />
            )}
          </div>
        ))}
        {(op === "propose" || op === "settle") && open.length ? (
          <div className="flex flex-col gap-1.5">
            <Label>{op === "settle" ? "Answers a question (and closes it)" : "For question"}</Label>
            <Select value={values.q || "none"} onValueChange={(v) => set("q", v === "none" ? "" : v)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{op === "settle" ? "— just agreed —" : "— no question —"}</SelectItem>
                {open.map((x) => (
                  <SelectItem key={x.id} value={x.id}>
                    {x.id} · {x.text.slice(0, 70)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <Hint>{op === "decide" ? "The decision appears in the conversation, and agents continue from it." : "Agents see this on their next turn."}</Hint>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => openDialog(null)}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || missing} title={form.fields.some((f) => f.area) ? withMod("Enter") : undefined}>
            {op === "decide" ? `Choose ${target}` : "Add to the table"}
          </Button>
        </DialogFooter>
      </form>
    </Shell>
  );
}

// --- what the room's wakes took -------------------------------------------------

const ERROR_LABEL: Record<string, string> = {
  rate_limit: "limit",
  auth: "sign-in",
  context: "context",
  timeout: "timed out",
  spawn: "launch",
  session: "session",
  unknown: "other",
};

/**
 * "12s · ≈$0.041 · 3.2k/410 tok." — what a set of turns took, with only what the CLIs reported. The $ is Claude
 * Code's estimate at API prices, not a charge: on a subscription nothing is billed per turn.
 */
const took = (totals: UsageTotals) => {
  if (!totals.turns) return "—";
  const parts = [secs(totals.ms)];
  if (totals.costTurns) parts.push(`≈${cost(totals.costUsd)}`);
  if (totals.inputTokens || totals.outputTokens) parts.push(`${tokens(totals.inputTokens)}/${tokens(totals.outputTokens)} tok.`);
  return parts.join(" · ");
};
const tokens = (n: number) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`);

function UsageDialog() {
  const room = useStore((s) => s.snap?.state);
  const roomId = room?.id ?? "";
  const turns = room?.turns.length ?? 0;
  // Read again when a turn is added or ends: the numbers are the turns' own.
  const ended = room?.turns.filter((turn) => turn.status !== "running").length ?? 0;
  const usage = useLoad(`${roomId}:usage:${turns}:${ended}`, () => api<RoomUsage>("GET", roomPath(roomId, "/usage")));
  let body: ReactNode = <Loading />;
  if (usage.error) body = <ErrorNote>{usage.error}</ErrorNote>;
  else if (usage.data) {
    const data = usage.data;
    const priced = data.total.costTurns > 0;
    const codex = data.agents.some((agent) => agent.kind === "codex" && agent.wakes);
    body = data.total.turns || data.agents.some((agent) => agent.running) ? (
      <>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Figure label="turns" value={String(data.total.turns)} />
          <Figure label="replies" value={String(data.outcomes.replied.turns)} />
          <Figure label="passes" value={String(data.outcomes.passed.turns)} sub={data.outcomes.passed.turns ? took(data.outcomes.passed) : undefined} />
          <Figure
            label="failures"
            value={String(data.outcomes.failed.turns)}
            sub={data.outcomes.stopped.turns ? `and ${data.outcomes.stopped.turns} stopped` : undefined}
          />
        </div>
        <div className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {data.agents.map((agent) => (
            <AgentUsageRow key={agent.agent} usage={agent} />
          ))}
        </div>
        <Hint>
          Only what has already happened, from the room’s recorded turns. Time runs from a turn’s start to its end.
          {priced ? " ≈$ is Claude Code’s estimate at API prices, not a bill: on a subscription you don’t pay per turn." : ""}
          {priced && codex ? " Codex gives no such estimate, only tokens." : ""}
          {data.from ? ` Since ${fullDate(data.from)}.` : ""}
        </Hint>
      </>
    ) : (
      <Hint>No turns yet — nothing to count.</Hint>
    );
  }
  return (
    <Shell
      title={
        <span className="flex items-center gap-2">
          <ReceiptIcon className="size-4.5 text-primary" />
          Room usage
        </span>
      }
      sub={room?.name}
    >
      {body}
    </Shell>
  );
}

function Figure({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl bg-muted/60 px-3 py-2">
      <div className="text-lead font-medium tabular-nums">{value}</div>
      <div className="text-meta text-muted-foreground">{label}</div>
      {sub ? <div className="truncate text-micro text-faint">{sub}</div> : null}
    </div>
  );
}

function AgentUsageRow({ usage }: { usage: AgentUsage }) {
  const room = useStore((s) => s.snap?.state);
  const productive = usage.outcomes.replied;
  const passed = usage.outcomes.passed;
  const wokenBy = Object.entries(usage.wokenBy).sort((a, b) => b[1] - a[1]);
  const errors = Object.entries(usage.errors);
  return (
    <div className="flex flex-col gap-1.5 px-3.5 py-3">
      <div className="flex items-center gap-2">
        <Avatar handle={usage.agent} size={22} />
        <span className="text-ui font-medium">{usage.label}</span>
        <span className="ml-auto text-meta tabular-nums text-muted-foreground">
          {usage.wakes ? `woken ${plural(usage.wakes, "time", "times")}` : "not woken yet"}
          {usage.running ? ` · ${usage.running} now` : ""}
        </span>
      </div>
      {usage.wakes ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-small">
          <dt className="text-muted-foreground">replies {productive.turns}</dt>
          <dd className="tabular-nums">{took(productive)}</dd>
          <dt className="text-muted-foreground">passes {passed.turns}</dt>
          <dd className="tabular-nums">{took(passed)}</dd>
          {usage.outcomes.failed.turns ? (
            <>
              <dt className="text-destructive">failures {usage.outcomes.failed.turns}</dt>
              <dd className="tabular-nums">
                {took(usage.outcomes.failed)}
                {errors.length ? <span className="text-muted-foreground"> · {errors.map(([kind, n]) => `${ERROR_LABEL[kind] ?? kind} ${n}`).join(", ")}</span> : null}
              </dd>
            </>
          ) : null}
          {usage.outcomes.stopped.turns ? (
            <>
              <dt className="text-muted-foreground">stopped {usage.outcomes.stopped.turns}</dt>
              <dd className="tabular-nums">{took(usage.outcomes.stopped)}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {wokenBy.length ? (
        <div className="text-meta text-muted-foreground">
          woken by: {wokenBy.map(([who, n]) => `${participant(room, who).label} ${n}`).join(", ")}
        </div>
      ) : null}
    </div>
  );
}

const render = (d: DialogState) => {
  switch (d.kind) {
    case "revert":
      return <RevertDialog sha={d.sha} undo={d.undo} />;
    case "settings":
      return <SettingsDialog />;
    case "help":
      return <HelpDialog />;
    case "keys":
      return <KeysDialog />;
    case "usage":
      return <UsageDialog />;
    case "phone":
      return <PhoneDialog />;
    case "table-form":
      return <TableFormDialog key={`${d.op}:${d.target ?? ""}`} op={d.op} target={d.target} q={d.q} />;
  }
};

export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  const snap = useStore((s) => Boolean(s.snap));
  if (!dialog) return null;
  if (dialog.kind !== "help" && dialog.kind !== "keys" && dialog.kind !== "phone" && !snap) return null;
  return render(dialog);
}

