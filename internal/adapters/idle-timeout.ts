export interface IdleTimeoutController {
  touch: () => void;
  clear: () => void;
}

export const createIdleTimeoutController = (
  timeoutMs: number,
  onTimeout: () => void,
): IdleTimeoutController => {
  const normalizedTimeoutMs = Math.max(1, Math.trunc(timeoutMs));
  let timer: NodeJS.Timeout | null = null;
  let active = true;

  const schedule = (): void => {
    if (!active) {
      return;
    }
    timer = setTimeout(() => {
      if (!active) {
        return;
      }
      active = false;
      timer = null;
      onTimeout();
    }, normalizedTimeoutMs);
  };

  const clear = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    active = false;
  };

  const touch = (): void => {
    if (!active) {
      return;
    }
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    schedule();
  };

  schedule();
  return { touch, clear };
};
