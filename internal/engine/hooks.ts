/**
 * Dispatch hook system.
 *
 * Hooks run before/after each adapter dispatch, allowing:
 * - Logging, metrics, auditing
 * - Context enrichment (pre-dispatch)
 * - Response filtering (post-dispatch)
 * - Error interception
 */

export interface PreDispatchPayload {
  dispatchId: string;
  requestId: string;
  targetAdapter: string;
  roomId: string;
  reason: string;
  timestamp: string;
}

export interface PostDispatchPayload {
  dispatchId: string;
  requestId: string;
  targetAdapter: string;
  roomId: string;
  success: boolean;
  text: string;
  error?: string;
  durationMs: number;
  timestamp: string;
}

export type PreDispatchHook = (payload: PreDispatchPayload) => void | Promise<void>;
export type PostDispatchHook = (payload: PostDispatchPayload) => void | Promise<void>;

export class HookRegistry {
  private preHooks: Array<{ name: string; fn: PreDispatchHook }> = [];
  private postHooks: Array<{ name: string; fn: PostDispatchHook }> = [];

  /** Register a pre-dispatch hook. Returns unsubscribe function. */
  public onPreDispatch(name: string, fn: PreDispatchHook): () => void {
    const entry = { name, fn };
    this.preHooks.push(entry);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const idx = this.preHooks.indexOf(entry);
      if (idx !== -1) this.preHooks.splice(idx, 1);
    };
  }

  /** Register a post-dispatch hook. Returns unsubscribe function. */
  public onPostDispatch(name: string, fn: PostDispatchHook): () => void {
    const entry = { name, fn };
    this.postHooks.push(entry);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const idx = this.postHooks.indexOf(entry);
      if (idx !== -1) this.postHooks.splice(idx, 1);
    };
  }

  /** Run all pre-dispatch hooks. Errors in hooks are caught and logged, never block dispatch. */
  public async runPreHooks(payload: PreDispatchPayload): Promise<void> {
    for (const hook of this.preHooks) {
      try {
        await hook.fn(payload);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[hook:pre:${hook.name}] error: ${message}\n`);
      }
    }
  }

  /** Run all post-dispatch hooks. Errors in hooks are caught and logged, never block dispatch. */
  public async runPostHooks(payload: PostDispatchPayload): Promise<void> {
    for (const hook of this.postHooks) {
      try {
        await hook.fn(payload);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[hook:post:${hook.name}] error: ${message}\n`);
      }
    }
  }

  /** Remove all hooks. */
  public clear(): void {
    this.preHooks = [];
    this.postHooks = [];
  }

  /** List registered hook names for diagnostics. */
  public listHooks(): { pre: string[]; post: string[] } {
    return {
      pre: this.preHooks.map((h) => h.name),
      post: this.postHooks.map((h) => h.name),
    };
  }
}
