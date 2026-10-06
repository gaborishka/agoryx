import {
  ArrowDownIcon,
  ArrowRightIcon,
  CheckCheckIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  Clock3Icon,
  DownloadIcon,
  EyeIcon,
  FileTextIcon,
  HistoryIcon,
  LockKeyholeIcon,
  Maximize2Icon,
  MessageSquareIcon,
  Minimize2Icon,
  MoreHorizontalIcon,
  PlusIcon,
  RefreshCwIcon,
  ScaleIcon,
  ShieldCheckIcon,
  SquareIcon,
  SwordsIcon,
  TrophyIcon,
  UsersRoundIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  WorkflowCheck,
  WorkflowEntry,
  WorkflowRound,
  WorkflowRun,
} from "@agora/workflow-types";
import {
  Markdown as AppMarkdown,
  type MarkdownProps,
} from "@/components/md/Markdown";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api, roomPath } from "@/lib/api";
import { useStore } from "@/lib/store";
import { phaseName, WORK_MODES, type ProtocolMode } from "@/lib/workflow";
import { activeWorkflow, useWorkflow } from "@/lib/workflow-state";
import { workflowDiscussion, workflowRecord } from "@/lib/workflow-record";
import { cn } from "@/lib/utils";
import {
  parseWorkflowArtifacts,
  visualArtifact,
} from "@/lib/workflow-artifacts";
import { AgentStage } from "./AgentStage";
import { WorkflowSetup } from "./WorkflowSetup";
import { WorkflowReading } from "./WorkflowReading";
import { WorkflowChecks as Checks } from "./WorkflowChecks";
import { CriteriaGridView, DebateMap, Standings } from "./WorkflowDigest";
import { councilStandings, debateDigest, tournamentStandings } from "@/lib/workflow-digest";

function Markdown(props: MarkdownProps) {
  return <AppMarkdown {...props} literalHtml />;
}

const PHASES: Record<ProtocolMode, string[]> = {
  verification: ["creation", "review", "repair", "recheck", "report"],
  council: ["answers", "peer_review", "synthesis", "dissent_audit"],
  tournament: ["prototypes", "evaluation", "selection", "implementation"],
  debate: [
    "openings",
    "steelman",
    "acceptance",
    "new_arguments",
    "rebuttal",
    "verdict",
  ],
};
const STRUCTURED_PHASES = new Set([
  "review",
  "recheck",
  "peer_review",
  "dissent_audit",
  "evaluation",
  "openings",
  "acceptance",
  "new_arguments",
  "rebuttal",
  "verdict",
]);
const labels: Record<string, string> = {
  new_arguments: "New arguments",
  creation: "Create",
  repair: "Revise",
  dissent_audit: "Dissent check",
  evaluation: "Independent comparison",
  implementation: "Implementation",
  openings: "Opening positions",
  steelman_repair: "Restatement repair",
  disagreement: "Unresolved disagreement",
};
const name = (phase: string) => labels[phase] ?? phaseName(phase);
const parse = (text: string | undefined): Record<string, unknown> | null => {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(
      text.replace(/^\s*```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, ""),
    );
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};
const str = (value: unknown) => (typeof value === "string" ? value : "");
const strings = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((s): s is string => typeof s === "string")
    : [];
const findRound = (run: WorkflowRun, ...phases: string[]) =>
  [...run.rounds].reverse().find((r) => phases.includes(r.phase));
const revealed = (round: WorkflowRound | undefined) =>
  round?.status === "revealed";
const checkRows = (value: unknown): WorkflowCheck[] =>
  Array.isArray(value)
    ? value.filter(
        (c): c is WorkflowCheck =>
          c &&
          typeof c === "object" &&
          typeof c.criterion === "string" &&
          ["passed", "failed", "unknown"].includes(c.status) &&
          typeof c.evidence === "string",
      )
    : [];
const identity = (run: WorkflowRun, id: string) =>
  run.participants.find((p) => p.id === id)?.label ?? id;

function save(
  name: string,
  text: string,
  type = "text/markdown;charset=utf-8",
) {
  const link = document.createElement("a");
  const url = URL.createObjectURL(new Blob([text], { type }));
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function discussRun(run: WorkflowRun) {
  useStore.getState().setView("chat");
  useStore.getState().composeDraft(workflowDiscussion(run));
}
function exportRun(run: WorkflowRun) {
  save(`agoryx-${run.mode}-${run.id}.md`, workflowRecord(run));
}

function Section({
  title,
  detail,
  icon,
  children,
  className,
  emphasis = false,
  id,
}: {
  title: string;
  detail?: string;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
  emphasis?: boolean;
  id?: string;
}) {
  return (
    <section
      id={id}
      className={cn(
        "min-w-0 rounded-2xl border border-border bg-card shadow-edge",
        className,
      )}
    >
      <header
        className={cn(
          "flex items-start gap-2.5 border-b border-border/70",
          emphasis ? "px-5 py-4" : "px-4 py-3.5",
        )}
      >
        <span className="mt-0.5 text-muted-foreground">{icon}</span>
        <div className="min-w-0 flex-1">
          <h2
            className={
              emphasis
                ? "font-display text-[22px] leading-tight font-medium tracking-tight"
                : "text-small font-semibold"
            }
          >
            {title}
          </h2>
          {detail ? (
            <p className="mt-0.5 text-meta leading-relaxed text-faint">
              {detail}
            </p>
          ) : null}
        </div>
      </header>
      <div className={emphasis ? "p-5" : "p-4"}>{children}</div>
    </section>
  );
}
function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="py-5 text-small leading-relaxed text-faint">{children}</p>
  );
}
function Status({ status }: { status: WorkflowRun["status"] }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-meta",
        status === "completed"
          ? "bg-human-soft text-human"
          : status === "failed"
            ? "bg-destructive-soft text-destructive"
            : status === "waiting_user"
              ? "bg-amber-soft text-amber-ink"
              : "bg-muted text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full bg-current",
          status === "running" && "animate-breathe",
        )}
      />
      {
        {
          running: "In progress",
          waiting_user: "Your decision",
          completed: "Completed",
          failed: "Needs attention",
          cancelled: "Stopped",
        }[status]
      }
    </span>
  );
}
function Sealed({ round, run }: { round: WorkflowRound; run: WorkflowRun }) {
  const ready = round.entries.filter((e) => e.status === "complete").length;
  const interrupted =
    ["cancelled", "failed"].includes(run.status) || round.status === "failed";
  return (
    <div className="sealed-room">
      <header>
        <LockKeyholeIcon size={18} />
        <div>
          <h3>
            {interrupted
              ? "This round stays sealed"
              : "Independent work in progress"}
          </h3>
          <p>
            {interrupted
              ? "Revealed work is preserved. Unfinished submissions remain private."
              : "The system opens the whole round together. No partial answers or working files are visible."}
          </p>
        </div>
        <span>
          {ready}/{round.entries.length} sealed
        </span>
      </header>
      <AgentStage
        mode={run.mode}
        phase={round.phase}
        seats={round.entries.map((entry) => ({
          id: entry.id,
          role:
            run.participants.find((p) => p.id === entry.participantId)?.role ??
            "member",
          node: (
            <div className="sealed-seat">
              <div className="sealed-seat-person">
                <span>
                  <LockKeyholeIcon size={14} />
                </span>
                <strong>{identity(run, entry.participantId)}</strong>
              </div>
              <div className="sealed-seat-state">
                {entry.status === "complete" ? (
                  <CheckIcon size={13} />
                ) : (
                  <Clock3Icon size={13} />
                )}
                <span>
                  {entry.status === "complete"
                    ? "Ready · sealed"
                    : run.status === "cancelled"
                      ? "Stopped"
                      : interrupted
                        ? "Interrupted"
                        : entry.status === "running"
                          ? "Working privately"
                          : "Waiting to begin"}
                </span>
              </div>
            </div>
          ),
        }))}
      />
    </div>
  );
}

function Content({ text }: { text: string }) {
  const data = parse(text);
  if (!data) return <Markdown text={text} className="text-small" />;
  // Free-form answers can also be JSON. Only interpret argument/concession lists
  // when they have the protocol's shape; arbitrary artifacts must remain readable.
  const records = (value: unknown, fields: string[]) =>
    Array.isArray(value) &&
    value.every(
      (item: unknown) =>
        item !== null &&
        typeof item === "object" &&
        fields.every(
          (field) =>
            typeof (item as Record<string, unknown>)[field] === "string",
        ),
    );
  if (
    (data.arguments !== undefined &&
      !records(data.arguments, ["id", "text"])) ||
    (data.concessions !== undefined &&
      !records(data.concessions, ["argumentId", "reason"]))
  )
    return <Markdown text={text} className="text-small" />;
  const intro =
    str(data.summary) ||
    str(data.position) ||
    str(data.critique) ||
    str(data.feedback) ||
    str(data.rebuttal);
  const checks = checkRows(data.checks);
  return (
    <div className="space-y-3">
      {intro ? <Markdown text={intro} /> : null}
      {Array.isArray(data.ranking) ? (
        <ol aria-label="Ranking" className="space-y-2">
          {strings(data.ranking).map((answer, i) => (
            <li
              key={answer}
              className="flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-small"
            >
              <span className="font-mono text-meta text-faint">
                {String(i + 1).padStart(2, "0")}
              </span>
              {answer}
            </li>
          ))}
        </ol>
      ) : null}
      {Array.isArray(data.arguments) ? (
        <ol className="space-y-3">
          {data.arguments.map((argument, i) => {
            const a = argument as { id?: string; text?: string };
            return (
              <li key={a.id ?? i} className="border-l-2 border-border pl-3">
                <span className="font-mono text-micro text-faint">{a.id}</span>
                <Markdown text={a.text ?? ""} />
              </li>
            );
          })}
        </ol>
      ) : null}
      {typeof data.accepted === "boolean" ? (
        <div
          className={cn(
            "rounded-xl p-3 text-small",
            data.accepted
              ? "bg-human-soft text-human"
              : "bg-amber-soft text-amber-ink",
          )}
        >
          <p className="flex items-center gap-2 font-medium">
            {data.accepted ? (
              <CheckCheckIcon className="size-4" />
            ) : (
              <RefreshCwIcon className="size-4" />
            )}
            {data.accepted
              ? "Original speaker accepts the restatement"
              : "Restatement needs repair"}
          </p>
          {str(data.corrections) ? (
            <p className="mt-2 leading-relaxed">{str(data.corrections)}</p>
          ) : null}
        </div>
      ) : null}
      {checks.length ? <Checks checks={checks} /> : null}
      {Array.isArray(data.concessions) && data.concessions.length ? (
        <div className="rounded-xl bg-human-soft/60 p-3">
          <h4 className="mb-2 text-meta font-semibold text-human">
            Concessions tied to new arguments
          </h4>
          {data.concessions.map((value, i) => {
            const concession = value as {
              argumentId?: string;
              reason?: string;
            };
            return (
              <p key={i} className="text-small leading-relaxed">
                <code className="text-meta">{concession.argumentId}</code> ·{" "}
                {concession.reason}
              </p>
            );
          })}
        </div>
      ) : null}
      {str(data.remainingDisagreement) ? (
        <div className="border-l-2 border-amber pl-3">
          <h4 className="text-meta font-semibold text-amber-ink">
            Still disputed
          </h4>
          <Markdown text={str(data.remainingDisagreement)} />
        </div>
      ) : null}
      {str(data.decisiveTest) ? (
        <div className="rounded-xl border border-border p-3">
          <h4 className="mb-1 text-meta font-semibold">
            The test that could decide it
          </h4>
          <Markdown text={str(data.decisiveTest)} />
        </div>
      ) : null}
      {strings(data.missingDisagreements).length ? (
        <Unknowns
          items={strings(data.missingDisagreements)}
          title="Disagreements missing from the synthesis"
        />
      ) : null}
      {strings(data.unknowns).length ? (
        <Unknowns items={strings(data.unknowns)} />
      ) : null}
      {!intro &&
      !checks.length &&
      !data.ranking &&
      !data.arguments &&
      typeof data.accepted !== "boolean" ? (
        <Markdown text={text} />
      ) : null}
    </div>
  );
}
function Unknowns({
  items,
  title = "What remains unknown",
}: {
  items: string[];
  title?: string;
}) {
  return (
    <div className="rounded-xl border border-amber/20 bg-amber-soft/40 p-3">
      <h3 className="flex items-center gap-2 text-small font-semibold text-amber-ink">
        <CircleAlertIcon className="size-4" />
        {title}
      </h3>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-small leading-relaxed text-muted-foreground">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
function Artifact({
  run,
  entry,
  preview = false,
}: {
  run: WorkflowRun;
  entry: WorkflowEntry;
  preview?: boolean;
}) {
  const [showSource, setShowSource] = useState(false);
  const [expandedPreview, setExpandedPreview] = useState(false);
  const codeFiles = parseWorkflowArtifacts(entry.text ?? "");
  const visual = visualArtifact(codeFiles);
  const previewUrl = `${roomPath(run.roomId, "/workflow/preview")}?${new URLSearchParams({ runId: run.id, entryId: entry.id })}`;
  return (
    <div className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-meta text-faint">
          {preview ? "Prototype" : "Artifact"}
        </span>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
          {visual ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-meta"
              onClick={() => setShowSource(!showSource)}
            >
              <EyeIcon className="size-3" />
              {showSource ? "Preview" : "Read output"}
            </Button>
          ) : null}
          {visual ? (
            <Button
              size="sm"
              variant="ghost"
              className="size-8 p-0"
              aria-label={`${expandedPreview ? "Reduce" : "Expand"} preview of ${entry.label}`}
              title={expandedPreview ? "Reduce preview" : "Expand preview"}
              aria-expanded={expandedPreview}
              onClick={() => {
                setExpandedPreview(!expandedPreview);
                setShowSource(false);
              }}
            >
              {expandedPreview ? (
                <Minimize2Icon className="size-3.5" />
              ) : (
                <Maximize2Icon className="size-3.5" />
              )}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-meta"
            onClick={() => save(`${entry.id}.md`, entry.text ?? "")}
          >
            <DownloadIcon className="size-3" />
            Save
          </Button>
        </div>
      </div>
      {visual ? (
        <iframe
          title={`Preview of ${entry.label}`}
          sandbox="allow-scripts"
          src={previewUrl}
          hidden={showSource}
          className={cn(
            "w-full rounded-xl border border-border bg-white",
            expandedPreview ? "h-[min(72dvh,720px)]" : "h-72",
            showSource && "hidden",
          )}
        />
      ) : null}
      {!visual || showSource ? (
        <WorkflowReading collapsedHeight={360} label="Read full output">
          <Markdown text={entry.text ?? ""} className="text-small" />
        </WorkflowReading>
      ) : null}
      {codeFiles.length ? (
        <details className="mt-3 border-t border-border pt-3">
          <summary className="cursor-pointer text-meta text-muted-foreground">
            Download files · {codeFiles.length}{" "}
            {codeFiles.length === 1 ? "file" : "files"}
          </summary>
          <div className="mt-2 flex flex-wrap gap-2">
            {codeFiles.map((file, i) => (
              <Button
                key={i}
                size="sm"
                variant="outline"
                className="h-7 text-meta"
                onClick={() =>
                  save(file.downloadName, file.text, "text/plain;charset=utf-8")
                }
              >
                <DownloadIcon className="size-3" />
                {file.path}
              </Button>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
function Entries({
  run,
  round,
  artifact = false,
}: {
  run: WorkflowRun;
  round?: WorkflowRound;
  artifact?: boolean;
}) {
  if (!round) return <Empty>This phase has not opened yet.</Empty>;
  if (!revealed(round)) return <Sealed run={run} round={round} />;
  return (
    <div className="space-y-5">
      {round.entries.map((entry) => (
        <article key={entry.id} className="min-w-0">
          <h3 className="mb-3 flex items-center gap-2 text-meta font-semibold">
            <span className="size-1.5 rounded-full bg-faint" />
            {entry.label}
          </h3>
          {artifact ? (
            <Artifact run={run} entry={entry} />
          ) : STRUCTURED_PHASES.has(round.phase) ? (
            <Content text={entry.text ?? ""} />
          ) : (
            <WorkflowReading
              collapsedHeight={360}
              label={
                round.phase === "synthesis"
                  ? "Read full synthesis"
                  : "Read full answer"
              }
            >
              <Markdown
                text={entry.text ?? ""}
                className={
                  round.phase === "synthesis" ? "text-[15px]" : "text-small"
                }
              />
            </WorkflowReading>
          )}
        </article>
      ))}
    </div>
  );
}

function Verification({ run }: { run: WorkflowRun }) {
  const artifact = findRound(run, "repair", "creation");
  const review = findRound(run, "recheck", "review");
  const [reviewing, setReviewing] = useState(false);
  useEffect(() => {
    const focus = (event: Event) => {
      if ((event as CustomEvent).detail?.runId === run.id) setReviewing(false);
    };
    window.addEventListener("workflow-outcome", focus);
    return () => window.removeEventListener("workflow-outcome", focus);
  }, [run.id]);
  return (
    <div className="verification-desk">
      <section className="artifact-bench">
        <header className="bench-label">
          <FileTextIcon size={16} />
          <span>
            {artifact?.phase === "repair"
              ? "Revised artifact"
              : "Working artifact"}
          </span>
          <small>
            {run.participants.find((p) => p.role === "author")?.label}
          </small>
        </header>
        <div className="bench-content">
          <Entries run={run} round={artifact} artifact />
        </div>
      </section>
      <aside className="evidence-bench" id={`workflow-report-${run.id}`}>
        <header className="bench-label">
          <ShieldCheckIcon size={16} />
          <span>Evidence desk</span>
        </header>
        <div
          className="record-tabs"
          role="group"
          aria-label="Verification evidence"
        >
          <button aria-pressed={!reviewing} onClick={() => setReviewing(false)}>
            Criteria <span>{run.criteria.length}</span>
          </button>
          <button aria-pressed={reviewing} onClick={() => setReviewing(true)}>
            Review record
          </button>
        </div>
        <div className="bench-content">
          {reviewing ? (
            <Entries run={run} round={review} />
          ) : run.report ? (
            <>
              <div className="evidence-score">
                {(["passed", "failed", "unknown"] as const).map((status) => (
                  <div key={status} data-status={status}>
                    <strong>
                      {
                        run.report!.checks.filter((c) => c.status === status)
                          .length
                      }
                    </strong>
                    <span>{status}</span>
                  </div>
                ))}
              </div>
              <CriteriaGridView run={run} />
              <Checks checks={run.report.checks} />
              <Unknowns items={run.report.unknowns} />
              <details className="audit-detail">
                <summary>Reviewer summaries</summary>
                <WorkflowReading>
                  <Markdown text={run.report.summary} />
                </WorkflowReading>
              </details>
            </>
          ) : (
            <>
              <p className="mb-5 text-small text-muted-foreground">
                The reviewers will attach evidence to every criterion.
              </p>
              {run.criteria.map((c, i) => (
                <div className="pending-criterion" key={i}>
                  <span>{String(i + 1).padStart(2, "0")}</span>
                  <p>{c}</p>
                  <small>Pending</small>
                </div>
              ))}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function DissentDesk({
  run,
  round,
}: {
  run: WorkflowRun;
  round?: WorkflowRound;
}) {
  const records = round?.entries.map((entry) => ({
    entry,
    data: parse(entry.text),
  }));
  if (
    !revealed(round) ||
    !records?.every(
      ({ data }) =>
        data &&
        Array.isArray(data.missingDisagreements) &&
        Array.isArray(data.unknowns),
    )
  )
    return <Entries run={run} round={round} />;
  return (
    <div className="dissent-evidence">
      {records.map(({ entry, data }) => {
        const missing = strings(data!.missingDisagreements);
        return (
          <div key={entry.id}>
            <div className="dissent-signal" data-flagged={missing.length > 0}>
              <strong>
                {missing.length
                  ? `${missing.length} disagreements flagged`
                  : "No missing disagreements reported"}
              </strong>
              <span>{entry.label} · independent check</span>
            </div>
            {missing.length ? (
              <ol className="dissent-findings">
                {missing.map((item, i) => (
                  <li key={i}>
                    <span>{String(i + 1).padStart(2, "0")}</span>
                    <Markdown text={item} className="text-small" />
                  </li>
                ))}
              </ol>
            ) : null}
            <Unknowns items={strings(data!.unknowns)} />
          </div>
        );
      })}
      <details className="audit-detail">
        <summary>Read the full audit</summary>
        <Entries run={run} round={round} />
      </details>
    </div>
  );
}

function Council({ run }: { run: WorkflowRun }) {
  const answers = findRound(run, "answers"),
    reviews = findRound(run, "peer_review"),
    synthesis = findRound(run, "synthesis"),
    audit = findRound(run, "dissent_audit");
  const [focus, setFocus] = useState<"synthesis" | "answers" | "reviews">(
    run.status === "completed" ? "synthesis" : "answers",
  );
  useEffect(() => {
    if (run.status === "completed") setFocus("synthesis");
  }, [run.status]);
  return (
    <div className="council-dossier">
      <div className="dossier-navigation">
        <div className="dossier-title">
          <UsersRoundIcon size={20} />
          <div>
            <strong>The council table</strong>
            <span>{run.participants.length} independent perspectives</span>
          </div>
        </div>
        <div className="record-tabs" role="group" aria-label="Council record">
          <button
            aria-pressed={focus === "synthesis"}
            onClick={() => setFocus("synthesis")}
          >
            Synthesis
          </button>
          <button
            aria-pressed={focus === "answers"}
            onClick={() => setFocus("answers")}
          >
            Voices{" "}
            <span>{answers?.entries.length ?? run.participants.length}</span>
          </button>
          <button
            aria-pressed={focus === "reviews"}
            onClick={() => setFocus("reviews")}
          >
            {run.participants.length > 2 ? "Peer rankings" : "Mutual critique"}
          </button>
        </div>
      </div>
      {focus === "synthesis" ? (
        <div className="council-synthesis-desk" data-workflow-outcome="council">
          <section className="synthesis-paper">
            <span className="studio-kicker">The considered answer</span>
            <Entries run={run} round={synthesis} />
          </section>
          <aside className="dissent-margin">
            <header>
              <ShieldCheckIcon size={16} />
              <h2>What must not be lost</h2>
            </header>
            <p className="mb-5 text-meta text-muted-foreground">
              A different agent checks the synthesis for missing disagreements.
            </p>
            <DissentDesk run={run} round={audit} />
          </aside>
        </div>
      ) : focus === "answers" ? (
        answers && !revealed(answers) ? (
          <Sealed round={answers} run={run} />
        ) : (
          <>
          <Standings rows={councilStandings(run)} title={revealed(reviews) && run.participants.length > 2 ? "How the council ranked each other" : "The voices in one line each"} unit="answer" />
          <div className="council-voices">
            {answers?.entries.map((entry) => (
              <article key={entry.id}>
                <header>
                  <span className="voice-mark">
                    {entry.label.replace(/^Answer /, "")}
                  </span>
                  <div>
                    <h2>{entry.label}</h2>
                    <p>Independent answer · revealed together</p>
                  </div>
                </header>
                <WorkflowReading>
                  <Markdown text={entry.text ?? ""} />
                </WorkflowReading>
              </article>
            ))}
            {!answers ? (
              <Empty>
                Each voice starts with the same question. Their answers appear
                here after the shared reveal.
              </Empty>
            ) : null}
          </div>
          </>
        )
      ) : (
        <section className="peer-review-desk">
          <div className="mb-5">
            <h2 className="text-body font-medium">
              {run.participants.length > 2
                ? "Anonymous peer rankings"
                : "Mutual critique"}
            </h2>
            <p className="mt-1 text-small text-faint">
              Every member evaluates other answers. No self-ranking.
            </p>
          </div>
          {run.participants.length > 2 ? <Standings rows={councilStandings(run)} title="Standing after peer review" unit="answer" /> : null}
          <Entries run={run} round={reviews} />
        </section>
      )}
    </div>
  );
}

function Tournament({ run }: { run: WorkflowRun }) {
  const prototypes = findRound(run, "prototypes");
  const evaluation = findRound(run, "evaluation");
  const implementation = findRound(run, "implementation");
  const [selected, setSelected] = useState<string[]>(
    run.selection?.entryIds ?? [],
  );
  const [instruction, setInstruction] = useState("");
  const busy = useWorkflow((s) => s.busy);
  const canSelect = run.status === "waiting_user" && run.phase === "selection";
  const current = useWorkflow((s) => s.run?.id === run.id);
  const completed = run.status === "completed";
  const [arenaView, setArenaView] = useState<"prototypes" | "implementation">(
    completed ? "implementation" : "prototypes",
  );
  useEffect(() => {
    if (completed) setArenaView("implementation");
  }, [completed]);
  useEffect(() => {
    const focus = (event: Event) => {
      if ((event as CustomEvent).detail?.runId === run.id)
        setArenaView("prototypes");
    };
    window.addEventListener("workflow-outcome", focus);
    return () => window.removeEventListener("workflow-outcome", focus);
  }, [run.id]);
  const selectionRecord = run.selection ? (
    <div
      id={`workflow-selection-${run.id}`}
      className="scroll-mt-4 flex items-start gap-3 rounded-xl border border-human/25 bg-human-soft/40 p-4"
    >
      <CheckCheckIcon className="mt-0.5 size-4 text-human" />
      <div>
        <p className="text-small font-medium">
          Your selection:{" "}
          {prototypes?.entries
            .filter((e) => run.selection?.entryIds.includes(e.id))
            .map((e) => e.label)
            .join(" + ")}
        </p>
        {run.selection.instruction ? (
          <p className="mt-1 text-small text-muted-foreground">
            {run.selection.instruction}
          </p>
        ) : null}
      </div>
    </div>
  ) : null;
  const implementationSection = implementation ? (
    <Section
      title="Implementation"
      emphasis={completed}
      detail="Built from the direction you selected."
      icon={<FileTextIcon className="size-4" />}
    >
      {completed && selectionRecord ? (
        <div className="mb-5">{selectionRecord}</div>
      ) : null}
      <Entries run={run} round={implementation} artifact />
    </Section>
  ) : null;
  return (
    <div className="tournament-record space-y-5">
      <div className="arena-record-bar">
        <div>
          <TrophyIcon size={20} />
          <span>The arena</span>
        </div>
        <div
          className="record-tabs"
          role="group"
          aria-label="Tournament record"
        >
          <button
            aria-pressed={arenaView === "prototypes"}
            onClick={() => setArenaView("prototypes")}
          >
            Compare prototypes
          </button>
          <button
            aria-pressed={arenaView === "implementation"}
            onClick={() => setArenaView("implementation")}
          >
            Implementation
          </button>
        </div>
      </div>
      {arenaView === "implementation" ? (
        (implementationSection ?? (
          <Empty>
            Your chosen direction will be implemented here after the comparison.
          </Empty>
        ))
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-meta text-faint">
            <TrophyIcon className="size-4" />
            <span>Same brief</span>
            <span>·</span>
            <span>{run.budget.timeoutMs / 60000} min per submission</span>
            <span>·</span>
            <span>
              {run.budget.maxOutputChars.toLocaleString()} character limit
            </span>
          </div>
          {prototypes && !revealed(prototypes) ? (
            <Sealed round={prototypes} run={run} />
          ) : (
            <div className="grid items-start gap-4 @min-[50rem]/workflow:grid-cols-2">
              {prototypes?.entries.map((entry) => {
                const on = (run.selection?.entryIds ?? selected).includes(
                  entry.id,
                );
                return (
                  <Section
                    key={entry.id}
                    title={entry.label}
                    detail={
                      on
                        ? run.selection
                          ? "Selected for implementation"
                          : "Selected"
                        : "Independent prototype"
                    }
                    icon={
                      <span className="grid size-6 place-items-center rounded-lg bg-muted font-mono text-meta">
                        {entry.label.replace(/^Answer /, "")}
                      </span>
                    }
                    className={on ? "border-human/50 ring-1 ring-human/20" : ""}
                  >
                    <Artifact run={run} entry={entry} preview />
                    {canSelect && current ? (
                      <label
                        className={cn(
                          "mt-4 flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2.5 text-small font-medium",
                          on
                            ? "border-human/40 bg-human-soft text-human"
                            : "border-border hover:bg-accent",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) =>
                            setSelected(
                              e.target.checked
                                ? [...selected, entry.id]
                                : selected.filter((id) => id !== entry.id),
                            )
                          }
                        />
                        {on ? "Keep this direction" : "Choose this direction"}
                      </label>
                    ) : null}
                  </Section>
                );
              })}
            </div>
          )}
          <Section
            title="Independent comparison"
            detail="Judges evaluate the common criteria; prototype authors do not judge."
            icon={<ScaleIcon className="size-4" />}
          >
            {revealed(evaluation) ? <Standings rows={tournamentStandings(run)} title="Where the prototypes stand" unit="prototype" /> : null}
            <Entries run={run} round={evaluation} />
          </Section>
          {canSelect && current ? (
            <section
              id={`workflow-selection-${run.id}`}
              className="scroll-mt-4 rounded-2xl border border-human/30 bg-human-soft/40 p-5"
            >
              <p className="text-meta font-semibold tracking-wider text-human uppercase">
                The decision is yours
              </p>
              <h2 className="mt-2 font-display text-2xl font-medium">
                One winner, or the best of both?
              </h2>
              <p className="mt-2 text-small leading-relaxed text-muted-foreground">
                Choose a prototype above. Select several to combine their
                strengths. Full implementation starts only after your decision.
              </p>
              <label className="mt-4 block">
                <span className="mb-1.5 block text-meta font-medium">
                  What to carry forward{" "}
                  {selected.length > 1
                    ? "· required for a combination"
                    : "· optional"}
                </span>
                <textarea
                  rows={2}
                  aria-label="Implementation direction"
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  placeholder="Keep A’s navigation and B’s visual hierarchy…"
                  className="w-full rounded-xl border border-input bg-background px-3 py-2 text-small outline-none focus:ring-2 focus:ring-ring/20"
                />
              </label>
              <Button
                className="mt-3"
                disabled={
                  busy ||
                  !selected.length ||
                  (selected.length > 1 && !instruction.trim())
                }
                onClick={() =>
                  void useWorkflow
                    .getState()
                    .act({
                      type: "select",
                      runId: run.id,
                      entryIds: selected,
                      ...(instruction.trim()
                        ? { instruction: instruction.trim() }
                        : {}),
                    })
                    .catch(() => {})
                }
              >
                {busy
                  ? "Starting…"
                  : selected.length > 1
                    ? "Combine and implement"
                    : "Choose and implement"}
                <ArrowRightIcon className="size-4" />
              </Button>
            </section>
          ) : (
            selectionRecord
          )}
        </>
      )}
    </div>
  );
}
function Debate({ run }: { run: WorkflowRun }) {
  const openings = findRound(run, "openings");
  const steelman = findRound(run, "steelman_repair", "steelman");
  const acceptance = findRound(run, "acceptance");
  const newArguments = findRound(run, "new_arguments");
  const rebuttals = findRound(run, "rebuttal");
  const verdict = findRound(run, "verdict");
  const [debateView, setDebateView] = useState<"exchange" | "verdict">(
    run.status === "completed" ? "verdict" : "exchange",
  );
  useEffect(() => {
    if (run.status === "completed") setDebateView("verdict");
  }, [run.status]);
  const [decision, setDecision] = useState("");
  const [overrideOpen, setOverrideOpen] = useState(false);
  // With the map drawn, the full submissions are the evidence behind it, opened on request. The map stands in for
  // them only when it could read both openings; a phase still running or failed keeps its own section in view.
  const [fullExchange, setFullExchange] = useState(false);
  const digest = useMemo(() => debateDigest(run), [run]);
  const mapped = !!digest && digest.sides.length === 2 && digest.sides.every((side) => side.position && side.arguments.length);
  const gateSettled = [steelman, acceptance].every((round) => !round || revealed(round));
  const busy = useWorkflow((s) => s.busy);
  const current = useWorkflow((s) => s.run?.id === run.id);
  const advocates = run.participants
    .filter((p) => p.role === "pro" || p.role === "con")
    .sort((a, b) => (a.role === b.role ? 0 : a.role === "pro" ? -1 : 1));
  const participants = advocates.length
    ? advocates
    : run.participants.slice(0, 2);
  const verdictSection = (
    <Section
      title="The judge’s verdict"
      emphasis={run.status === "completed"}
      detail="An agent who did not argue either side assesses the case."
      icon={<ScaleIcon className="size-4" />}
      className={revealed(verdict) ? "border-foreground/25" : ""}
    >
      {revealed(verdict) ? <CriteriaGridView run={run} /> : null}
      <Entries run={run} round={verdict} />
      {run.override ? (
        <div className="mt-5 rounded-xl border border-human/30 bg-human-soft/40 p-4">
          <h3 className="mb-2 text-meta font-semibold text-human">
            Your final decision
          </h3>
          <Markdown text={run.override} />
          <p className="mt-2 text-meta text-faint">
            The original verdict remains above for comparison.
          </p>
        </div>
      ) : null}
      {run.status === "completed" && current ? (
        <div className="mt-4 border-t border-border pt-4">
          {overrideOpen ? (
            <div>
              <label className="block text-small font-medium">
                Your verdict
                <textarea
                  rows={3}
                  value={decision}
                  onChange={(e) => setDecision(e.target.value)}
                  placeholder="State what you would decide differently, and why…"
                  className="mt-2 w-full rounded-xl border border-input bg-background px-3 py-2 text-small font-normal outline-none focus:ring-2 focus:ring-ring/20"
                />
              </label>
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  disabled={busy || !decision.trim()}
                  onClick={() =>
                    void useWorkflow
                      .getState()
                      .act({
                        type: "override",
                        runId: run.id,
                        text: decision.trim(),
                      })
                      .then(() => setOverrideOpen(false))
                      .catch(() => {})
                  }
                >
                  Save my decision
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setOverrideOpen(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setDecision(run.override ?? "");
                setOverrideOpen(true);
              }}
            >
              Record a different decision
            </Button>
          )}
        </div>
      ) : null}
    </Section>
  );
  return (
    <div className="debate-record space-y-5">
      <div className="debate-record-bar">
        <div>
          <ScaleIcon size={20} />
          <span>The hearing</span>
        </div>
        <div className="record-tabs" role="group" aria-label="Debate record">
          <button
            aria-pressed={debateView === "exchange"}
            onClick={() => setDebateView("exchange")}
          >
            Argument exchange
          </button>
          <button
            aria-pressed={debateView === "verdict"}
            onClick={() => setDebateView("verdict")}
          >
            Verdict & decision
          </button>
        </div>
      </div>
      {debateView === "verdict" ? (
        <div className="verdict-paper space-y-5" data-workflow-outcome="debate">
          <DebateMap run={run} />
          {verdictSection}
        </div>
      ) : (
        <>
          {mapped ? (
            <>
              <DebateMap run={run} />
              <button
                type="button"
                aria-expanded={fullExchange}
                onClick={() => setFullExchange(!fullExchange)}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-small font-medium transition hover:bg-accent"
              >
                <ChevronDownIcon className={cn("size-3.5 transition-transform", fullExchange && "rotate-180")} />
                {fullExchange ? "Hide the full submissions" : "Read the full submissions"}
              </button>
            </>
          ) : null}
          {openings && !revealed(openings) ? (
            <Sealed round={openings} run={run} />
          ) : mapped && !fullExchange ? null : (
            <div className="debate-exchange grid items-start gap-4 @min-[50rem]/workflow:grid-cols-2">
              {participants.map((person) => (
                <Section
                  key={person.id}
                  title={
                    person.role === "pro"
                      ? "For the motion"
                      : "Against the motion"
                  }
                  detail={`${person.label} · a position assigned for this session`}
                  icon={
                    <span
                      className={cn(
                        "grid size-7 place-items-center rounded-full text-small font-semibold",
                        person.role === "pro"
                          ? "bg-codex-soft text-codex"
                          : "bg-claude-soft text-claude",
                      )}
                    >
                      {person.role === "pro" ? "+" : "−"}
                    </span>
                  }
                >
                  <div className="space-y-5">
                    {openings?.entries
                      .filter((e) => e.participantId === person.id)
                      .map((entry) => (
                        <Content key={entry.id} text={entry.text ?? ""} />
                      ))}
                    {revealed(steelman) ? (
                      <div className="border-t border-border pt-4">
                        <h3 className="mb-3 flex items-center gap-2 text-meta font-semibold">
                          <RefreshCwIcon className="size-3.5" />
                          Restating the other side
                        </h3>
                        {steelman?.entries
                          .filter((e) => e.participantId === person.id)
                          .map((entry) => (
                            <Markdown
                              key={entry.id}
                              text={entry.text ?? ""}
                              className="text-small"
                            />
                          ))}
                      </div>
                    ) : null}
                    {revealed(newArguments) ? (
                      <div className="border-t border-border pt-4">
                        <h3 className="mb-3 text-meta font-semibold">
                          New arguments after understanding
                        </h3>
                        {newArguments?.entries
                          .filter((e) => e.participantId === person.id)
                          .map((entry) => (
                            <Content key={entry.id} text={entry.text ?? ""} />
                          ))}
                      </div>
                    ) : null}
                    {revealed(rebuttals) ? (
                      <div className="border-t border-border pt-4">
                        <h3 className="mb-3 flex items-center gap-2 text-meta font-semibold">
                          <SwordsIcon className="size-3.5" />
                          Response after acceptance
                        </h3>
                        {rebuttals?.entries
                          .filter((e) => e.participantId === person.id)
                          .map((entry) => (
                            <Content key={entry.id} text={entry.text ?? ""} />
                          ))}
                      </div>
                    ) : null}
                  </div>
                </Section>
              ))}
            </div>
          )}
          {mapped && !fullExchange && gateSettled ? null : (
          <Section
            title="Understanding before rebuttal"
            detail="The original speaker must accept the opponent’s restatement. Rejected restatements return for repair."
            icon={<CheckCheckIcon className="size-4" />}
          >
            {acceptance ? (
              <Entries run={run} round={acceptance} />
            ) : steelman ? (
              <Entries run={run} round={steelman} />
            ) : (
              <Empty>
                The acceptance gate opens after both positions have been
                revealed.
              </Empty>
            )}
          </Section>
          )}
          {run.phase === "disagreement" ? (
            <Unknowns
              title="Agreement on the restatement was not reached"
              items={[
                "The repair budget was used without acceptance. Rebuttals are withheld; the remaining disagreement stays in the record.",
              ]}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function Timeline({
  run,
  onRound,
  selected,
}: {
  run: WorkflowRun;
  onRound: (round: WorkflowRound | null) => void;
  selected: WorkflowRound | null;
}) {
  const phases = PHASES[run.mode];
  const [expanded, setExpanded] = useState(false);
  const compact = run.status === "completed" && !selected;
  const phasesId = `workflow-phases-${run.id}`;
  useEffect(() => setExpanded(false), [run.id]);
  const currentPhase =
    run.phase === "steelman_repair"
      ? "steelman"
      : run.phase === "disagreement"
        ? "acceptance"
        : run.phase;
  const inspectedPhase =
    selected?.phase === "steelman_repair" ? "steelman" : selected?.phase;
  return (
    <div className="mb-4">
      {compact ? (
        <button
          type="button"
          aria-label={expanded ? "Hide session phases" : "Show session phases"}
          aria-expanded={expanded}
          aria-controls={phasesId}
          onClick={() => setExpanded(!expanded)}
          className="flex min-h-9 w-fit items-center gap-2.5 rounded-lg px-2 text-left text-meta text-muted-foreground transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <CheckCheckIcon aria-hidden className="size-4 text-human" />
          <span className="font-medium">View process record</span>
          <span className="ml-auto text-meta text-muted-foreground">
            {phases.length} steps
          </span>
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-4 text-muted-foreground transition-transform",
              expanded && "rotate-180",
            )}
          />
        </button>
      ) : null}
      <nav
        id={phasesId}
        className={cn(
          "grid-cols-2 gap-1 rounded-xl border border-border bg-card p-1.5",
          compact && !expanded ? "hidden" : "grid @min-[40rem]/workflow:flex",
          compact && expanded && "mt-2",
        )}
        aria-label="Session phases"
      >
        {phases.map((phase, i) => {
          const round =
            phase === "steelman"
              ? findRound(run, "steelman", "steelman_repair")
              : findRound(run, phase);
          const humanSelection =
            phase === "selection" && Boolean(run.selection);
          const done = round?.status === "revealed" || humanSelection;
          const finalReport =
            phase === "report" &&
            run.status === "completed" &&
            Boolean(run.report);
          const skipped =
            run.status === "completed" &&
            !round &&
            !finalReport &&
            !humanSelection;
          const inspecting = inspectedPhase === phase;
          const active =
            !selected &&
            (run.status === "running" || run.status === "waiting_user") &&
            phase === currentPhase;
          const on = inspecting || active;
          const target =
            phase === "selection" &&
            (humanSelection || run.status === "waiting_user")
              ? `workflow-selection-${run.id}`
              : finalReport
                ? `workflow-report-${run.id}`
                : null;
          const state = inspecting
            ? "Viewing"
            : active
              ? run.status === "waiting_user"
                ? "Your turn"
                : "Now"
              : humanSelection
                ? "Selected"
                : done
                  ? "Revealed"
                  : finalReport
                    ? "Complete"
                    : skipped
                      ? run.mode === "verification"
                        ? "Not needed"
                        : "Skipped"
                      : round?.status === "failed"
                        ? "Stopped"
                        : "Next";
          return (
            <button
              key={phase}
              type="button"
              disabled={!round && !target}
              onClick={() => {
                onRound(inspecting ? null : (round ?? null));
                if (target)
                  window.dispatchEvent(
                    new CustomEvent("workflow-outcome", {
                      detail: { runId: run.id, phase },
                    }),
                  );
                if (target)
                  requestAnimationFrame(() =>
                    document.getElementById(target)?.scrollIntoView({
                      block: "nearest",
                      behavior: "smooth",
                    }),
                  );
              }}
              aria-label={`Step ${i + 1} of ${phases.length}: ${name(phase)} — ${state}`}
              aria-current={on ? "step" : undefined}
              className={cn(
                "flex min-w-0 flex-1 items-start gap-2 rounded-lg px-2.5 py-2.5 text-left transition disabled:cursor-default @min-[40rem]/workflow:flex-col @min-[40rem]/workflow:gap-1.5 @min-[40rem]/workflow:px-3",
                on
                  ? "bg-foreground text-background"
                  : done || finalReport
                    ? "text-foreground/85 hover:bg-accent"
                    : "text-faint",
                phases.length % 2 === 1 &&
                  i === phases.length - 1 &&
                  "col-span-2",
              )}
            >
              <span className="flex items-center gap-1.5 @max-[40rem]/workflow:mt-0.5">
                <span
                  className={cn(
                    "grid size-5 shrink-0 place-items-center rounded-full border text-[10px]",
                    on ? "border-background/25" : "border-border",
                  )}
                >
                  {done || finalReport ? (
                    <CheckIcon className="size-3" />
                  ) : skipped ? (
                    "–"
                  ) : (
                    i + 1
                  )}
                </span>
                <span
                  className={cn(
                    "hidden text-[10px] font-medium tracking-wide uppercase @min-[40rem]/workflow:inline",
                    on ? "text-background/70" : "text-faint",
                  )}
                >
                  {state}
                </span>
              </span>
              <span className="min-w-0">
                <span
                  className={cn(
                    "mb-0.5 block text-[10px] font-medium tracking-wide uppercase @min-[40rem]/workflow:hidden",
                    on ? "text-background/70" : "text-faint",
                  )}
                >
                  {state}
                </span>
                <span className="block text-[11px] leading-4 font-medium">
                  {name(phase)}
                </span>
              </span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

export function WorkflowBoard({ mode }: { mode: ProtocolMode }) {
  const roomId = useStore((s) => s.snap?.state.id);
  const live = useWorkflow((s) => (s.roomId === roomId ? s.run : null));
  const loading = useWorkflow((s) => s.loading);
  const error = useWorkflow((s) => s.error);
  const busy = useWorkflow((s) => s.busy);
  const requested = useStore((s) => s.workflowRunId);
  const [historyResult, setHistoryResult] = useState<{
    id: string;
    run: WorkflowRun | null;
    error: string | null;
  } | null>(null);
  const [selected, setSelected] = useState<WorkflowRound | null>(null);
  const setup = requested === "new";
  const needsHistory = Boolean(requested && !setup && requested !== live?.id);
  const historical =
    needsHistory && historyResult?.id === requested ? historyResult.run : null;
  const historyLoading = needsHistory && historyResult?.id !== requested;
  const historyError =
    needsHistory && historyResult?.id === requested
      ? historyResult.error
      : null;
  const run = setup
    ? null
    : requested
      ? requested === live?.id && live.mode === mode
        ? live
        : historical
      : live?.mode === mode
        ? live
        : null;
  const active = activeWorkflow(live);
  const allSessions = () => useStore.getState().setView("sessions");
  const newSession = () =>
    roomId && useStore.getState().openWorkflow(roomId, mode, "new");
  useEffect(() => {
    setSelected(null);
  }, [requested, roomId, mode]);
  useEffect(() => {
    if (!needsHistory || !roomId || !requested) return;
    let alive = true;
    void api<{ workflows: WorkflowRun[] }>(
      "GET",
      roomPath(roomId, "/workflow/history"),
    )
      .then((r) => {
        const found =
          r.workflows.find(
            (entry) =>
              entry.id === requested &&
              entry.mode === mode &&
              entry.roomId === roomId,
          ) ?? null;
        if (alive)
          setHistoryResult({
            id: requested,
            run: found,
            error: found
              ? null
              : "This saved session could not be found in this chat.",
          });
      })
      .catch((cause) => {
        if (alive)
          setHistoryResult({
            id: requested,
            run: null,
            error: cause instanceof Error ? cause.message : String(cause),
          });
      });
    return () => {
      alive = false;
    };
  }, [needsHistory, requested, roomId, mode]);
  const selectedCurrent =
    run?.rounds.find((r) => r.id === selected?.id) ?? null;
  return (
    <div
      className="@container/workflow workflow-result scroll-thin min-h-0 flex-1 overflow-y-auto bg-canvas"
      data-workflow-mode={mode}
    >
      {error ? (
        <div
          role="alert"
          className="mx-5 mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-destructive/20 bg-destructive-soft px-3 py-2 text-small text-destructive"
        >
          <CircleAlertIcon className="size-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            onClick={() =>
              roomId && void useWorkflow.getState().refresh(roomId)
            }
          >
            Refresh
          </Button>
        </div>
      ) : null}
      {loading || historyLoading ? (
        <div
          className="mx-auto max-w-[1000px] space-y-5 px-6 py-10"
          aria-label="Loading session"
        >
          <div className="h-10 w-2/3 animate-pulse rounded-xl bg-muted" />
          <div className="h-28 animate-pulse rounded-2xl bg-muted" />
          <div className="h-60 animate-pulse rounded-2xl bg-muted" />
        </div>
      ) : historyError ||
        (requested &&
          requested !== "new" &&
          live?.id === requested &&
          live.mode !== mode) ? (
        <div className="mx-auto max-w-lg px-6 py-16 text-center">
          <CircleAlertIcon className="mx-auto mb-4 size-7 text-faint" />
          <h1 className="font-display text-2xl">Session unavailable</h1>
          <p role="alert" className="mt-3 text-small text-muted-foreground">
            {historyError ?? "This session belongs to a different mode."}
          </p>
          <Button className="mt-5" variant="outline" onClick={allSessions}>
            View all sessions
          </Button>
        </div>
      ) : active && !historical && (setup || live?.mode !== mode) ? (
        <div className="mx-auto max-w-lg px-6 py-20 text-center">
          <LockKeyholeIcon className="mx-auto mb-5 size-8 text-faint" />
          <h1 className="font-display text-3xl">
            {WORK_MODES[live!.mode].title} is in progress
          </h1>
          <p className="mt-3 text-small leading-relaxed text-muted-foreground">
            One session runs in this room at a time. Return to it to see the
            current phase, or start a separate room.
          </p>
          <Button
            className="mt-5"
            onClick={() =>
              roomId &&
              useStore.getState().openWorkflow(roomId, live!.mode, live!.id)
            }
          >
            Open active session
            <ArrowRightIcon className="size-4" />
          </Button>
        </div>
      ) : !run || setup ? (
        <WorkflowSetup
          key={`${roomId}:${mode}`}
          mode={mode}
          onStarted={() => {
            const current = useWorkflow.getState().run;
            if (roomId)
              useStore.getState().openWorkflow(roomId, mode, current?.id);
          }}
          onBack={allSessions}
        />
      ) : (
        <div className="mx-auto max-w-[1440px] px-4 py-5 sm:px-7 sm:py-6">
          {historical ? (
            <div className="mb-5 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-meta text-muted-foreground">
              <HistoryIcon className="size-3.5" />
              <span>
                Saved session · {new Date(run.createdAt).toLocaleString()}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-7 text-meta"
                onClick={() =>
                  live && roomId
                    ? useStore
                        .getState()
                        .openWorkflow(roomId, live.mode, live.id)
                    : allSessions()
                }
              >
                Latest session
              </Button>
            </div>
          ) : null}
          <header className="mb-6">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-semibold tracking-[.16em] text-faint uppercase">
                {WORK_MODES[mode].title} / {name(run.phase)}
              </span>
              <Status status={run.status} />
              <div className="ml-auto flex w-full max-w-full flex-wrap justify-end gap-1 @min-[40rem]/workflow:w-auto">
                {!active &&
                run.rounds.some((round) => round.status === "revealed") ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-11 text-meta @min-[40rem]/workflow:h-8"
                    onClick={() => discussRun(run)}
                  >
                    <MessageSquareIcon className="size-3.5" />
                    Discuss in chat
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  className="hidden h-8 text-meta @min-[40rem]/workflow:inline-flex"
                  onClick={() => exportRun(run)}
                >
                  <DownloadIcon className="size-3.5" />
                  Export record
                </Button>
                {!active && !historical ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="hidden h-8 text-meta @min-[40rem]/workflow:inline-flex"
                    onClick={newSession}
                  >
                    <PlusIcon className="size-3.5" />
                    New session
                  </Button>
                ) : null}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Session actions"
                      className="size-11 @min-[40rem]/workflow:hidden"
                    >
                      <MoreHorizontalIcon className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    className="min-w-44 rounded-xl p-1.5"
                  >
                    <DropdownMenuItem
                      className="min-h-10 rounded-lg"
                      onSelect={() => exportRun(run)}
                    >
                      <DownloadIcon /> Export record
                    </DropdownMenuItem>
                    {!active && !historical ? (
                      <DropdownMenuItem
                        className="min-h-10 rounded-lg"
                        onSelect={newSession}
                      >
                        <PlusIcon /> New session
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
                {active && !historical ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-11 text-meta text-muted-foreground @min-[40rem]/workflow:h-8"
                    disabled={busy}
                    onClick={() => void useWorkflow.getState().stop()}
                  >
                    <SquareIcon className="size-3" />
                    Stop
                  </Button>
                ) : null}
              </div>
            </div>
            <h1 className="line-clamp-2 max-w-[80ch] font-display text-[20px] leading-[1.35] font-medium tracking-tight @min-[45rem]/workflow:text-[22px]">
              {run.task}
            </h1>
            <details className="group/brief mt-3 text-small">
              <summary className="flex w-fit cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                <ChevronDownIcon className="size-3.5 transition-transform group-open/brief:rotate-180" />
                <span className="font-medium">Original brief</span>
                <span className="text-meta text-faint">
                  · {run.criteria.length} criteria · {run.participants.length}{" "}
                  participants
                </span>
              </summary>
              <div className="mt-3 space-y-4 rounded-xl border border-border bg-card p-4">
                <p className="max-w-[85ch] whitespace-pre-wrap leading-relaxed">
                  {run.task}
                </p>
                <h2 className="text-meta font-semibold">Success criteria</h2>
                <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
                  {run.criteria.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
                <p className="text-meta text-faint">
                  {run.participants
                    .map((p) => `${p.label}${p.model ? ` · ${p.model}` : ""}`)
                    .join(" / ")}
                </p>
              </div>
            </details>
          </header>
          <Timeline
            run={run}
            onRound={setSelected}
            selected={selectedCurrent}
          />
          {run.error || run.status === "cancelled" ? (
            <div
              role={run.status === "cancelled" ? "status" : "alert"}
              className={cn(
                "mb-5 rounded-xl border p-4",
                run.status === "cancelled"
                  ? "border-border bg-card"
                  : "border-destructive/20 bg-destructive-soft",
              )}
            >
              <h2
                className={cn(
                  "text-small font-semibold",
                  run.status !== "cancelled" && "text-destructive",
                )}
              >
                {run.status === "cancelled"
                  ? "This session was stopped"
                  : "This session needs attention"}
              </h2>
              <p
                className={cn(
                  "mt-1 whitespace-pre-wrap text-small",
                  run.status === "cancelled"
                    ? "text-muted-foreground"
                    : "text-destructive",
                )}
              >
                {run.error ??
                  "Revealed phases are preserved. Resume to retry the unfinished phase."}
              </p>
              {(run.status === "failed" || run.status === "cancelled") &&
              !historical ? (
                <Button
                  size="sm"
                  className="mt-3"
                  disabled={busy}
                  onClick={() =>
                    void useWorkflow
                      .getState()
                      .act({ type: "retry", runId: run.id })
                      .catch(() => {})
                  }
                >
                  <RefreshCwIcon className="size-3.5" />
                  {run.status === "cancelled"
                    ? "Resume session"
                    : "Retry failed phase"}
                </Button>
              ) : null}
            </div>
          ) : null}
          {run.phase === "starting" && !selectedCurrent ? (
            <div className="session-preparing">
              <p className="mb-4 flex items-center gap-2 text-small text-muted-foreground">
                <Clock3Icon className="size-4" />
                Preparing the private workspaces…
              </p>
              <AgentStage
                mode={run.mode}
                seats={run.participants.map((person) => ({
                  id: person.id,
                  role: person.role ?? "member",
                  node: (
                    <div className="sealed-seat">
                      <strong className="text-small font-medium">
                        {person.label}
                      </strong>
                      <p className="mt-2 text-meta text-faint">
                        Waiting for the first round
                      </p>
                    </div>
                  ),
                }))}
              />
            </div>
          ) : selectedCurrent ? (
            <Section
              title={`${name(selectedCurrent.phase)} · phase record`}
              detail={
                selectedCurrent.status === "revealed"
                  ? "Revealed together; preserved for inspection."
                  : "Contents remain private until the round is ready."
              }
              icon={<HistoryIcon className="size-4" />}
            >
              <Button
                size="sm"
                variant="ghost"
                className="mb-3 text-meta"
                onClick={() => setSelected(null)}
              >
                <ArrowDownIcon className="size-3.5" />
                Back to the working surface
              </Button>
              <Entries
                run={run}
                round={selectedCurrent}
                artifact={[
                  "creation",
                  "repair",
                  "prototypes",
                  "implementation",
                ].includes(selectedCurrent.phase)}
              />
            </Section>
          ) : mode === "verification" ? (
            <Verification key={run.id} run={run} />
          ) : mode === "council" ? (
            <Council key={run.id} run={run} />
          ) : mode === "tournament" ? (
            <Tournament key={run.id} run={run} />
          ) : (
            <Debate key={run.id} run={run} />
          )}
        </div>
      )}
    </div>
  );
}
