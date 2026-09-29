import { useSyncExternalStore } from "react";

/**
 * The room's browser as the Agoryx app exposes it to the daemon's page (`window.agoryxBrowser`, from the
 * app's preload; docs/plans/2026-09-29-desktop-browser-pane.md, C3). A plain browser has none, so the UI
 * shows no browser there. The types are the app's wire shapes (C1), kept here because the UI cannot import
 * the desktop's sources.
 */

export type BrowserOp = "navigate" | "snapshot" | "click" | "type" | "press" | "screenshot" | "eval";

/** Why the app would not open an address (the pane's URL policy); the panel says it in Ukrainian. */
export type UrlError = "empty" | "too-long" | "invalid" | "scheme" | "agoryx";

/** The agent whose command runs in the pane now; the app clears it 3 s after the command ends. */
export interface BrowserDriver {
  agent: string;
  label: string;
  op: BrowserOp;
  at: number;
}

/** One room's pane, as the app reports it. A room without a pane has no state. */
export interface BrowserPaneState {
  room: string;
  url: string | null;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  crashed: boolean;
  driver: BrowserDriver | null;
}

/** CSS pixels of the UI's viewport; the app scales them by the UI's zoom. */
export interface BrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BrowserGo = { ok: true } | { error: UrlError };

export interface AgoryxBrowser {
  /** Shows the room's pane over `rect` and hides every other one; `null` hides them all. */
  place: (room: string, rect: BrowserRect | null) => void;
  states: () => Promise<BrowserPaneState[]>;
  /** The human's own navigation: an address, or "back", "forward", "reload". */
  go: (room: string, target: string) => Promise<BrowserGo>;
  /** Opens the room's page in the human's own browser; the app needs this click to be recent. */
  outside: (room: string) => Promise<unknown>;
  /** Calls back with every pane's state now (a list), then with each pane's state as it changes; returns an
   *  unsubscribe. A pane that closed is pushed once as an empty state (no url, not loading, no driver). */
  onState: (callback: (state: BrowserPaneState | BrowserPaneState[]) => void) => () => void;
}

declare global {
  interface Window {
    agoryxBrowser?: AgoryxBrowser;
  }
}

export const browserBridge = (): AgoryxBrowser | null => {
  const bridge = window.agoryxBrowser;
  return bridge && typeof bridge.place === "function" ? bridge : null;
};

const panes = new Map<string, BrowserPaneState>();
const listeners = new Set<() => void>();
/** Which push last wrote each room, so an older `states()` reply never overwrites a newer push. */
const pushedAt = new Map<string, number>();
let pushes = 0;
let started = false;

const isState = (value: unknown): value is BrowserPaneState =>
  typeof value === "object" && value !== null && typeof (value as { room?: unknown }).room === "string";

const changed = () => {
  for (const listener of listeners) listener();
};

/** The app pushes this for a pane that closed (the room's network went off, the window closed): no pane. */
const isGone = (state: BrowserPaneState): boolean =>
  state.url === null && !state.loading && !state.crashed && state.driver === null && !state.canGoBack && !state.canGoForward;

const push = (value: unknown) => {
  // One state per push; the first call back is the whole set (the app's `states()`).
  const list = Array.isArray(value) ? value : [value];
  for (const state of list) {
    if (!isState(state)) continue;
    pushes += 1;
    pushedAt.set(state.room, pushes);
    if (isGone(state)) panes.delete(state.room);
    else panes.set(state.room, state);
  }
  changed();
};

/** Asks the app for every pane again: a room missing from the reply has no pane anymore. */
export const refreshBrowserStates = () => {
  const bridge = browserBridge();
  if (!bridge) return;
  const since = pushes;
  bridge
    .states()
    .then((list) => {
      const fresh = new Map((Array.isArray(list) ? list : []).filter(isState).map((state) => [state.room, state]));
      for (const room of new Set([...panes.keys(), ...fresh.keys()])) {
        if ((pushedAt.get(room) ?? 0) > since) continue;
        const state = fresh.get(room);
        if (state) panes.set(room, state);
        else panes.delete(room);
      }
      changed();
    })
    .catch(() => {});
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  const bridge = browserBridge();
  if (!started && bridge) {
    started = true;
    bridge.onState(push);
    refreshBrowserStates();
  }
  return () => {
    listeners.delete(listener);
  };
};

/** The room's pane as the app last reported it, or null while the room has none (or outside the app). */
export const useBrowserState = (room: string | null | undefined): BrowserPaneState | null =>
  useSyncExternalStore(subscribe, () => (room ? (panes.get(room) ?? null) : null));
