/**
 * HookRegistry — extensible pre/post dispatch hooks.
 *
 * Consumers register callbacks that fire around every dispatch.
 * Hook errors are caught so they never crash the dispatch itself.
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

export type PreHook = (payload: PreDispatchPayload) => void | Promise<void>;
export type PostHook = (payload: PostDispatchPayload) => void | Promise<void>;

export class HookRegistry {
  private readonly preHooks: PreHook[] = [];
  private readonly postHooks: PostHook[] = [];

  public onPreDispatch(hook: PreHook): void {
    this.preHooks.push(hook);
  }

  public onPostDispatch(hook: PostHook): void {
    this.postHooks.push(hook);
  }

  public async runPreHooks(payload: PreDispatchPayload): Promise<void> {
    for (const hook of this.preHooks) {
      try {
        await hook(payload);
      } catch {
        // Hook errors are swallowed — they must never crash a dispatch.
      }
    }
  }

  public async runPostHooks(payload: PostDispatchPayload): Promise<void> {
    for (const hook of this.postHooks) {
      try {
        await hook(payload);
      } catch {
        // Hook errors are swallowed — they must never crash a dispatch.
      }
    }
  }
}
