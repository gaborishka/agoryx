import { workflowHandoffText } from "@agora/workflow-handoff";
import { Markdown } from "@/components/md/Markdown";
import { useEffect, useState, type ReactNode } from "react";
import { ChevronDownIcon, HistoryIcon } from "lucide-react";
import type { RoomState } from "@agora/types";
import type { WorkflowRun } from "@agora/workflow-types";
import { api, roomPath } from "@/lib/api";
import { WORK_MODES } from "@/lib/workflow";

function ContextPreview({
  label,
  children,
}: {
  label: string;
  children: () => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="ml-5 p-2 text-meta text-faint"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="w-fit cursor-pointer">{label}</summary>
      {open ? (
        <div className="mt-3 text-muted-foreground">{children()}</div>
      ) : null}
    </details>
  );
}

export function ConversationMaterials({
  room,
  messages,
  results,
  onChange,
}: {
  room: RoomState;
  messages: string[];
  results: string[];
  onChange: (patch: { messageIds?: string[]; resultIds?: string[] }) => void;
}) {
  const [runs, setRuns] = useState<WorkflowRun[]>([]),
    [error, setError] = useState(false),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    setError(false);
    void api<{ workflows: WorkflowRun[] }>(
      "GET",
      roomPath(room.id, "/workflow/history"),
    )
      .then(({ workflows }) => {
        if (alive)
          setRuns(
            workflows.filter(
              (r) =>
                !["running", "waiting_user"].includes(r.status) &&
                r.rounds.some((round) => round.status === "revealed"),
            ),
          );
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, [room.id, retry]);
  const eligible = room.messages.filter(
    (m) => m.kind !== "pass" && m.kind !== "system",
  );
  const count = messages.length + results.length;
  return (
    <details className="rounded-2xl border border-border bg-card p-4">
      <summary className="flex cursor-pointer items-center gap-2 text-small font-medium">
        <HistoryIcon className="size-4 text-faint" />
        <span className="flex-1">Carry context from this conversation</span>
        <span className="text-meta text-muted-foreground">
          {count ? `${count} selected` : "Optional"}
        </span>
        <ChevronDownIcon className="size-3.5" />
      </summary>
      <p className="mb-3 mt-3 text-meta leading-relaxed text-muted-foreground">
        Choose messages and results for every participant to receive as the same
        frozen copy. Everything else stays outside the private session.
      </p>
      {error ? (
        <button
          type="button"
          className="mb-3 text-meta text-destructive underline"
          onClick={() => setRetry((n) => n + 1)}
        >
          Couldn’t load past results. Retry
        </button>
      ) : null}
      {!eligible.length && !runs.length ? (
        <p className="text-small text-faint">
          No conversation messages or finished results yet.
        </p>
      ) : null}
      <div className="scroll-thin max-h-80 space-y-2 overflow-y-auto">
        {runs.map((run) => (
          <div key={run.id}>
            <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border p-3 hover:bg-accent">
              <input
                type="checkbox"
                className="mt-1"
                checked={results.includes(run.id)}
                onChange={(e) =>
                  onChange({
                    resultIds: e.target.checked
                      ? [...results, run.id]
                      : results.filter((id) => id !== run.id),
                  })
                }
              />
              <span className="min-w-0 text-small">
                <span className="block font-medium">
                  {WORK_MODES[run.mode].title} · {run.status}
                </span>
                <span className="mt-1 block text-meta text-muted-foreground">
                  {run.task}
                </span>
                <span className="mt-1 block text-meta text-faint">
                  Includes final results, decisions, checks and unresolved
                  disagreements.
                </span>
              </span>
            </label>
            <ContextPreview label="Read selected result">
              {() => <Markdown text={workflowHandoffText(run)} literalHtml />}
            </ContextPreview>
          </div>
        ))}
        {[...eligible].reverse().map((message) => (
          <div key={message.id} className="rounded-lg border border-border p-3">
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={messages.includes(message.id)}
                onChange={(e) =>
                  onChange({
                    messageIds: e.target.checked
                      ? [...messages, message.id]
                      : messages.filter((id) => id !== message.id),
                  })
                }
              />
              <span className="min-w-0 text-small">
                <span className="block font-medium">{message.author}</span>
                <span className="mt-1 line-clamp-2 block whitespace-pre-wrap text-meta text-muted-foreground">
                  {message.text.slice(0, 500)}
                </span>
              </span>
            </label>
            <ContextPreview label="Read full message">
              {() => (
                <p className="whitespace-pre-wrap break-words">
                  {message.text}
                </p>
              )}
            </ContextPreview>
          </div>
        ))}
      </div>
    </details>
  );
}
