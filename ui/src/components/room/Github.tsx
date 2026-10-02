import { CheckIcon, CircleDashedIcon, GitMergeIcon, GitPullRequestArrowIcon, GitPullRequestClosedIcon, GitPullRequestDraftIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api, roomPath, Unauthorized } from "@/lib/api";
import { plural } from "@/lib/format";
import { nameOf } from "@/lib/room";
import { useStore } from "@/lib/store";
import type { PrPlan, PrState, PrStatus, RoomState } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Tip } from "./bits";

// GitHub in the room, as gh told the daemon: the pull requests agents opened or linked, the branch's one in the
// header, and the human's "Open PR". Without gh or a github.com remote the room has no `repo` and none of this shows.

const STATE = {
  open: { label: "Open", Icon: GitPullRequestArrowIcon, tone: "bg-add text-add-ink" },
  draft: { label: "Draft", Icon: GitPullRequestDraftIcon, tone: "bg-secondary text-secondary-foreground" },
  merged: { label: "Merged", Icon: GitMergeIcon, tone: "bg-meet-soft text-meet-ink" },
  closed: { label: "Closed", Icon: GitPullRequestClosedIcon, tone: "bg-destructive-soft text-destructive" },
} as const;

const live = (pr: PrState) => !pr.status || pr.status.state === "open" || pr.status.state === "draft";

/** The pull request of the folder's branch, else none. */
export const branchPr = (room: RoomState | undefined): PrState | undefined => {
  const branch = room?.repo?.branch;
  if (!branch) return undefined;
  const prs = room.prs ?? [];
  return prs.findLast((pr) => live(pr) && pr.status?.head === branch) ?? prs.findLast((pr) => pr.status?.head === branch);
};

function Checks({ status }: { status: PrStatus }) {
  if (!status.checks.length) return null;
  const failed = status.checks.filter((c) => c.result === "fail");
  const pending = status.checks.filter((c) => c.result === "pending");
  const [Icon, text, tone] = failed.length
    ? [XIcon, `${failed.length} of ${status.checks.length} checks failed`, "text-destructive"]
    : pending.length
      ? [CircleDashedIcon, `${pending.length} of ${status.checks.length} checks running`, "text-amber-ink"]
      : [CheckIcon, `${plural(status.checks.length, "check", "checks")} passed`, "text-add-ink"];
  return (
    <Tip
      tip={
        <ul className="space-y-0.5">
          {status.checks.map((c, i) => (
            <li key={i} className="flex items-center gap-1.5">
              {c.result === "pass" ? <CheckIcon className="size-3" /> : c.result === "fail" ? <XIcon className="size-3" /> : <CircleDashedIcon className="size-3" />}
              {c.name}
            </li>
          ))}
        </ul>
      }
    >
      <span className={cn("inline-flex items-center gap-1", tone)}>
        <Icon className="size-3.5" />
        {text}
      </span>
    </Tip>
  );
}

const mergeable = { yes: "No conflicts", conflicts: "Has conflicts", unknown: "Mergeability not known yet" } as const;
const review = (status: PrStatus) =>
  status.review === "approved"
    ? `Approved${status.reviewer ? ` by ${status.reviewer}` : ""}`
    : status.review === "changes"
      ? `Changes requested${status.reviewer ? ` by ${status.reviewer}` : ""}`
      : status.review === "required"
        ? "Review required"
        : null;

/** A pull request where it came into the room: what gh says of it now. */
export function PrCard({ pr }: { pr: PrState }) {
  const room = useStore((s) => s.snap?.state);
  const status = pr.status;
  const look = STATE[status?.state ?? "open"];
  const by = pr.by === room?.human ? "you" : nameOf(room, pr.by);
  const open = status?.state === "open" || status?.state === "draft";
  return (
    <div className="flex w-full max-w-xl min-w-0 flex-col gap-1.5 rounded-xl border border-border bg-card px-3.5 py-2.5 text-small shadow-soft" data-pr={pr.number}>
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-meta font-medium", look.tone)}>
          <look.Icon className="size-3.5" />
          {look.label}
        </span>
        <a href={pr.url} target="_blank" rel="noreferrer" className="min-w-0 truncate font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-current">
          <span className="font-mono text-muted-foreground">#{pr.number}</span> {status?.title ?? pr.url}
        </a>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted-foreground">
        <span>
          {pr.via === "linked" ? `Linked by ${by}` : pr.by === room?.human ? "Opened by you" : `Opened by ${by}`}
          {status?.head ? (
            <>
              {" · "}
              <span className="font-mono">{status.head}</span> → <span className="font-mono">{status.base}</span>
            </>
          ) : null}
        </span>
        {status ? (
          <span className="tabular font-mono">
            <span className="text-add-ink">+{status.additions}</span> <span className="text-del-ink">−{status.deletions}</span>
          </span>
        ) : null}
        {status ? <Checks status={status} /> : null}
        {status && open ? (
          <span className={cn(status.mergeable === "conflicts" && "text-destructive")}>{mergeable[status.mergeable]}</span>
        ) : null}
        {status && open && review(status) ? <span>{review(status)}</span> : null}
        {status?.state === "merged" ? <span>Merged into {status.base}{status.mergedBy ? ` by ${status.mergedBy}` : ""}</span> : null}
      </div>
    </div>
  );
}

/** The branch's pull request in the header: its number and state, a link to it. */
export function PrChip() {
  const pr = useStore((s) => branchPr(s.snap?.state));
  if (!pr) return null;
  const look = STATE[pr.status?.state ?? "open"];
  return (
    <Tip tip={`Pull request #${pr.number}${pr.status ? ` — ${look.label.toLowerCase()}: ${pr.status.title}` : ""}. Opens on GitHub.`}>
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => event.stopPropagation()}
        className="inline-flex shrink-0 items-center gap-0.5 font-mono text-micro text-faint hover:text-muted-foreground"
      >
        <look.Icon className="size-3" />#{pr.number}
      </a>
    </Tip>
  );
}

/** Whether the human can open a pull request from here: a GitHub repository, a branch of its own, none open for it. */
export const canOpenPr = (room: RoomState | undefined, driven: boolean | undefined): boolean => {
  const repo = room?.repo;
  return Boolean(driven && repo?.branch && repo.branch !== repo.base && !(room?.prs ?? []).some((pr) => live(pr) && pr.status?.head === repo.branch));
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The human's "Open PR": gh, signed in as them, pushes the branch and opens the pull request. The daemon says first
 * what it would push (branch, commit, base); it pushes only that, and refuses if the folder moved on since.
 */
export function OpenPr({ className }: { className?: string }) {
  const room = useStore((s) => s.snap?.state);
  const driven = useStore((s) => s.snap?.driven);
  const post = useStore((s) => s.post);
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<PrPlan | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const roomId = room?.id;
  useEffect(() => {
    if (!open || !roomId) return;
    let live = true;
    setPlan(null);
    setError("");
    api<PrPlan>("GET", roomPath(roomId, "/pr"))
      .then((next) => live && setPlan(next))
      .catch((e) => live && !(e instanceof Unauthorized) && setError(message(e)));
    return () => {
      live = false;
    };
  }, [open, roomId]);
  if (!room?.repo || !canOpenPr(room, driven)) return null;
  const busyTurn = room.turns.some((turn) => turn.status === "running");
  const go = async () => {
    if (!plan) return;
    setBusy(true);
    setError("");
    try {
      // All it was shown: the daemon refuses if the branch, the commit or where it goes changed since.
      const reply = (await post("/pr", { ...plan })) as { pr?: PrState };
      setOpen(false);
      if (reply.pr) toast.success(`Pull request #${reply.pr.number} opened`, { action: { label: "Open", onClick: () => window.open(reply.pr!.url, "_blank", "noreferrer") } });
    } catch (e) {
      if (!(e instanceof Unauthorized)) setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const code = (text: string) => <span className="font-mono text-foreground">{text}</span>;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn("h-8 gap-1.5", className)}
          aria-label="Open PR"
          disabled={busyTurn}
          title={busyTurn ? "A turn is running: open the pull request once it has ended" : "Open a pull request"}
        >
          <GitPullRequestArrowIcon />
          {/* While a turn runs the button can't be used, and the agents' chips need the room for their clocks. */}
          <span className={cn("hidden", !busyTurn && "@min-[44rem]:inline")}>Open PR</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 text-small">
        <p className="font-medium">Open a pull request</p>
        {plan ? (
          <p className="mt-1 text-muted-foreground">
            Pushes {code(plan.branch)} at {code(plan.sha.slice(0, 7))}
            {plan.ahead !== undefined ? ` (${plural(plan.ahead, "commit", "commits")} not on ${plan.base})` : ""} to {code(plan.remote)} and opens a pull request into{" "}
            {code(plan.base)} on {code(plan.repo)}, with gh signed in as you. The title and description come from the branch’s commits.
            {plan.pushUrl ? (
              <span className="mt-1 block text-amber-ink">
                git pushes {code(plan.remote)} to {code(plan.pushUrl)}, not to {code(plan.repo)} on GitHub.
              </span>
            ) : null}
          </p>
        ) : !error ? (
          <p className="mt-1 text-muted-foreground">Looking at the folder…</p>
        ) : null}
        {error ? <p className="mt-2 text-destructive">{error}</p> : null}
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={!plan || busy || busyTurn} onClick={() => void go()}>
            {busy ? "Opening…" : "Push and open"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
