import type { AttentionItem, AttentionReason } from "./types";

/**
 * Tells the daemon which room this tab looks at (docs/plans/2026-09-29-desktop-attention.md, Part C). The
 * callbacks come from the store, so this module does not import it.
 *
 * A tab looks while it is visible and focused. Inside the macOS app nothing is sent: the app's main
 * process reports its window itself (`document.hasFocus()` is unreliable in Electron). A plain same-origin
 * fetch with the page's cookie, not api(): a heartbeat that fails never shows an error or the login gate.
 */

const HEARTBEAT_MS = 15_000;

interface Report {
  view: string;
  room: string | null;
  looking: boolean;
}

const viewId = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

export const startAttention = (currentRoom: () => string | null, subscribe: (listener: () => void) => () => void): void => {
  if (typeof navigator === "undefined" || navigator.userAgent.includes("Electron/")) return;
  const view = viewId();
  let last: Report | null = null;

  const looking = (): boolean => document.visibilityState === "visible" && document.hasFocus();

  /** Sends where this tab looks; unchanged reports only as the heartbeat (`again`). */
  const send = (again = false, leaving = false): void => {
    const report: Report = { view, room: currentRoom(), looking: leaving ? false : looking() };
    if (!again && last && last.room === report.room && last.looking === report.looking) return;
    last = report;
    fetch("/api/attention/view", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
      credentials: "same-origin",
      keepalive: leaving,
    }).catch(() => {});
  };

  subscribe(() => send());
  document.addEventListener("visibilitychange", () => send());
  window.addEventListener("focus", () => send());
  window.addEventListener("blur", () => send());
  window.addEventListener("pageshow", () => send(true));
  window.addEventListener("pagehide", () => send(true, true));
  // A focused tab left alone keeps counting while it keeps saying so (the daemon forgets a view after 45 s).
  setInterval(() => {
    if (looking()) send(true);
  }, HEARTBEAT_MS);
  send(true);
};

const SHORT: Record<AttentionReason, (by: string | undefined) => string> = {
  done: () => "агенти закінчили",
  budget: () => "ліміт ходів вичерпано",
  stopped: () => "зупинено",
  mention: (by) => `${by ?? "агент"} кличе вас`,
  error: (by) => (by ? `хід ${by} не вдався` : "хід не вдався"),
};

/**
 * The sidebar dot's tip: «Чекає на вас: агенти закінчили», and « · агенти працюють» while they do. A mention
 * already names who calls («Claude кличе вас»), so it goes without the prefix. The tray's copy is
 * internal/desktop/attention.ts.
 */
export const waitingTip = (item: AttentionItem, running: boolean): string => {
  const reason = SHORT[item.reason](item.by);
  return `${item.reason === "mention" ? reason : `Чекає на вас: ${reason}`}${running ? " · агенти працюють" : ""}`;
};
