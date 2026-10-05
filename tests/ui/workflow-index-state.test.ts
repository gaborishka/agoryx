import assert from "node:assert/strict";
import { test } from "node:test";
import { useWorkflowIndex } from "../../ui/src/lib/workflow-index-state.js";

test("workspace history coalesces overlapping refreshes and keeps the last good list across a transient failure", async () => {
  const original = globalThis.fetch;
  const initial = useWorkflowIndex.getState();
  let release!: (value: Response) => void;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  }) as typeof fetch;
  try {
    const a = useWorkflowIndex.getState().refresh();
    const b = useWorkflowIndex.getState().refresh();
    assert.equal(a, b);
    assert.equal(calls, 1);
    release(
      new Response(
        JSON.stringify({
          workflows: [
            { id: "historical-run", mode: "council", status: "completed" },
          ],
          unavailable: [],
        }),
      ),
    );
    await a;
    assert.equal(useWorkflowIndex.getState().entries[0]?.id, "historical-run");
    const c = useWorkflowIndex.getState().refresh();
    release(
      new Response(JSON.stringify({ error: "temporarily unavailable" }), {
        status: 503,
      }),
    );
    await c;
    assert.equal(useWorkflowIndex.getState().entries[0]?.id, "historical-run");
    assert.equal(useWorkflowIndex.getState().error, "temporarily unavailable");
    const d = useWorkflowIndex.getState().refresh();
    release(
      new Response(
        JSON.stringify({
          workflows: [
            { id: "new-run", mode: "verification", status: "running" },
          ],
          unavailable: [],
        }),
      ),
    );
    await d;
    assert.equal(useWorkflowIndex.getState().entries[0]?.id, "new-run");
    assert.equal(useWorkflowIndex.getState().error, null);
  } finally {
    globalThis.fetch = original;
    useWorkflowIndex.setState(initial, true);
  }
});
