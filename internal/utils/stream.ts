/**
 * A push-based async iterator. Producers enqueue values; consumers
 * iterate with `for await`. Useful for bridging callback-based CLI
 * output (adapters) into a single typed stream.
 */
export class Stream<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolve: ((value: IteratorResult<T>) => void) | null = null;
  private reject: ((err: Error) => void) | null = null;
  private done = false;
  private error: Error | null = null;

  /** Push a value into the stream. */
  enqueue(value: T): void {
    if (this.done) return;

    if (this.resolve) {
      const resolve = this.resolve;
      this.resolve = null;
      this.reject = null;
      resolve({ value, done: false });
    } else {
      this.queue.push(value);
    }
  }

  /** Signal the stream is complete. No more values after this. */
  end(): void {
    if (this.done) return;
    this.done = true;

    if (this.resolve) {
      const resolve = this.resolve;
      this.resolve = null;
      this.reject = null;
      resolve({ value: undefined as unknown as T, done: true });
    }
  }

  /** Signal an error. Consumers will receive a rejection. */
  abort(err: Error): void {
    if (this.done) return;
    this.done = true;
    this.error = err;

    if (this.reject) {
      const reject = this.reject;
      this.resolve = null;
      this.reject = null;
      reject(err);
    }
  }

  /** Number of buffered (unconsumed) items. */
  get buffered(): number {
    return this.queue.length;
  }

  /** Whether the stream has ended (successfully or with error). */
  get ended(): boolean {
    return this.done;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        // Drain buffered items first
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }

        // If already ended with error, reject
        if (this.error) {
          return Promise.reject(this.error);
        }

        // If already ended cleanly, signal done
        if (this.done) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }

        // Wait for producer to enqueue, end, or abort
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.resolve = resolve;
          this.reject = reject;
        });
      },
    };
  }
}

/** Collect all values from a stream into an array. Useful for tests. */
export async function collectStream<T>(stream: Stream<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of stream) {
    result.push(value);
  }
  return result;
}
