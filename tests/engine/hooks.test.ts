import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HookRegistry,
  type PreDispatchPayload,
  type PostDispatchPayload,
} from "../../internal/engine/hooks.js";

const makePrePayload = (overrides?: Partial<PreDispatchPayload>): PreDispatchPayload => ({
  dispatchId: "dsp_test1",
  requestId: "req_test1",
  targetAdapter: "claude",
  roomId: "room_1",
  reason: "round-robin",
  timestamp: new Date().toISOString(),
  ...overrides,
});

const makePostPayload = (overrides?: Partial<PostDispatchPayload>): PostDispatchPayload => ({
  dispatchId: "dsp_test1",
  requestId: "req_test1",
  targetAdapter: "claude",
  roomId: "room_1",
  success: true,
  text: "hello world",
  durationMs: 123,
  timestamp: new Date().toISOString(),
  ...overrides,
});

describe("HookRegistry", () => {
  it("pre-hook receives correct payload", async () => {
    const registry = new HookRegistry();
    const received: PreDispatchPayload[] = [];
    registry.onPreDispatch("test", (p) => { received.push(p); });

    const payload = makePrePayload();
    await registry.runPreHooks(payload);

    assert.equal(received.length, 1);
    assert.deepStrictEqual(received[0], payload);
  });

  it("post-hook receives correct payload including durationMs", async () => {
    const registry = new HookRegistry();
    const received: PostDispatchPayload[] = [];
    registry.onPostDispatch("test", (p) => { received.push(p); });

    const payload = makePostPayload({ durationMs: 456 });
    await registry.runPostHooks(payload);

    assert.equal(received.length, 1);
    assert.equal(received[0]!.durationMs, 456);
    assert.deepStrictEqual(received[0], payload);
  });

  it("multiple hooks run in registration order", async () => {
    const registry = new HookRegistry();
    const order: string[] = [];

    registry.onPreDispatch("first", () => { order.push("first"); });
    registry.onPreDispatch("second", () => { order.push("second"); });
    registry.onPreDispatch("third", () => { order.push("third"); });

    await registry.runPreHooks(makePrePayload());

    assert.deepStrictEqual(order, ["first", "second", "third"]);
  });

  it("hook errors are caught and do not throw", async () => {
    const registry = new HookRegistry();
    const calls: string[] = [];

    registry.onPreDispatch("broken", () => { throw new Error("boom"); });
    registry.onPreDispatch("healthy", () => { calls.push("healthy"); });

    // Should not throw
    await registry.runPreHooks(makePrePayload());

    // The healthy hook still runs after the broken one
    assert.deepStrictEqual(calls, ["healthy"]);
  });

  it("async hooks work correctly", async () => {
    const registry = new HookRegistry();
    const results: number[] = [];

    registry.onPostDispatch("async-hook", async (p) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      results.push(p.durationMs);
    });

    await registry.runPostHooks(makePostPayload({ durationMs: 789 }));

    assert.deepStrictEqual(results, [789]);
  });

  it("unsubscribe function removes hook", async () => {
    const registry = new HookRegistry();
    const calls: string[] = [];

    const unsub = registry.onPreDispatch("removable", () => { calls.push("called"); });

    await registry.runPreHooks(makePrePayload());
    assert.equal(calls.length, 1);

    unsub();

    await registry.runPreHooks(makePrePayload());
    assert.equal(calls.length, 1); // not called again
  });

  it("clear() removes all hooks", async () => {
    const registry = new HookRegistry();
    const calls: string[] = [];

    registry.onPreDispatch("pre1", () => { calls.push("pre1"); });
    registry.onPostDispatch("post1", () => { calls.push("post1"); });

    registry.clear();

    await registry.runPreHooks(makePrePayload());
    await registry.runPostHooks(makePostPayload());

    assert.deepStrictEqual(calls, []);
  });

  it("listHooks() returns correct names", () => {
    const registry = new HookRegistry();

    registry.onPreDispatch("audit", () => {});
    registry.onPreDispatch("metrics", () => {});
    registry.onPostDispatch("logger", () => {});

    const hooks = registry.listHooks();
    assert.deepStrictEqual(hooks.pre, ["audit", "metrics"]);
    assert.deepStrictEqual(hooks.post, ["logger"]);
  });

  it("zero hooks registered — runPreHooks/runPostHooks are no-ops", async () => {
    const registry = new HookRegistry();

    // Should not throw, just resolve
    await registry.runPreHooks(makePrePayload());
    await registry.runPostHooks(makePostPayload());
  });

  it("mixed sync/async hooks work together", async () => {
    const registry = new HookRegistry();
    const order: string[] = [];

    registry.onPreDispatch("sync1", () => { order.push("sync1"); });
    registry.onPreDispatch("async1", async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      order.push("async1");
    });
    registry.onPreDispatch("sync2", () => { order.push("sync2"); });

    await registry.runPreHooks(makePrePayload());

    // Hooks run sequentially: sync1, then async1 (awaited), then sync2
    assert.deepStrictEqual(order, ["sync1", "async1", "sync2"]);
  });

  it("unsubscribe is idempotent", async () => {
    const registry = new HookRegistry();
    const calls: string[] = [];

    const unsub = registry.onPreDispatch("once", () => { calls.push("x"); });

    unsub();
    unsub(); // calling again should not crash

    await registry.runPreHooks(makePrePayload());
    assert.deepStrictEqual(calls, []);
  });

  it("post-hook receives error field on failed dispatch", async () => {
    const registry = new HookRegistry();
    const received: PostDispatchPayload[] = [];
    registry.onPostDispatch("err-check", (p) => { received.push(p); });

    const payload = makePostPayload({
      success: false,
      error: "TIMEOUT: adapter call timed out",
    });
    await registry.runPostHooks(payload);

    assert.equal(received.length, 1);
    assert.equal(received[0]!.success, false);
    assert.equal(received[0]!.error, "TIMEOUT: adapter call timed out");
  });

  it("async hook error is caught and does not block subsequent hooks", async () => {
    const registry = new HookRegistry();
    const calls: string[] = [];

    registry.onPostDispatch("async-broken", async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      throw new Error("async boom");
    });
    registry.onPostDispatch("after-broken", () => { calls.push("after"); });

    await registry.runPostHooks(makePostPayload());

    assert.deepStrictEqual(calls, ["after"]);
  });
});
