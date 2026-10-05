import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Stream, collectStream } from "../../internal/utils/stream.js";

describe("Stream<T>", () => {
  it("basic enqueue + iterate", async () => {
    const s = new Stream<number>();
    s.enqueue(1);
    s.enqueue(2);
    s.enqueue(3);
    s.end();

    const result: number[] = [];
    for await (const v of s) {
      result.push(v);
    }
    assert.deepEqual(result, [1, 2, 3]);
  });

  it("buffered values before consumer starts", async () => {
    const s = new Stream<string>();
    s.enqueue("a");
    s.enqueue("b");

    assert.equal(s.buffered, 2);

    // Now consume one
    const iter = s[Symbol.asyncIterator]();
    const first = await iter.next();
    assert.deepEqual(first, { value: "a", done: false });
    assert.equal(s.buffered, 1);

    const second = await iter.next();
    assert.deepEqual(second, { value: "b", done: false });
    assert.equal(s.buffered, 0);

    s.end();
    const third = await iter.next();
    assert.equal(third.done, true);
  });

  it("end() stops iteration", async () => {
    const s = new Stream<number>();

    // Start consuming in the background
    const collected = collectStream(s);

    s.enqueue(10);
    s.enqueue(20);
    s.end();

    const result = await collected;
    assert.deepEqual(result, [10, 20]);
  });

  it("abort() throws error in consumer", async () => {
    const s = new Stream<number>();
    const error = new Error("test abort");

    // Start consuming in the background
    const collected = collectStream(s);

    s.enqueue(1);
    s.abort(error);

    await assert.rejects(collected, (err: Error) => {
      assert.equal(err.message, "test abort");
      return true;
    });
  });

  it("enqueue() after end() is a no-op", async () => {
    const s = new Stream<number>();
    s.enqueue(1);
    s.end();
    s.enqueue(2); // should be silently ignored

    const result = await collectStream(s);
    assert.deepEqual(result, [1]);
  });

  it("collectStream helper works", async () => {
    const s = new Stream<string>();
    s.enqueue("x");
    s.enqueue("y");
    s.enqueue("z");
    s.end();

    const result = await collectStream(s);
    assert.deepEqual(result, ["x", "y", "z"]);
  });

  it("buffered count is accurate", () => {
    const s = new Stream<number>();
    assert.equal(s.buffered, 0);

    s.enqueue(1);
    assert.equal(s.buffered, 1);

    s.enqueue(2);
    s.enqueue(3);
    assert.equal(s.buffered, 3);
  });

  it("multiple end() calls are safe", async () => {
    const s = new Stream<number>();
    s.enqueue(1);
    s.end();
    s.end(); // second call should be a no-op
    s.end(); // third call should also be a no-op

    assert.equal(s.ended, true);
    const result = await collectStream(s);
    assert.deepEqual(result, [1]);
  });

  it("interleaved enqueue/consume works correctly", async () => {
    const s = new Stream<number>();
    const result: number[] = [];

    // Start consumer that collects values
    const done = (async () => {
      for await (const v of s) {
        result.push(v);
      }
    })();

    // Interleave: enqueue, let microtask run, enqueue more
    s.enqueue(1);
    await Promise.resolve(); // yield to let consumer pick up
    s.enqueue(2);
    await Promise.resolve();
    s.enqueue(3);
    await Promise.resolve();
    s.end();

    await done;
    assert.deepEqual(result, [1, 2, 3]);
  });

  it("ended is false before end/abort", () => {
    const s = new Stream<number>();
    assert.equal(s.ended, false);
    s.enqueue(1);
    assert.equal(s.ended, false);
  });

  it("ended is true after abort", () => {
    const s = new Stream<number>();
    s.abort(new Error("fail"));
    assert.equal(s.ended, true);
  });

  it("abort() after end() is a no-op", async () => {
    const s = new Stream<number>();
    s.enqueue(1);
    s.end();
    s.abort(new Error("should not matter"));

    // Should still collect cleanly
    const result = await collectStream(s);
    assert.deepEqual(result, [1]);
  });

  it("consumer waiting then producer enqueues resolves immediately", async () => {
    const s = new Stream<string>();
    const iter = s[Symbol.asyncIterator]();

    // Consumer starts waiting (no values buffered)
    const pending = iter.next();

    // Producer delivers
    s.enqueue("hello");

    const result = await pending;
    assert.deepEqual(result, { value: "hello", done: false });

    s.end();
    const final = await iter.next();
    assert.equal(final.done, true);
  });

  it("consumer waiting then abort rejects", async () => {
    const s = new Stream<number>();
    const iter = s[Symbol.asyncIterator]();

    // Consumer starts waiting
    const pending = iter.next();

    // Producer aborts
    s.abort(new Error("broken"));

    await assert.rejects(pending, (err: Error) => {
      assert.equal(err.message, "broken");
      return true;
    });
  });
});
