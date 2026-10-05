import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { WorkflowRun } from "../../internal/agora/workflow-types.js";
import { useWorkflow } from "../../ui/src/lib/workflow-state.js";
import { useStore } from "../../ui/src/lib/store.js";

const originalFetch = globalThis.fetch;
const originalLoad = useStore.getState().loadRooms;
let roomRefreshes = 0;
beforeEach(() => {
  roomRefreshes = 0;
  useWorkflow.getState().enterRoom(null);
  useStore.setState({
    loadRooms: async () => {
      roomRefreshes++;
    },
  });
});
afterEach(() => {
  useWorkflow.getState().enterRoom(null);
  useStore.setState({ loadRooms: originalLoad });
  globalThis.fetch = originalFetch;
});
const run = (
  roomId: string,
  status: WorkflowRun["status"] = "running",
  updatedAt = "2026-10-04T10:00:00.000Z",
): WorkflowRun => ({
  id: `run-${roomId}`,
  roomId,
  mode: "council",
  status,
  phase: "answers",
  task: "Question",
  criteria: ["Clear"],
  participants: [
    { id: "a", kind: "codex", label: "A" },
    { id: "b", kind: "claude", label: "B" },
  ],
  budget: { timeoutMs: 180000, maxOutputChars: 10000, maxRounds: 2 },
  rounds: [],
  createdAt: updatedAt,
  updatedAt,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const response = (workflow: WorkflowRun | null) =>
  new Response(JSON.stringify({ workflow }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

test("a late start response for A cannot replace B or strand B's subsequent polling", async () => {
  const a = useWorkflow.getState().enterRoom("late-A");
  useWorkflow.getState().receive("late-A", { workflow: run("late-A") }, a);
  const b = useWorkflow.getState().enterRoom("late-B");
  useWorkflow.getState().receive("late-B", { workflow: run("late-B") }, b);
  useWorkflow
    .getState()
    .receive("late-A", { workflow: run("late-A", "completed") }, a);
  assert.equal(useWorkflow.getState().roomId, "late-B");
  globalThis.fetch = async () =>
    response(run("late-B", "completed", "2026-10-04T10:01:00.000Z"));
  await useWorkflow.getState().refresh("late-B");
  assert.equal(useWorkflow.getState().run!.roomId, "late-B");
  assert.equal(useWorkflow.getState().run!.status, "completed");
});

test("leaving and reentering the same room invalidates old action responses and cleanup", async () => {
  useWorkflow.getState().enterRoom("action-A");
  useWorkflow
    .getState()
    .receive("action-A", { workflow: run("action-A", "failed") });
  const pending = deferred<Response>();
  globalThis.fetch = async () => pending.promise;
  const action = useWorkflow
    .getState()
    .act({ type: "retry", runId: "run-action-A" });
  assert.equal(useWorkflow.getState().busy, true);
  useWorkflow.getState().enterRoom("other-room");
  useWorkflow.getState().enterRoom("action-A");
  useWorkflow
    .getState()
    .receive("action-A", {
      workflow: run("action-A", "cancelled", "2026-10-04T10:02:00.000Z"),
    });
  useWorkflow.setState({ busy: true }); // A different action in the new visit owns this flag.
  pending.resolve(response(run("action-A", "running")));
  await action;
  assert.equal(useWorkflow.getState().run!.status, "cancelled");
  assert.equal(
    useWorkflow.getState().busy,
    true,
    "old finally must not unlock a new visit's action",
  );
});

test("a failed stop from an old visit cannot replace the current visit's error or busy state", async () => {
  useWorkflow.getState().enterRoom("stop-A");
  useWorkflow.getState().receive("stop-A", { workflow: run("stop-A") });
  const pending = deferred<Response>();
  globalThis.fetch = async () => pending.promise;
  const stop = useWorkflow.getState().stop();
  useWorkflow.getState().enterRoom(null);
  useWorkflow.getState().enterRoom("stop-A");
  useWorkflow.setState({ error: "current error", busy: true });
  pending.reject(new Error("old transport error"));
  await stop;
  assert.equal(useWorkflow.getState().error, "current error");
  assert.equal(useWorkflow.getState().busy, true);
});

test("pending polls cannot overwrite a newer mutation and do not run while it is in flight", async () => {
  useWorkflow.getState().enterRoom("poll-A");
  useWorkflow
    .getState()
    .receive("poll-A", { workflow: run("poll-A", "failed") });
  const pollReply = deferred<Response>();
  const actionReply = deferred<Response>();
  let fetches = 0;
  globalThis.fetch = async () =>
    ++fetches === 1 ? pollReply.promise : actionReply.promise;
  const poll = useWorkflow.getState().refresh("poll-A");
  const action = useWorkflow
    .getState()
    .act({ type: "retry", runId: "run-poll-A" });
  await useWorkflow.getState().refresh("poll-A");
  assert.equal(fetches, 2);
  actionReply.resolve(
    response(run("poll-A", "running", "2026-10-04T10:01:00.000Z")),
  );
  await action;
  pollReply.resolve(response(run("poll-A", "failed")));
  await poll;
  assert.equal(useWorkflow.getState().run!.status, "running");
});

test("older same-run snapshots are ignored without hiding a newer current result", () => {
  useWorkflow.getState().enterRoom("time-A");
  useWorkflow
    .getState()
    .receive("time-A", {
      workflow: run("time-A", "completed", "2026-10-04T10:02:00.000Z"),
    });
  useWorkflow
    .getState()
    .receive("time-A", { workflow: run("time-A", "running") });
  assert.equal(useWorkflow.getState().run!.status, "completed");
});

test("sidebar refresh follows run and phase transitions, not submission polling", () => {
  useWorkflow.getState().enterRoom("refresh-A");
  useWorkflow.getState().receive("refresh-A", { workflow: null });
  assert.equal(roomRefreshes, 0);
  const current = run("refresh-A");
  useWorkflow.getState().receive("refresh-A", { workflow: current });
  assert.equal(roomRefreshes, 1);
  useWorkflow
    .getState()
    .receive("refresh-A", {
      workflow: { ...current, updatedAt: "2026-10-04T10:01:00.000Z" },
    });
  assert.equal(roomRefreshes, 1);
  useWorkflow
    .getState()
    .receive("refresh-A", {
      workflow: {
        ...current,
        phase: "peer_review",
        updatedAt: "2026-10-04T10:02:00.000Z",
      },
    });
  assert.equal(roomRefreshes, 2);
});
