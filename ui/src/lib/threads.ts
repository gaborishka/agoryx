/**
 * Threads by what they need from the human: one that has said its piece and waits for a reply or a ✓, one still
 * working, one that has said nothing yet, and one the human resolved. Agoryx resolves nothing: only the human's ✓
 * moves a thread to Resolved, and a thread working again is Working whatever it was.
 */
export type ThreadGroup = "waiting" | "working" | "idle" | "resolved";

export const THREAD_GROUPS: Array<{ id: ThreadGroup; head: string }> = [
  { id: "waiting", head: "Waiting on you" },
  { id: "working", head: "Working" },
  { id: "idle", head: "Idle" },
  { id: "resolved", head: "Resolved" },
];

export const threadGroup = ({ running, resolved, spoke }: { running: boolean; resolved?: unknown; spoke: boolean }): ThreadGroup =>
  running ? "working" : resolved ? "resolved" : spoke ? "waiting" : "idle";

/** Threads in their groups, in the groups' order, the empty ones left out. */
export const groupThreads = <T>(threads: T[], groupOf: (thread: T) => ThreadGroup) =>
  THREAD_GROUPS.map((group) => ({ ...group, threads: threads.filter((thread) => groupOf(thread) === group.id) })).filter((group) => group.threads.length);
