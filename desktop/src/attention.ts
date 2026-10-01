import { app, BrowserWindow, Menu, Notification, powerMonitor, Tray, type MenuItemConstructorOptions } from "electron";
import { trayImage } from "./trayicon.js";

/**
 * When a room waits for the human: the tray, the Dock badge and banners (docs/plans/2026-09-29-desktop-attention.md,
 * Part B). Electron wiring only; what it decides lives in internal/desktop/attention.ts. Never throws into main.
 *
 * The main process reports where the app looks, once a second and on the window's own events, and the
 * daemon's answer is the list of rooms that wait. macOS only. Banners need a signed build: an unsigned one
 * gets the tray, the badge and the UI's sidebar dot, and a note in the tray menu.
 */

// The core's types, as far as attention uses them (internal/desktop/attention.ts; desktop/ compiles on its own).

type AttentionReason = "done" | "budget" | "stopped" | "error" | "mention";

interface AttentionItem {
  room: string;
  name: string;
  seq: number;
  ts: string;
  reason: AttentionReason;
  by?: string;
  text: string;
}

interface Looking {
  room: string | null;
  looking: boolean;
}

interface Banner {
  title: string;
  subtitle?: string;
  body: string;
  room: string;
}

interface Follower {
  setDaemon(info: { url: string; token: string } | null): void;
  report(looking: Looking): Promise<void>;
  /** Missing in a core built before it. */
  leave?(): Promise<void>;
  markSeen(room?: string): Promise<void>;
  items(): AttentionItem[];
  connected(): boolean;
  dispose(): void;
  on(event: "state", listener: (items: AttentionItem[], connected: boolean) => void): unknown;
  on(event: "arrived", listener: (item: AttentionItem) => void): unknown;
}

/** What attention needs from the core; missing when AGORYX_ROOT points at a core built before this feature. */
export interface AttentionCore {
  AttentionFollower?: new (options: { log?: (message: string) => void }) => Follower;
  lookingAt?: (input: { window: { url: string; visible: boolean; minimized: boolean } | null; locked: boolean; daemonOrigin: string | null }) => Looking;
  roomsWord?: (n: number) => string;
  trayLabel?: (item: AttentionItem) => string;
  bannerFor?: (items: AttentionItem[]) => Banner;
  nextBannerAt?: (firstPendingAt: number, lastBannerAt: number | null) => number;
}

export interface AttentionOptions {
  core: () => AttentionCore | null;
  window: () => BrowserWindow | null;
  focusWindow: () => void;
  isDaemonUrl: (url: string) => boolean;
  daemonOrigin: () => string | null;
  log: (message: string) => void;
}

export interface Attention {
  /** The daemon to follow, or null while there is none. The same url and token is a no-op. */
  setDaemon(info: { url: string; token: string } | null): void;
  dispose(): void;
}

type Helpers = Required<AttentionCore>;

const TICK_MS = 1000;
const MENU_ROOMS = 10;
const WINDOW_EVENTS = ["focus", "blur", "show", "hide", "minimize", "restore"] as const;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const createAttention = (options: AttentionOptions): Attention => {
  if (process.platform !== "darwin") return { setDaemon: () => {}, dispose: () => {} };
  const { log } = options;

  let core: Helpers | null = null;
  let follower: Follower | null = null;
  /** The core has no attention (built before it): logged once, and nothing more is tried. */
  let off = false;
  let disposed = false;
  let daemon: { url: string; token: string } | null = null;
  let tray: Tray | null = null;
  let dot = false;
  let badge = 0;
  let tick: NodeJS.Timeout | null = null;
  const hooked = new WeakSet<BrowserWindow>();

  /** A banner's "failed" (notifications off, or an unsigned build): logged once, and a note in the menu. */
  let bannersFailed = false;
  const pending = new Set<string>();
  let firstPendingAt = 0;
  let lastBannerAt: number | null = null;
  let bannerTimer: NodeJS.Timeout | null = null;
  /** Banners on screen, kept so their clicks still route; closed once none of their rooms waits. */
  let banners: Array<{ notification: Notification; rooms: string[] }> = [];

  const safe = (what: string, run: () => void): void => {
    try {
      run();
    } catch (error) {
      log(`${what} failed: ${messageOf(error)}`);
    }
  };

  // -------------------------------------------------------------------------
  // Where the app looks
  // -------------------------------------------------------------------------

  /** The focused window, when it is Agoryx's (the main one, or a child on the daemon's origin). */
  const looking = (helpers: Helpers): Looking => {
    const focused = BrowserWindow.getFocusedWindow();
    let window: { url: string; visible: boolean; minimized: boolean } | null = null;
    if (focused && !focused.isDestroyed()) {
      const url = focused.webContents.getURL();
      if (focused === options.window() || options.isDaemonUrl(url)) {
        window = { url, visible: focused.isVisible(), minimized: focused.isMinimized() };
      }
    }
    const locked = powerMonitor.getSystemIdleState(60) === "locked";
    return helpers.lookingAt({ window, locked, daemonOrigin: options.daemonOrigin() });
  };

  /** Follows the main window's own events too (a new window after the old one was closed included). */
  const hook = (): void => {
    const win = options.window();
    if (!win || win.isDestroyed() || hooked.has(win)) return;
    hooked.add(win);
    const onChange = (): void => safe("report", report);
    for (const name of WINDOW_EVENTS) win.on(name as "focus", onChange);
    win.webContents.on("did-navigate-in-page", onChange);
  };

  const report = (): void => {
    if (disposed || !core || !follower || !daemon) return;
    hook();
    follower.report(looking(core)).catch((error: unknown) => log(`report failed: ${messageOf(error)}`));
  };

  // -------------------------------------------------------------------------
  // Opening a room
  // -------------------------------------------------------------------------

  const openRoom = (room: string): void => {
    const hash = `#${encodeURIComponent(room)}`;
    const go = (contents: Electron.WebContents): Promise<void> => {
      // The start page (doctor, warnings, the daemon down) only comes forward; the room stays in the tray.
      if (contents.isDestroyed() || !options.isDaemonUrl(contents.getURL())) return Promise.resolve();
      return contents
        .executeJavaScript(`location.hash = ${JSON.stringify(hash)}`)
        .then(() => undefined)
        .catch((error: unknown) => log(`cannot open room ${room}: ${messageOf(error)}`));
    };
    const shown = options.window();
    if (shown && !shown.isDestroyed() && !shown.webContents.isLoading() && options.isDaemonUrl(shown.webContents.getURL())) {
      // The room first, then the focus: focused on the room still on screen, the app would report looking at
      // that room for a moment, and the daemon would mark its item seen.
      const contents = shown.webContents;
      void go(contents)
        .then(() => (contents.isDestroyed() || contents.getURL().endsWith(hash) ? undefined : inPage(contents)))
        .finally(() => safe("focus", options.focusWindow));
      return;
    }
    options.focusWindow();
    const win = options.window();
    if (!win || win.isDestroyed()) return;
    const contents = win.webContents;
    if (contents.isLoading()) contents.once("did-finish-load", () => safe("open", () => void go(contents)));
    else void go(contents);
  };

  /** The next in-page navigation, or 500 ms. */
  const inPage = (contents: Electron.WebContents): Promise<void> =>
    new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        contents.removeListener("did-navigate-in-page", done);
        resolve();
      };
      const timer = setTimeout(done, 500);
      contents.once("did-navigate-in-page", done);
    });

  // -------------------------------------------------------------------------
  // Tray, badge, banners
  // -------------------------------------------------------------------------

  const menu = (helpers: Helpers, items: AttentionItem[], connected: boolean): Menu => {
    const template: MenuItemConstructorOptions[] = items.slice(0, MENU_ROOMS).map((item) => ({
      label: helpers.trayLabel(item),
      click: () => safe("open", () => openRoom(item.room)),
    }));
    if (items.length > MENU_ROOMS) template.push({ label: `…and ${items.length - MENU_ROOMS} more`, enabled: false });
    template.push(
      {
        label: "Mark all as seen",
        enabled: items.length > 0,
        click: () => void follower?.markSeen().catch((error: unknown) => log(`mark seen failed: ${messageOf(error)}`)),
      },
      { type: "separator" },
      { label: "Open Agoryx", click: () => safe("focus", options.focusWindow) },
    );
    if (!connected) template.push({ label: "Agoryx is not responding", enabled: false });
    if (bannersFailed) template.push({ label: "macOS is not showing notifications", enabled: false });
    template.push({ type: "separator" }, { label: "Quit Agoryx", click: () => app.quit() });
    return Menu.buildFromTemplate(template);
  };

  const showState = (items: AttentionItem[], connected: boolean): void => {
    if (!core || !tray) return;
    const waiting = items.length > 0;
    if (waiting !== dot) {
      dot = waiting;
      tray.setImage(trayImage(dot));
    }
    tray.setToolTip(waiting ? `Agoryx — ${core.roomsWord(items.length)}` : "Agoryx");
    tray.setContextMenu(menu(core, items, connected));
    if (items.length !== badge) {
      badge = items.length;
      app.dock?.setBadge(badge ? String(badge) : "");
      log(`badge ${badge}`);
    }
    // A banner whose rooms were all seen has nothing left to say.
    const rooms = new Set(items.map((item) => item.room));
    banners = banners.filter((banner) => {
      if (banner.rooms.some((room) => rooms.has(room))) return true;
      banner.notification.close();
      return false;
    });
  };

  const showBanner = (): void => {
    bannerTimer = null;
    if (disposed || !core || !follower) return;
    const arrived = new Set(pending);
    pending.clear();
    const now = looking(core);
    const kept = follower.items().filter((item) => arrived.has(item.room) && !(now.looking && now.room === item.room));
    if (kept.length === 0) return;
    const banner = core.bannerFor(kept);
    const rooms = kept.map((item) => item.room);
    const notification = new Notification({ title: banner.title, ...(banner.subtitle ? { subtitle: banner.subtitle } : {}), body: banner.body });
    notification.on("show", () => {
      log(`banner ${rooms.join(" ")}`);
      // Notifications were turned on since one failed: the tray's note goes, and a later failure is logged again.
      if (!bannersFailed) return;
      bannersFailed = false;
      if (follower) safe("state", () => showState(follower!.items(), follower!.connected()));
    });
    notification.on("click", () => safe("open", () => openRoom(banner.room)));
    notification.on("close", () => {
      banners = banners.filter((entry) => entry.notification !== notification);
    });
    notification.on("failed", (_event, error) => {
      banners = banners.filter((entry) => entry.notification !== notification);
      if (bannersFailed) return;
      bannersFailed = true;
      log(`banner failed: ${error}`);
      if (follower) safe("state", () => showState(follower!.items(), follower!.connected()));
    });
    banners.push({ notification, rooms });
    lastBannerAt = Date.now();
    notification.show();
  };

  const arrived = (item: AttentionItem): void => {
    log(`arrived ${item.room} ${item.reason} seq=${item.seq}`);
    if (!core || !Notification.isSupported()) return;
    if (pending.size === 0) firstPendingAt = Date.now();
    pending.add(item.room);
    // Settle 2.5 s after the first arrival, and at most one banner per 10 s: a burst gives one banner.
    if (bannerTimer) return;
    const wait = Math.max(0, core.nextBannerAt(firstPendingAt, lastBannerAt) - Date.now());
    bannerTimer = setTimeout(() => safe("banner", showBanner), wait);
  };

  // -------------------------------------------------------------------------
  // Start, follow, stop
  // -------------------------------------------------------------------------

  /** Made on the first daemon: the follower, the tray and the tick. False when the core has no attention. */
  const start = (): boolean => {
    if (follower) return true;
    if (off) return false;
    const loaded = options.core();
    if (
      !loaded ||
      typeof loaded.AttentionFollower !== "function" ||
      typeof loaded.lookingAt !== "function" ||
      typeof loaded.roomsWord !== "function" ||
      typeof loaded.trayLabel !== "function" ||
      typeof loaded.bannerFor !== "function" ||
      typeof loaded.nextBannerAt !== "function"
    ) {
      off = true;
      log("this Agoryx core has no attention (built before it): no tray, badge or banners");
      return false;
    }
    core = loaded as Helpers;
    follower = new core.AttentionFollower({ log });
    follower.on("state", (items, connected) => safe("state", () => showState(items, connected)));
    follower.on("arrived", (item) => safe("arrived", () => arrived(item)));
    tray = new Tray(trayImage(false));
    tray.setToolTip("Agoryx");
    tray.setContextMenu(menu(core, [], false));
    // The looking report, and the poll that keeps the tray and the badge current in the background.
    tick = setInterval(() => safe("report", report), TICK_MS);
    return true;
  };

  return {
    setDaemon(info) {
      safe("attention", () => {
        if (disposed) return;
        const next = info ? { url: info.url, token: info.token } : null;
        if (next && daemon && next.url === daemon.url && next.token === daemon.token) return;
        if (next && !start()) return;
        daemon = next;
        follower?.setDaemon(next);
        if (next) report();
      });
    },
    dispose() {
      safe("attention", () => {
        if (disposed) return;
        disposed = true;
        if (tick) clearInterval(tick);
        if (bannerTimer) clearTimeout(bannerTimer);
        tick = null;
        bannerTimer = null;
        // The daemon stops counting this app as looking now, not when its view expires. Not awaited: the app quits.
        follower?.leave?.().catch(() => {});
        follower?.dispose();
        follower = null;
        tray?.destroy();
        tray = null;
      });
    },
  };
};
