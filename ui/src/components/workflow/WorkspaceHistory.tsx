import { useEffect, useState } from "react";
import { ArrowUpRightIcon, SearchIcon } from "lucide-react";
import { useWorkflowIndex } from "@/lib/workflow-index-state";
import { useStore } from "@/lib/store";
import { ago } from "@/lib/format";
import { phaseName, type ProtocolMode } from "@/lib/workflow";
import { cn } from "@/lib/utils";

export function WorkspaceHistory({ mode }: { mode: ProtocolMode }) {
  const rooms = useStore((s) => s.rooms);
  const selected = useStore((s) => s.workflowRunId);
  const room = useStore((s) => (s.route.kind === "room" ? s.route.id : null));
  const { entries: runs, error, loading, refresh } = useWorkflowIndex();
  const [query, setQuery] = useState("");
  useEffect(() => {
    void refresh();
  }, [rooms, refresh]);
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  const matching = runs.filter(
    (r) =>
      r.mode === mode &&
      `${r.task} ${r.roomName}`.toLowerCase().includes(query.toLowerCase()),
  );
  const groups = [
    {
      label: "Needs you",
      entries: matching.filter(
        (r) => r.status === "waiting_user" || r.status === "failed",
      ),
    },
    {
      label: "In progress",
      entries: matching.filter((r) => r.status === "running"),
    },
    {
      label: "Recent",
      entries: matching.filter(
        (r) => r.status === "completed" || r.status === "cancelled",
      ),
    },
  ];
  return (
    <div className="workspace-history">
      <label className="history-search">
        <SearchIcon size={14} />
        <input
          aria-label="Find sessions"
          placeholder="Find a session…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {error ? (
        <button
          className="px-3 py-2 text-left text-meta text-destructive"
          onClick={() => void refresh()}
        >
          {error} Retry
        </button>
      ) : null}
      {loading ? (
        <p className="p-3 text-small text-faint">Loading sessions…</p>
      ) : null}
      {groups
        .filter((group) => group.entries.length)
        .map((group) => (
          <section key={group.label}>
            <h2 className="history-label">
              {group.label}
              <span>{group.entries.length}</span>
            </h2>
            {group.entries.map((run) => (
              <button
                key={run.id}
                className={cn(
                  "history-session",
                  room === run.roomId &&
                    (selected === run.id || !selected) &&
                    "is-selected",
                )}
                onClick={() =>
                  useStore.getState().openWorkflow(run.roomId, mode, run.id)
                }
                aria-label={`Open ${run.task}`}
              >
                <span className="history-session-title">
                  <i className={cn("session-dot", run.status)} />
                  <span>{run.task}</span>
                  <ArrowUpRightIcon size={12} />
                </span>
                <span className="history-session-meta">
                  {run.status === "running"
                    ? phaseName(run.phase)
                    : run.status === "waiting_user"
                      ? "Your decision"
                      : run.status === "failed"
                        ? "Needs attention"
                        : run.status === "cancelled"
                          ? "Stopped"
                          : `${run.participants} agents`}
                  <time>{ago(run.updatedAt)}</time>
                </span>
              </button>
            ))}
          </section>
        ))}
      {!loading && !matching.length && !error ? (
        <div className="history-empty">
          <p>{query ? "No matching sessions" : "A fresh workspace"}</p>
          <span>
            {query
              ? "Try a shorter search."
              : "Your sessions will collect here. Start one with the button above."}
          </span>
        </div>
      ) : null}
    </div>
  );
}
