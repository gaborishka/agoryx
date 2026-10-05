import { app, ipcMain, session, shell, WebContentsView } from "electron";
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent, Rectangle, Session, WebContents } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The room's browser: one pane per room inside the main window, driven by agents over the daemon's host link
 * (docs/archive/plans/2026-09-29-desktop-browser-pane.md, Part C). Never throws into main.
 *
 * Agoryx never acts in a pane by itself: a pane changes only on an agent's command (relayed by the daemon) or on
 * the human's hand. Each room has its own in-memory session, gone when the app quits. The page is laid out
 * 1280 CSS px wide and scaled into the pane, so agents get a desktop layout whatever the pane's size.
 */

// The core's types, as far as the pane uses them (internal/desktop/browserlink.ts and browserpage.ts; desktop/
// compiles on its own, so they are declared here and the modules are loaded from dist/ at runtime).

type BrowserOp = "navigate" | "snapshot" | "click" | "type" | "press" | "screenshot" | "eval";

interface BrowserCommandWire {
  id: string;
  room: string;
  roomName: string;
  agent: string;
  label: string;
  op: BrowserOp;
  args: Record<string, unknown>;
  /** Epoch ms. */
  deadline: number;
}

interface BrowserResult {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  text?: string;
  image?: { data: string; mimeType: "image/png" };
  notes?: string[];
}

type BrowserAnswer = { ok: true; result: BrowserResult } | { ok: false; error: string };

type UrlError = "empty" | "too-long" | "invalid" | "scheme" | "agoryx";

interface Link {
  readonly running: boolean;
  readonly replaced: boolean;
  start(): void;
  stop(): void;
}

interface RefTable {
  ref(backendNodeId: number): string;
  node(ref: string): number | undefined;
  forgetDocument(): void;
}

interface KeyStroke {
  type: "keyDown" | "rawKeyDown" | "keyUp";
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  modifiers: number;
  text?: string;
}

interface Helpers {
  BrowserLink: new (options: {
    url: string;
    token: string;
    handle: (command: BrowserCommandWire) => Promise<BrowserAnswer>;
    closeRoom: (room: string) => void;
    cancel?: (id: string) => void;
    log?: (line: string) => void;
  }) => Link;
  URL_ERROR_TEXT: Record<UrlError, string>;
  AGORYX_PORTS: readonly number[];
  isAgoryxAddress: (url: string, seen: ReadonlySet<number>) => boolean;
  paneUrl: (input: string, blocked: (port: number) => boolean) => { url: string } | { error: UrlError };
  RefTable: new () => RefTable;
  formatSnapshot: (nodes: unknown[], refs: RefTable, options?: { maxChars?: number }) => string;
  keyEvents: (spec: string) => KeyStroke[] | { error: string };
  clip: (value: string, max: number) => string;
  browserStep: (op: string, args: unknown) => string;
}

export interface BrowserPanesOptions {
  root: string;
  /** The daemon's UI in the main window's main frame, not a preview. */
  trustedUi: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean;
  /** Takes the page's last click, as main's takeGesture does. */
  userGesture: (contents: WebContents) => boolean;
  log?: (line: string) => void;
}

/** What the UI gets for each room with a pane (ui/src/lib/desktop.ts). */
export interface BrowserPaneState {
  room: string;
  url: string | null;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  crashed: boolean;
  driver: { agent: string; label: string; op: BrowserOp; at: number } | null;
}

interface ConsoleLine {
  level: "error" | "warning";
  text: string;
}

interface Pane {
  room: string;
  view: WebContentsView;
  contents: WebContents;
  refs: RefTable;
  ready: Promise<void>;
  shown: boolean;
  /** The reason the page's process went away, or null. */
  crashed: string | null;
  closed: boolean;
  /** The agent's command running in the pane, and the notes it collects. */
  running: { command: BrowserCommandWire; notes: string[] } | null;
  /** Fails the running command at once (the pane closed or crashed). */
  abort: ((error: Error) => void) | null;
  driver: BrowserPaneState["driver"];
  driverTimer: NodeJS.Timeout | null;
  console: ConsoleLine[];
  /** Console errors since the pane opened, and how many each agent was told about. */
  errors: number;
  errorsSeen: Map<string, number>;
  dialog: { type: string; message: string } | null;
  reattached: boolean;
  lastUrl: string | null;
}

/** What happened in a room's browser, kept for the notes; it outlives a crashed pane. */
interface Ledger {
  seq: number;
  steps: { seq: number; agent: string; label: string; step: string }[];
  /** The last step each agent was told about (its own included). */
  seen: Map<string, number>;
  /** When each agent's last command ended. */
  lastAt: Map<string, number>;
  humanAt: number;
  /** Events between commands (a hidden pane's dialog, a refused download …), for the room's next result. */
  pending: string[];
}

const LAYOUT_WIDTH = 1280;
const DEFAULT_BOUNDS: Rectangle = { x: 0, y: 0, width: 760, height: 800 };
const PUSH_MS = 100;
const DRIVER_LINGER_MS = 3_000;
/** Each op's own limit, inside the relay's 60 s (the spec's limits table). */
const LOAD_MS = 30_000;
const WAIT_TEXT_MS = 5_000;
const WAIT_TEXT_MAX_MS = 30_000;
const EVAL_MS = 20_000;
const ACT_MS = 10_000;
/** Answering a JavaScript dialog is quick, or the page is stuck. */
const DIALOG_MS = 3_000;
/** A click, a key or a submit that starts a navigation within this long waits for its load. */
const NAV_START_MS = 500;
const POLL_MS = 250;
const CONSOLE_KEEP = 50;
const CONSOLE_SHOW = 20;
const OTHER_STEPS = 10;
const KEEP_STEPS = 500;
const KEEP_PENDING = 50;
const EVAL_CHARS = 20_000;

// Agent-facing texts, in English like the tools (the spec's A4 table and C1).
const WINDOW_CLOSED = "The Agoryx window is closed, and the room's browser lives in it. The human can reopen it from the Dock.";
const PAST_DEADLINE = "This command waited in the room's browser past its deadline, so it was not run.";
const NETWORK_OFF = "This room's network was turned off, so its browser closed.";
const WITHDRAWN = "This command was withdrawn (the agent's turn ended or its call was cancelled), so it was not run.";
/** The human's address bar in a room whose network is off (spec: such a room's browser is off, for everyone). */
const HUMAN_NETWORK_OFF = "This room’s network is off, so its browser is off too. Turn the network on in the room’s settings.";
const NO_DAEMON_ANSWER = "Agoryx is not responding, so it can’t tell whether this room’s network is on. The page was not opened.";
const staleRef = (ref: string) => `ref ${ref} is not on the page anymore (it changed or navigated). Take a new browser_snapshot.`;
const tookTooLong = (op: BrowserOp, ms: number) =>
  `The ${op} did not finish within ${Math.round(ms / 1000)} s. It may or may not have happened in the page.`;
const CONFIRM_TAIL = "Agoryx does not answer confirm for agents; stub window.confirm with browser_eval first to test that path.";

/** Inputs that count as the human's hand in a pane (moving the mouse over it does not). */
const HUMAN_INPUTS = new Set(["mouseDown", "mouseWheel", "keyDown", "rawKeyDown", "char", "touchStart", "gestureTap", "gestureScrollBegin"]);
/** Inputs whose native picker would open over the human's screen: never clicked. */
const PICKERS = new Set(["color", "date", "datetime-local", "month", "week", "time", "file"]);
const REFUSED_SCHEMES = new Set(["file:", "chrome:", "devtools:", "chrome-extension:"]);
/** Accessibility roles that name no kind of element: a note shows the tag instead. */
const BLAND_ROLES = new Set(["none", "generic", "presentation", "GenericContainer"]);

/** window.print does nothing, and says so in the console lines. */
const PRINT_STUB = `window.print = () => console.warn("window.print() was called; printing is not available in the room's browser");`;
/**
 * document.execCommand copy, cut and paste do nothing, and say so: an agent's click is trusted input, and a page's
 * click handler could otherwise reach the human's clipboard, which no permission check sees.
 */
const CLIPBOARD_STUB = `{
  const exec = Document.prototype.execCommand;
  Document.prototype.execCommand = function (command, ...rest) {
    const name = String(command).toLowerCase();
    if (name === "copy" || name === "cut" || name === "paste") {
      console.warn("document.execCommand(" + JSON.stringify(name) + ") was called; the clipboard is not available in the room's browser");
      return false;
    }
    return exec.call(this, command, ...rest);
  };
}`;

// Page functions for Runtime.callFunctionOn (`this` is the element).
const KIND_FN = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el) return { tag: "", type: "", connected: false };
  return { tag: el.localName, type: el.localName === "input" ? String(el.type || "").toLowerCase() : "", connected: el.isConnected };
}`;
const CONTAINS_FN = `function (other) {
  for (let node = other; node; node = node.parentNode || node.host) if (node === this) return true;
  return false;
}`;
const SELECT_ALL_FN = `function () {
  if ("value" in this && typeof this.select === "function") {
    try { this.select(); return true; } catch { /* not selectable */ }
  }
  if (this.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(this);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }
  return false;
}`;
const CHOOSE_FN = `function (text) {
  const options = Array.from(this.options || []);
  const option = options.find((o) => o.label === text) || options.find((o) => o.value === text);
  if (!option) return { labels: options.slice(0, 20).map((o) => o.label), count: options.length };
  option.selected = true;
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return { chosen: option.label };
}`;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Rejects with `failure()` when `work` takes longer than `ms`. */
const within = <T>(work: Promise<T>, ms: number, failure: () => Error): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(failure()), Math.max(0, ms));
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** Resolves true when `contents` emits `event` within `ms`, else false. */
const onceWithin = (contents: WebContents, event: "did-start-loading" | "did-stop-loading", ms: number): Promise<boolean> =>
  new Promise((resolve) => {
    // Both events take no arguments; the union does not fit WebContents' overloads.
    const emitter: NodeJS.EventEmitter = contents;
    const done = (value: boolean) => {
      clearTimeout(timer);
      emitter.removeListener(event, fired);
      resolve(value);
    };
    const fired = () => done(true);
    const timer = setTimeout(() => done(false), Math.max(0, ms));
    emitter.on(event, fired);
  });

/** Chrome's own user agent: Electron's and the app's tokens dropped, so sites treat the pane as Chrome. */
const chromeLike = (agent: string): string =>
  agent.match(/\([^)]*\)|\S+/g)?.filter((token) => token.startsWith("(") || /^(Mozilla|AppleWebKit|Chrome|Safari)\//.test(token)).join(" ") ??
  agent;

const partitionOf = (room: string): string => `agoryx-browser-${room}`;

const isRect = (value: unknown): value is { x: number; y: number; width: number; height: number } => {
  if (typeof value !== "object" || value === null) return false;
  const rect = value as Record<string, unknown>;
  return ["x", "y", "width", "height"].every((key) => typeof rect[key] === "number" && Number.isFinite(rect[key]));
};

const isRoom = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;

export class BrowserPanes {
  private readonly log: (line: string) => void;
  private win: BrowserWindow | null = null;
  private helpers: Helpers | null = null;
  private loading: Promise<Helpers | null> | null = null;
  private link: Link | null = null;
  private linkTarget: { url: string; token: string } | null = null;
  private target: { url: string; token: string } | null = null;
  /** Every daemon port the app has seen: the panes never open them. It only grows. */
  private readonly seenPorts = new Set<number>();
  private readonly panes = new Map<string, Pane>();
  private readonly sessions = new Map<string, Session>();
  private readonly paneSessions = new Set<Session>();
  private readonly ledgers = new Map<string, Ledger>();
  private readonly chains = new Map<string, Promise<void>>();
  /** Bumped each time a room's network goes off: a command queued before that is refused, not run. */
  private readonly generations = new Map<string, number>();
  /** Commands handed to a room's chain and not yet answered. */
  private readonly inChain = new Set<string>();
  /** Of those, the ones the daemon withdrew: skipped unless started. An id leaves both sets when its run ends. */
  private readonly withdrawn = new Set<string>();
  /** The last bounds placed for each room, in the window's DIP. */
  private readonly bounds = new Map<string, Rectangle>();
  private placed: string | null = null;
  private readonly pushes = new Map<string, { at: number; timer: NodeJS.Timeout | null }>();
  private listening = false;
  private stopped = false;

  // Main makes this object before the app is ready: the constructor only keeps its options.
  constructor(readonly options: BrowserPanesOptions) {
    this.log = options.log ?? (() => {});
  }

  /** A pane's contents: main's guard() leaves them to the pane's own rules. Known while the view is being made. */
  owns(contents: WebContents): boolean {
    try {
      return contents.getType() !== "remote" && this.paneSessions.has(contents.session);
    } catch {
      return false;
    }
  }

  /** The main window: panes live in it. */
  attachWindow(win: BrowserWindow): void {
    this.win = win;
    win.on("closed", () => {
      if (this.win === win) {
        this.win = null;
        this.placed = null;
      }
      for (const pane of [...this.panes.values()]) this.closePane(pane, WINDOW_CLOSED);
    });
    // The start page, a reload or a crash of the UI: nothing may float over a page that did not place it.
    win.webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.unplace();
    });
    win.webContents.on("render-process-gone", () => this.unplace());
  }

  /** Idempotent: restarts the host link only when the url or the token changed. */
  connect(info: { url: string; token: string; port: number }): void {
    if (this.stopped) return;
    if (Number.isInteger(info.port) && info.port > 0) this.seenPorts.add(info.port);
    this.target = { url: info.url, token: info.token };
    if (this.linkHolds(this.target)) return;
    void this.startLink();
  }

  /** IPC handlers, and the app's certificate and login handlers. */
  listen(): void {
    if (this.listening) return;
    this.listening = true;
    // A request without contents (a pane's service worker) is refused too: Electron's default sends the first
    // certificate in the keychain. The UI's own daemon is plain http and never asks.
    app.on("select-client-certificate", (event, contents, url, _list, callback) => {
      if (contents && !this.owns(contents)) return;
      event.preventDefault();
      callback();
      const pane = contents ? this.paneOf(contents) : null;
      if (pane) this.note(pane, `${hostOf(url)} asked for a client certificate; none was sent`);
    });
    app.on("login", (event, contents, _details, authInfo, callback) => {
      const pane = contents ? this.paneOf(contents) : null;
      if (!pane) return;
      event.preventDefault();
      callback();
      this.note(pane, `${authInfo.host} asked for a sign-in; none was given`);
    });
    ipcMain.on("agoryx:browser:place", (event, room: unknown, rect: unknown) => {
      if (!this.options.trustedUi(event)) return;
      this.place(room, rect);
    });
    ipcMain.handle("agoryx:browser:states", (event) => {
      this.refuseUntrusted(event);
      return [...this.panes.values()].map((pane) => this.stateOf(pane));
    });
    ipcMain.handle("agoryx:browser:go", (event, room: unknown, target: unknown) => {
      this.refuseUntrusted(event);
      if (!isRoom(room) || typeof target !== "string") throw new Error("Unknown room or address.");
      return this.go(room, target);
    });
    ipcMain.handle("agoryx:browser:outside", async (event, room: unknown) => {
      this.refuseUntrusted(event);
      if (!this.options.userGesture(event.sender)) throw new Error("A page can be opened in another browser only by a click in the Agoryx window.");
      const pane = isRoom(room) ? this.panes.get(room) : undefined;
      const url = pane && !pane.contents.isDestroyed() ? pane.contents.getURL() : "";
      let parsed: URL | null = null;
      try {
        parsed = new URL(url);
      } catch {
        // not an address
      }
      if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
        throw new Error("This page can’t be opened in another browser.");
      }
      await shell.openExternal(parsed.href);
    });
  }

  /** Stops the link and closes every pane. */
  close(): void {
    this.stopped = true;
    this.link?.stop();
    this.link = null;
    for (const pane of [...this.panes.values()]) this.closePane(pane, WINDOW_CLOSED);
    for (const entry of this.pushes.values()) if (entry.timer) clearTimeout(entry.timer);
    this.pushes.clear();
  }

  // -------------------------------------------------------------------------
  // The core's modules and the host link
  // -------------------------------------------------------------------------

  /** browserlink.js and browserpage.js from <root>/dist/internal/desktop/, once. Null when they are missing. */
  private load(): Promise<Helpers | null> {
    this.loading ??= (async () => {
      const dir = join(this.options.root, "dist", "internal", "desktop");
      try {
        const [link, page] = await Promise.all([
          import(pathToFileURL(join(dir, "browserlink.js")).href) as Promise<Pick<Helpers, "BrowserLink">>,
          import(pathToFileURL(join(dir, "browserpage.js")).href) as Promise<Omit<Helpers, "BrowserLink">>,
        ]);
        this.helpers = { ...page, BrowserLink: link.BrowserLink };
        return this.helpers;
      } catch (error) {
        this.log(`the room's browser is off: ${dir} could not be loaded (${messageOf(error)})`);
        return null;
      }
    })();
    return this.loading;
  }

  private async startLink(): Promise<void> {
    const helpers = await this.load();
    const target = this.target;
    if (!helpers || !target || this.stopped) return;
    if (this.linkHolds(target)) return;
    this.link?.stop();
    this.linkTarget = target;
    this.link = new helpers.BrowserLink({
      url: target.url,
      token: target.token,
      handle: (command) => this.handle(command),
      closeRoom: (room) => this.closeRoom(room),
      cancel: (id) => {
        if (this.inChain.has(id)) this.withdrawn.add(id);
      },
      log: (line) => this.log(line.replace(/^browser: /, "")),
    });
    this.link.start();
  }

  /**
   * The link for this daemon is running, or another app took the host from it (B1: `replaced` stops without
   * reconnecting, so a re-render does not take the host back). Only a new url or token starts a link again.
   */
  private linkHolds(target: { url: string; token: string }): boolean {
    const same = this.linkTarget?.url === target.url && this.linkTarget.token === target.token;
    return same && this.link !== null && (this.link.running || this.link.replaced);
  }

  /** The room's network went off: its pane closes, and commands that came before it are not run. */
  private closeRoom(room: string): void {
    this.generations.set(room, (this.generations.get(room) ?? 0) + 1);
    const pane = this.panes.get(room);
    if (pane) this.closePane(pane, NETWORK_OFF);
  }

  private blocked = (port: number): boolean => (this.helpers?.AGORYX_PORTS.includes(port) ?? true) || this.seenPorts.has(port);

  // -------------------------------------------------------------------------
  // Sessions and panes
  // -------------------------------------------------------------------------

  /** The room's own in-memory session, set up once: no permission, no device, no download, no Agoryx address. */
  private sessionFor(room: string, helpers: Helpers): Session {
    const known = this.sessions.get(room);
    if (known) return known;
    const ses = session.fromPartition(partitionOf(room));
    this.sessions.set(room, ses);
    this.paneSessions.add(ses);
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.setDevicePermissionHandler(() => false);
    ses.on("select-hid-device", (event, _details, callback) => {
      event.preventDefault();
      callback();
    });
    ses.on("select-serial-port", (event, _ports, _contents, callback) => {
      event.preventDefault();
      callback("");
    });
    ses.on("select-usb-device", (event, _details, callback) => {
      event.preventDefault();
      callback();
    });
    ses.on("will-download", (event, item, contents) => {
      const name = item.getFilename() || item.getURL();
      event.preventDefault();
      const pane = this.paneOf(contents);
      if (pane) this.note(pane, `a download was refused (${helpers.clip(name, 200)})`);
    });
    // Every daemon of this version refuses a request with this header before it looks at anything else.
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, "x-agoryx-pane": "1" } });
    });
    ses.webRequest.onBeforeRequest((details, callback) => {
      const refusal = this.refusal(details.url, details.resourceType, helpers);
      if (refusal && (details.resourceType === "mainFrame" || details.resourceType === "subFrame") && details.webContents) {
        const pane = this.paneOf(details.webContents);
        if (pane) this.note(pane, `a navigation to ${helpers.clip(details.url, 300)} was blocked: ${refusal}`, true);
      }
      callback({ cancel: refusal !== null });
    });
    ses.setUserAgent(chromeLike(ses.getUserAgent()));
    return ses;
  }

  /** Why a request from a pane is cancelled, or null: Agoryx's own addresses, local schemes, odd frame loads. */
  private refusal(url: string, type: string, helpers: Helpers): string | null {
    if (helpers.isAgoryxAddress(url, this.seenPorts)) return helpers.URL_ERROR_TEXT.agoryx;
    let protocol = "";
    try {
      protocol = new URL(url).protocol;
    } catch {
      return helpers.URL_ERROR_TEXT.invalid;
    }
    if (REFUSED_SCHEMES.has(protocol)) return helpers.URL_ERROR_TEXT.scheme;
    const frame = type === "mainFrame" || type === "subFrame";
    if (frame && protocol !== "http:" && protocol !== "https:" && url !== "about:blank") return helpers.URL_ERROR_TEXT.scheme;
    return null;
  }

  private ledger(room: string): Ledger {
    let ledger = this.ledgers.get(room);
    if (!ledger) {
      ledger = { seq: 0, steps: [], seen: new Map(), lastAt: new Map(), humanAt: 0, pending: [] };
      this.ledgers.set(room, ledger);
    }
    return ledger;
  }

  private paneOf(contents: WebContents): Pane | null {
    for (const pane of this.panes.values()) if (pane.contents === contents) return pane;
    return null;
  }

  /** The room's pane, made when it has none (on the first command or the human's first navigation). */
  private openPane(room: string, helpers: Helpers): Promise<Pane> {
    const existing = this.panes.get(room);
    if (existing && !existing.closed) return existing.ready.then(() => existing);
    const win = this.win;
    if (!win || win.isDestroyed()) return Promise.reject(new Error(WINDOW_CLOSED));
    const pane = this.makePane(room, win, helpers);
    this.panes.set(room, pane);
    return pane.ready.then(
      () => pane,
      (error: unknown) => {
        this.closePane(pane, null);
        throw new Error(`The room's browser could not open a page: ${messageOf(error)}`);
      },
    );
  }

  private makePane(room: string, win: BrowserWindow, helpers: Helpers): Pane {
    const ses = this.sessionFor(room, helpers);
    // No preload: the page gets nothing from the app.
    const view = new WebContentsView({
      webPreferences: {
        partition: partitionOf(room),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        backgroundThrottling: false,
        spellcheck: false,
        safeDialogs: true,
      },
    });
    const contents = view.webContents;
    if (contents.session !== ses) this.paneSessions.add(contents.session);
    const pane: Pane = {
      room,
      view,
      contents,
      refs: new helpers.RefTable(),
      ready: Promise.resolve(),
      shown: false,
      crashed: null,
      closed: false,
      running: null,
      abort: null,
      driver: null,
      driverTimer: null,
      console: [],
      errors: 0,
      errorsSeen: new Map(),
      dialog: null,
      reattached: false,
      lastUrl: null,
    };
    contents.setAudioMuted(true);
    void contents.setVisualZoomLevelLimits(1, 1).catch(() => {});
    view.setBackgroundColor("#ffffff");
    view.setBounds(this.bounds.get(room) ?? DEFAULT_BOUNDS);
    win.contentView.addChildView(view);
    view.setVisible(false);
    this.guardPane(pane, helpers);
    this.watchPane(pane);
    pane.ready = (async () => {
      await contents.loadURL("about:blank");
      this.wake(pane);
      // Only now: attached before about:blank has loaded, Page.enable never answers.
      contents.debugger.attach("1.3");
      await this.enableCdp(pane);
      this.applyZoom(pane);
      if (this.placed === room && !pane.closed) this.show(pane, true);
      this.pushState(room);
    })();
    return pane;
  }

  /** What may load in a pane: the URL policy for every frame and redirect, popups in the same pane, no webviews. */
  private guardPane(pane: Pane, helpers: Helpers): void {
    const { contents } = pane;
    const check = (event: { url: string; preventDefault: () => void }) => {
      if (event.url === "about:blank") return;
      const checked = helpers.paneUrl(event.url, this.blocked);
      if ("url" in checked) return;
      event.preventDefault();
      this.note(pane, `a navigation to ${helpers.clip(event.url, 300)} was blocked: ${helpers.URL_ERROR_TEXT[checked.error]}`, true);
    };
    // For the main frame both fire; the refusal is noted once.
    contents.on("will-navigate", check);
    contents.on("will-frame-navigate", check);
    contents.on("will-redirect", check);
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      const checked = helpers.paneUrl(url, this.blocked);
      if ("url" in checked) contents.loadURL(checked.url).catch(() => {});
      else this.note(pane, `a navigation to ${helpers.clip(url, 300)} was blocked: ${helpers.URL_ERROR_TEXT[checked.error]}`, true);
      return { action: "deny" };
    });
    contents.on("select-bluetooth-device", (event, _devices, callback) => {
      event.preventDefault();
      callback("");
    });
  }

  /** The page's state for the UI, the zoom, the human's hand, and a crash. */
  private watchPane(pane: Pane): void {
    const { contents, room } = pane;
    const changed = () => this.pushState(room);
    contents.on("did-navigate", (_event, url) => {
      if (/^https?:/i.test(url)) pane.lastUrl = url;
      // A cross-site navigation brings a new renderer, and it starts hidden like the first one.
      this.wake(pane);
      this.applyZoom(pane);
      changed();
    });
    contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (isMainFrame && /^https?:/i.test(url)) pane.lastUrl = url;
      changed();
    });
    contents.on("page-title-updated", changed);
    contents.on("did-start-loading", changed);
    contents.on("did-stop-loading", changed);
    contents.on("zoom-changed", () => this.applyZoom(pane));
    contents.on("input-event", (_event, input) => {
      if (!pane.running && HUMAN_INPUTS.has(input.type)) this.ledger(room).humanAt = Date.now();
    });
    contents.on("render-process-gone", (_event, details) => {
      if (pane.closed) return;
      pane.crashed = details.reason;
      this.log(`a page crashed in room ${room} (${details.reason})`);
      pane.abort?.(new Error(`the page crashed (${details.reason}) while running this command`));
      changed();
    });
  }

  private async enableCdp(pane: Pane): Promise<void> {
    const cdp = pane.contents.debugger;
    if (!pane.reattached) {
      cdp.on("message", (_event, method, params) => this.onCdp(pane, method, params as Record<string, unknown>));
      cdp.on("detach", (_event, reason) => this.onDetach(pane, reason));
    }
    await Promise.all(["Page.enable", "Runtime.enable", "Log.enable", "DOM.enable", "Accessibility.enable"].map((method) => cdp.sendCommand(method)));
    await cdp.sendCommand("Page.setInterceptFileChooserDialog", { enabled: true });
    await cdp.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: `${PRINT_STUB}\n${CLIPBOARD_STUB}` });
  }

  private onDetach(pane: Pane, reason: string): void {
    if (pane.closed || pane.crashed || pane.contents.isDestroyed()) return;
    if (!pane.reattached) {
      pane.reattached = true;
      try {
        pane.contents.debugger.attach("1.3");
        void this.enableCdp(pane).catch(() => this.lost(pane, reason));
        return;
      } catch {
        // could not attach again
      }
    }
    this.lost(pane, reason);
  }

  /** The pane can no longer be driven: it counts as crashed. */
  private lost(pane: Pane, reason: string): void {
    if (pane.closed || pane.crashed) return;
    pane.crashed = `the browser's control channel closed: ${reason}`;
    pane.abort?.(new Error(`the page crashed (${pane.crashed}) while running this command`));
    this.pushState(pane.room);
  }

  private onCdp(pane: Pane, method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "Page.javascriptDialogOpening":
        this.onDialog(pane, String(params.type ?? ""), String(params.message ?? ""));
        return;
      case "Page.javascriptDialogClosed":
        pane.dialog = null;
        return;
      case "Page.fileChooserOpened":
        this.note(pane, "a file chooser was suppressed; file upload is not supported");
        return;
      case "Page.frameNavigated": {
        const frame = params.frame as { parentId?: string } | undefined;
        if (frame && !frame.parentId) {
          pane.refs.forgetDocument();
          // Checked for one document only, so it is set again for each.
          void this.cdp(pane, "Page.setInterceptFileChooserDialog", { enabled: true }).catch(() => {});
        }
        return;
      }
      case "Runtime.consoleAPICalled": {
        const type = params.type;
        if (type !== "error" && type !== "warning") return;
        const args = Array.isArray(params.args) ? (params.args as { value?: unknown; description?: string; unserializableValue?: string }[]) : [];
        const text = args
          .map((arg) => (typeof arg.value === "string" ? arg.value : (arg.description ?? arg.unserializableValue ?? JSON.stringify(arg.value) ?? "")))
          .join(" ");
        // Electron's own warning in an unpackaged app, not the page's.
        if (text.startsWith("%cElectron Security Warning")) return;
        this.consoleLine(pane, type, text);
        return;
      }
      case "Runtime.exceptionThrown": {
        const details = params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
        this.consoleLine(pane, "error", details?.exception?.description ?? details?.text ?? "an exception");
        return;
      }
      case "Log.entryAdded": {
        const entry = params.entry as { level?: string; text?: string; url?: string } | undefined;
        if (entry?.level === "error") this.consoleLine(pane, "error", `${entry.text ?? ""}${entry.url ? ` (${entry.url})` : ""}`);
        return;
      }
    }
  }

  private consoleLine(pane: Pane, level: ConsoleLine["level"], text: string): void {
    if (level === "error") pane.errors += 1;
    const line = text.replace(/\s+/g, " ").trim();
    pane.console.push({ level, text: this.helpers ? this.helpers.clip(line, 500) : line.slice(0, 500) });
    if (pane.console.length > CONSOLE_KEEP) pane.console.splice(0, pane.console.length - CONSOLE_KEEP);
  }

  /**
   * The dialog policy (C1): during an agent's command, alert and beforeunload are accepted and confirm (and a
   * prompt) dismissed, with a note. Between commands, a dialog in a pane on screen is the human's; in a hidden
   * one it is answered the same way, so a room nobody looks at never blocks the window, and the next result says so.
   */
  private onDialog(pane: Pane, type: string, message: string): void {
    pane.dialog = { type, message };
    const answer = (when: string) =>
      void this.answerDialog(pane, when).then((failed) => {
        if (failed) this.note(pane, failed);
      });
    if (pane.running) answer("");
    else if (!this.onScreen(pane)) answer(" (the page raised it between commands, while its browser was hidden)");
  }

  /**
   * Accepts an alert or beforeunload, dismisses the rest, and notes it. Resolves null once answered, or with
   * why it could not be (the page stays blocked; the log says so, and the caller tells the agent).
   */
  private async answerDialog(pane: Pane, when: string): Promise<string | null> {
    const dialog = pane.dialog;
    if (!dialog) return null;
    pane.dialog = null;
    const accept = dialog.type === "alert" || dialog.type === "beforeunload";
    const quoted = JSON.stringify(this.helpers ? this.helpers.clip(dialog.message, 200) : dialog.message.slice(0, 200));
    let text =
      dialog.type === "beforeunload"
        ? "the page's beforeunload dialog was accepted, so the page was left"
        : `${dialog.type}(${quoted}) was ${accept ? "accepted" : "dismissed"}`;
    text += when;
    if (dialog.type === "confirm") text += `. ${CONFIRM_TAIL}`;
    // Noted now, while the command that raised it is still running.
    this.note(pane, text);
    try {
      await within(this.cdp(pane, "Page.handleJavaScriptDialog", { accept }), DIALOG_MS, () => new Error("no answer from the page"));
      return null;
    } catch (error) {
      const why = messageOf(error);
      // Someone (the human, or the page going away) closed it first.
      if (/no dialog is showing/i.test(why)) return null;
      this.log(`could not answer a ${dialog.type} dialog in room ${pane.room}: ${why}`);
      // The note said it was answered: it was not.
      for (const list of [pane.running?.notes ?? [], this.ledger(pane.room).pending]) {
        const at = list.lastIndexOf(text);
        if (at !== -1) list.splice(at, 1);
      }
      return `Agoryx could not answer the page's ${dialog.type} dialog (${why}); the page is blocked until it is answered in the Agoryx window`;
    }
  }

  private onScreen(pane: Pane): boolean {
    const win = this.win;
    return pane.shown && win !== null && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
  }

  /** A fact for the running command's result, or for the room's next one; `once` skips one already there. */
  private note(pane: Pane, text: string, once = false): void {
    const list = pane.running ? pane.running.notes : this.ledger(pane.room).pending;
    if (once && list.includes(text)) return;
    if (pane.running) {
      list.push(text);
      return;
    }
    const ledger = this.ledger(pane.room);
    ledger.pending.push(text);
    if (ledger.pending.length > KEEP_PENDING) ledger.pending.splice(0, ledger.pending.length - KEEP_PENDING);
  }

  private closePane(pane: Pane, reason: string | null): void {
    if (pane.closed) return;
    pane.closed = true;
    if (this.panes.get(pane.room) === pane) this.panes.delete(pane.room);
    pane.abort?.(new Error(reason ?? "The room's browser closed."));
    if (pane.driverTimer) clearTimeout(pane.driverTimer);
    const win = this.win;
    try {
      if (win && !win.isDestroyed()) win.contentView.removeChildView(pane.view);
    } catch {
      // the window is going away
    }
    try {
      if (!pane.contents.isDestroyed()) pane.contents.close();
    } catch {
      // already gone
    }
    // The UI has no "gone" message: an empty state clears the address and the driver line until it asks again.
    this.pushState(pane.room);
  }

  // -------------------------------------------------------------------------
  // Placement and the zoom
  // -------------------------------------------------------------------------

  /** The UI's rect (its CSS px) for the room's pane, or null: every pane hidden. */
  private place(room: unknown, rect: unknown): void {
    if (!isRoom(room)) return;
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    if (rect === null || !isRect(rect)) {
      this.placed = null;
      this.hideAll();
      return;
    }
    const zoom = win.webContents.getZoomFactor();
    const bounds: Rectangle = {
      x: Math.round(rect.x * zoom),
      y: Math.round(rect.y * zoom),
      width: Math.max(0, Math.round(rect.width * zoom)),
      height: Math.max(0, Math.round(rect.height * zoom)),
    };
    this.bounds.set(room, bounds);
    this.placed = room;
    for (const pane of this.panes.values()) {
      if (pane.room !== room) {
        this.show(pane, false);
        continue;
      }
      pane.view.setBounds(bounds);
      this.applyZoom(pane);
      this.show(pane, true);
    }
  }

  private hideAll(): void {
    for (const pane of this.panes.values()) this.show(pane, false);
  }

  /** The UI lost its layout: every pane hides, and a pane made later stays hidden until the UI places it again. */
  private unplace(): void {
    this.placed = null;
    this.hideAll();
  }

  private show(pane: Pane, visible: boolean): void {
    if (pane.closed) return;
    pane.shown = visible;
    pane.view.setVisible(visible);
  }

  /** 1280 CSS px scaled into the pane. Zoom is per host, so it is set again on each navigation and command. */
  /**
   * A view made hidden before it ever drew, and each new renderer after a cross-site navigation, stays hidden:
   * CDP input is dropped and capturePage fails. Electron's setBackgroundThrottling(false) draws the page again
   * without showing the view; the page itself still reads document.visibilityState "hidden".
   */
  private wake(pane: Pane): void {
    if (pane.closed || pane.contents.isDestroyed()) return;
    pane.contents.setBackgroundThrottling(false);
  }

  private applyZoom(pane: Pane): void {
    if (pane.closed || pane.contents.isDestroyed()) return;
    const width = (this.bounds.get(pane.room) ?? DEFAULT_BOUNDS).width;
    const factor = Math.max(0.25, Math.min(1, width / LAYOUT_WIDTH));
    if (Math.abs(pane.contents.getZoomFactor() - factor) > 0.001) pane.contents.setZoomFactor(factor);
  }

  // -------------------------------------------------------------------------
  // The UI: state, and the human's own navigation
  // -------------------------------------------------------------------------

  private stateOf(pane: Pane): BrowserPaneState {
    const { contents } = pane;
    if (pane.closed || contents.isDestroyed()) return this.emptyState(pane.room);
    return {
      room: pane.room,
      url: contents.getURL() || null,
      title: contents.getTitle(),
      loading: contents.isLoading(),
      // A crashed page's history is not walked: “Reload” or an address gives a fresh page.
      canGoBack: !pane.crashed && contents.navigationHistory.canGoBack(),
      canGoForward: !pane.crashed && contents.navigationHistory.canGoForward(),
      crashed: pane.crashed !== null,
      driver: pane.driver,
    };
  }

  private emptyState(room: string): BrowserPaneState {
    return { room, url: null, title: "", loading: false, canGoBack: false, canGoForward: false, crashed: false, driver: null };
  }

  /** At most one push per room every 100 ms, and always the latest state. */
  private pushState(room: string): void {
    let entry = this.pushes.get(room);
    if (!entry) {
      entry = { at: 0, timer: null };
      this.pushes.set(room, entry);
    }
    if (entry.timer) return;
    const wait = entry.at + PUSH_MS - Date.now();
    const send = (slot: { at: number; timer: NodeJS.Timeout | null }) => {
      slot.timer = null;
      slot.at = Date.now();
      const win = this.win;
      if (!win || win.isDestroyed()) return;
      const pane = this.panes.get(room);
      win.webContents.send("agoryx:browser:state", pane ? this.stateOf(pane) : this.emptyState(room));
    };
    if (wait <= 0) {
      send(entry);
      return;
    }
    const slot = entry;
    slot.timer = setTimeout(() => send(slot), wait);
  }

  private refuseUntrusted(event: IpcMainInvokeEvent): void {
    if (!this.options.trustedUi(event)) throw new Error("Only the Agoryx window can control the room’s browser.");
  }

  /** The human's address bar and buttons: the same URL policy; a crashed pane is replaced by a fresh one. */
  private async go(room: string, target: string): Promise<{ ok: true } | { error: UrlError }> {
    const helpers = await this.load();
    if (!helpers) throw new Error("The room’s browser is not available: this copy of Agoryx does not include it.");
    const history = target === "back" || target === "forward" || target === "reload";
    let address: string | null = null;
    if (!history) {
      const checked = helpers.paneUrl(target, this.blocked);
      if ("error" in checked) return { error: checked.error };
      address = checked.url;
    }
    const ledger = this.ledger(room);
    let pane = this.panes.get(room);
    // Opening a page (an address, or a fresh page for a crashed one) needs the room's network on, as for agents.
    if (address || (target === "reload" && pane?.crashed)) {
      const generation = this.generations.get(room) ?? 0;
      const network = await this.networkOn(room);
      if (network === null) throw new Error(NO_DAEMON_ANSWER);
      // The network may have gone off (the host stream's `close`) while the daemon answered.
      if (!network || (this.generations.get(room) ?? 0) !== generation) throw new Error(HUMAN_NETWORK_OFF);
    }
    pane = this.panes.get(room);
    if (pane?.crashed && (target === "reload" || address)) {
      const reason = pane.crashed;
      address ??= pane.lastUrl ?? "about:blank";
      this.closePane(pane, null);
      pane = undefined;
      ledger.pending.push(`the page crashed (${reason}); the human opened a fresh page`);
    }
    if (history && !address) {
      if (!pane || pane.closed || pane.crashed) return { ok: true };
      await pane.ready.catch(() => {});
      const { contents } = pane;
      if (contents.isDestroyed()) return { ok: true };
      ledger.humanAt = Date.now();
      if (target === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
      else if (target === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
      else if (target === "reload") contents.reload();
      return { ok: true };
    }
    const opened = await this.openPane(room, helpers);
    ledger.humanAt = Date.now();
    opened.contents.loadURL(address ?? "about:blank").catch(() => {});
    return { ok: true };
  }

  /**
   * Asks the daemon whether the room's network is on. The pane only hears when it goes off (the host stream's
   * `close`), so the human's address bar checks each time it would open a page. No answer (null): refused too.
   */
  private async networkOn(room: string): Promise<boolean | null> {
    const target = this.target;
    if (!target) return null;
    try {
      const res = await fetch(new URL(`/api/rooms/${encodeURIComponent(room)}`, target.url), {
        headers: { "x-agoryx-token": target.token },
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return null;
      const snap = (await res.json()) as { state?: { settings?: { network?: unknown } } };
      const network = snap.state?.settings?.network;
      return typeof network === "boolean" ? network : null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Agents' commands
  // -------------------------------------------------------------------------

  /** One command at a time per room, in arrival order; rooms run in parallel. Never rejects. */
  private handle(command: BrowserCommandWire): Promise<BrowserAnswer> {
    const room = command.room;
    const previous = this.chains.get(room) ?? Promise.resolve();
    const generation = this.generations.get(room) ?? 0;
    this.inChain.add(command.id);
    const run = previous
      .then(() => this.run(command, generation))
      .finally(() => {
        this.inChain.delete(command.id);
        this.withdrawn.delete(command.id);
      });
    const tail = run.then(
      () => {},
      () => {},
    );
    this.chains.set(room, tail);
    void tail.then(() => {
      if (this.chains.get(room) === tail) this.chains.delete(room);
    });
    return run;
  }

  private async run(command: BrowserCommandWire, generation: number): Promise<BrowserAnswer> {
    // The relay has already answered 504; nothing is done in the page.
    if (Date.now() >= command.deadline) return { ok: false, error: PAST_DEADLINE };
    // The relay has already answered the agent (409 or 499) and told the app; a command that has started runs on.
    if (this.withdrawn.has(command.id)) return { ok: false, error: WITHDRAWN };
    if (this.stopped) return { ok: false, error: WINDOW_CLOSED };
    const helpers = await this.load();
    if (!helpers) return { ok: false, error: "The Agoryx app could not load its browser." };
    if (!isRoom(command.room)) return { ok: false, error: "The command names no room." };
    // The relay has already refused it (403): the room's network went off while it waited its turn.
    if ((this.generations.get(command.room) ?? 0) !== generation) return { ok: false, error: NETWORK_OFF };
    const notes: string[] = [];
    let pane: Pane;
    try {
      const current = this.panes.get(command.room);
      if (current?.crashed) {
        const reason = current.crashed;
        this.closePane(current, null);
        notes.push(`the page crashed (${reason}); this is a fresh, empty page`);
      }
      pane = await this.openPane(command.room, helpers);
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }

    const ledger = this.ledger(command.room);
    const me = command.agent;
    pane.running = { command, notes };
    if (pane.driverTimer) clearTimeout(pane.driverTimer);
    pane.driverTimer = null;
    pane.driver = { agent: me, label: command.label, op: command.op, at: Date.now() };
    this.pushState(command.room);
    const aborted = new Promise<never>((_resolve, reject) => {
      pane.abort = reject;
    });
    aborted.catch(() => {});
    let answer: BrowserAnswer;
    try {
      this.wake(pane);
      this.applyZoom(pane);
      const done = await Promise.race([this.perform(pane, command, helpers), aborted]);
      const viewport = await Promise.race([this.viewport(pane), aborted]);
      const result: BrowserResult = { url: pane.contents.getURL(), title: pane.contents.getTitle(), viewport };
      if (done.text) result.text = done.text;
      if (done.image) result.image = { data: done.image, mimeType: "image/png" };
      const all = this.notesFor(pane, ledger, command, helpers);
      if (all.length) result.notes = all;
      answer = { ok: true, result };
    } catch (error) {
      const own = pane.running?.notes ?? [];
      const text = messageOf(error) || `The ${command.op} failed.`;
      answer = { ok: false, error: own.length ? `${text}\nNotes:\n${own.map((note) => `- ${note}`).join("\n")}` : text };
    } finally {
      pane.running = null;
      pane.abort = null;
      void this.cdp(pane, "Runtime.releaseObjectGroup", { objectGroup: "agoryx" }).catch(() => {});
      ledger.seq += 1;
      ledger.steps.push({ seq: ledger.seq, agent: me, label: command.label, step: helpers.browserStep(command.op, command.args) });
      if (ledger.steps.length > KEEP_STEPS) ledger.steps.splice(0, ledger.steps.length - KEEP_STEPS);
      ledger.seen.set(me, ledger.seq);
      ledger.lastAt.set(me, Date.now());
      pane.driverTimer = setTimeout(() => {
        pane.driverTimer = null;
        pane.driver = null;
        this.pushState(pane.room);
      }, DRIVER_LINGER_MS);
      this.pushState(command.room);
    }
    return answer;
  }

  /** The notes of one result: what others and the human did since this agent's last command, events, errors. */
  private notesFor(pane: Pane, ledger: Ledger, command: BrowserCommandWire, helpers: Helpers): string[] {
    const me = command.agent;
    const notes: string[] = [];
    const since = ledger.seen.get(me) ?? 0;
    const others = new Map<string, { label: string; steps: string[] }>();
    for (const step of ledger.steps) {
      if (step.seq <= since || step.agent === me) continue;
      const entry = others.get(step.agent) ?? { label: step.label, steps: [] };
      entry.steps.push(step.step);
      others.set(step.agent, entry);
    }
    for (const { label, steps } of others.values()) {
      const shown = steps.slice(0, OTHER_STEPS).join(", ");
      const more = steps.length > OTHER_STEPS ? ` and ${steps.length - OTHER_STEPS} more` : "";
      notes.push(`${label} used this browser since your last command: ${shown}${more}`);
    }
    if (ledger.humanAt > (ledger.lastAt.get(me) ?? 0)) notes.push("the human used this browser since your last command");
    notes.push(...ledger.pending.splice(0), ...(pane.running?.notes ?? []));
    const fresh = pane.errors - (pane.errorsSeen.get(me) ?? 0);
    pane.errorsSeen.set(me, pane.errors);
    // A snapshot lists them itself.
    if (fresh > 0 && command.op !== "snapshot") notes.push(`${fresh} new console error${fresh === 1 ? "" : "s"} (browser_snapshot lists them)`);
    return notes.map((note) => helpers.clip(note, 2_000));
  }

  private cdp<T = Record<string, unknown>>(pane: Pane, method: string, params?: Record<string, unknown>): Promise<T> {
    if (pane.contents.isDestroyed()) return Promise.reject(new Error("The room's browser closed."));
    return pane.contents.debugger.sendCommand(method, params) as Promise<T>;
  }

  /** The CSS viewport, as the page lays it out (never the pane's bounds). */
  private async viewport(pane: Pane): Promise<{ width: number; height: number }> {
    try {
      const metrics = await within(
        this.cdp<{ cssVisualViewport: { clientWidth: number; clientHeight: number } }>(pane, "Page.getLayoutMetrics"),
        3_000,
        () => new Error("no layout metrics"),
      );
      return { width: Math.round(metrics.cssVisualViewport.clientWidth), height: Math.round(metrics.cssVisualViewport.clientHeight) };
    } catch {
      const bounds = this.bounds.get(pane.room) ?? DEFAULT_BOUNDS;
      const zoom = pane.contents.isDestroyed() ? 1 : pane.contents.getZoomFactor();
      return { width: Math.round(bounds.width / zoom), height: Math.round(bounds.height / zoom) };
    }
  }

  private async perform(pane: Pane, command: BrowserCommandWire, helpers: Helpers): Promise<{ text?: string; image?: string }> {
    const left = () => command.deadline - Date.now();
    const budget = (ms: number) => Math.max(0, Math.min(ms, left()));
    const act = <T>(work: Promise<T>, ms = ACT_MS) => within(work, budget(ms), () => new Error(tookTooLong(command.op, ms)));
    const notes = pane.running?.notes ?? [];
    const args = command.args;
    // A dialog the human has not answered blocks the page: waiting on it would only time out. Once its pane is
    // hidden, it is no longer in front of the human, and it is answered as during a command.
    if (pane.dialog && this.onScreen(pane)) {
      throw new Error(`The page shows a ${pane.dialog.type} dialog that the human has not answered yet; the page is blocked until then.`);
    }
    if (pane.dialog) {
      const failed = await this.answerDialog(pane, " (the page raised it before this command, and its browser is hidden now)");
      if (failed) throw new Error(`${failed[0].toUpperCase()}${failed.slice(1)}.`);
    }
    switch (command.op) {
      case "navigate":
        return { text: await this.navigate(pane, args, helpers, budget, notes) };
      case "snapshot":
        return { text: await this.snapshot(pane, args, helpers, budget, act, notes) };
      case "click": {
        const text = await act(this.click(pane, args, helpers, notes));
        await this.settle(pane, NAV_START_MS, budget(LOAD_MS), notes);
        return { text };
      }
      case "type": {
        const text = await act(this.type(pane, args, helpers));
        if (args.submit === true) await this.settle(pane, NAV_START_MS, budget(LOAD_MS), notes);
        return { text };
      }
      case "press": {
        const text = await act(this.press(pane, args, helpers));
        await this.settle(pane, NAV_START_MS, budget(LOAD_MS), notes);
        return { text };
      }
      case "screenshot":
        return await act(this.screenshot(pane, args));
      case "eval":
        return { text: await act(this.evaluate(pane, args, helpers), EVAL_MS) };
    }
    throw new Error(`Unknown op ${String(command.op)}.`);
  }

  /** Waits for a load in progress, or one that starts within `startMs`; a note when it is not done in `loadMs`. */
  private async settle(pane: Pane, startMs: number, loadMs: number, notes: string[]): Promise<void> {
    const { contents } = pane;
    if (contents.isDestroyed()) return;
    if (!contents.isLoading() && !(await onceWithin(contents, "did-start-loading", startMs))) return;
    if (contents.isDestroyed() || !contents.isLoading()) return;
    if (!(await onceWithin(contents, "did-stop-loading", loadMs))) notes.push(`still loading after ${Math.round(LOAD_MS / 1000)} s`);
  }

  private async navigate(
    pane: Pane,
    args: Record<string, unknown>,
    helpers: Helpers,
    budget: (ms: number) => number,
    notes: string[],
  ): Promise<string | undefined> {
    const { contents } = pane;
    const history = contents.navigationHistory;
    if (typeof args.go === "string") {
      if (args.go === "back") {
        if (!history.canGoBack()) throw new Error("There is no page to go back to.");
        history.goBack();
      } else if (args.go === "forward") {
        if (!history.canGoForward()) throw new Error("There is no page to go forward to.");
        history.goForward();
      } else {
        contents.reload();
      }
    } else {
      const given = String(args.url ?? "");
      const checked = helpers.paneUrl(given, this.blocked);
      if ("error" in checked) throw new Error(`Could not open ${helpers.clip(given, 300)}: ${helpers.URL_ERROR_TEXT[checked.error]}.`);
      const reply = await within(
        this.cdp<{ errorText?: string }>(pane, "Page.navigate", { url: checked.url }),
        budget(LOAD_MS),
        () => new Error(tookTooLong("navigate", LOAD_MS)),
      );
      // ERR_ABORTED: a beforeunload guard or a redirect; the load goes on.
      if (reply.errorText && reply.errorText !== "net::ERR_ABORTED") throw new Error(`Could not load ${checked.url}: ${reply.errorText}`);
    }
    const before = notes.length;
    await this.settle(pane, NAV_START_MS, budget(LOAD_MS), notes);
    return notes.length > before ? undefined : "Loaded.";
  }

  private async snapshot(
    pane: Pane,
    args: Record<string, unknown>,
    helpers: Helpers,
    budget: (ms: number) => number,
    act: <T>(work: Promise<T>, ms?: number) => Promise<T>,
    notes: string[],
  ): Promise<string> {
    if (typeof args.waitForText === "string" && args.waitForText) {
      const wanted = args.waitForText;
      const ms = typeof args.timeoutMs === "number" ? Math.max(0, Math.min(args.timeoutMs, WAIT_TEXT_MAX_MS)) : WAIT_TEXT_MS;
      const until = Date.now() + budget(ms);
      const expression = `document.body ? document.body.innerText.includes(${JSON.stringify(wanted)}) : false`;
      let found = false;
      for (;;) {
        try {
          const reply = await within(this.cdp<{ result: { value?: unknown } }>(pane, "Runtime.evaluate", { expression, returnByValue: true }), 2_000, () => new Error("busy"));
          found = reply.result.value === true;
        } catch {
          // the page is busy or between documents: poll again
        }
        if (found || Date.now() + POLL_MS > until) break;
        await sleep(POLL_MS);
      }
      if (!found) notes.push(`the text ${JSON.stringify(helpers.clip(wanted, 200))} was not on the page after ${ms / 1000} s`);
    }
    const tree = await act(this.cdp<{ nodes: unknown[] }>(pane, "Accessibility.getFullAXTree", {}));
    let text = helpers.formatSnapshot(tree.nodes, pane.refs);
    const lines = pane.console.slice(-CONSOLE_SHOW);
    if (lines.length) text += `\n\nConsole (latest errors and warnings):\n${lines.map((line) => `- ${line.level}: ${line.text}`).join("\n")}`;
    return text;
  }

  /** The node behind a ref, as a live element; a ref from an older document, or a removed node, fails. */
  private async element(pane: Pane, ref: string): Promise<{ id: number; objectId: string; tag: string; type: string }> {
    const id = pane.refs.node(ref);
    if (id === undefined) throw new Error(staleRef(ref));
    try {
      const { object } = await this.cdp<{ object: { objectId: string } }>(pane, "DOM.resolveNode", { backendNodeId: id, objectGroup: "agoryx" });
      const kind = await this.callOn<{ tag: string; type: string; connected: boolean }>(pane, object.objectId, KIND_FN);
      if (!kind.connected) throw new Error("detached");
      return { id, objectId: object.objectId, tag: kind.tag, type: kind.type };
    } catch {
      throw new Error(staleRef(ref));
    }
  }

  private async callOn<T>(pane: Pane, objectId: string, fn: string, args: unknown[] = []): Promise<T> {
    const reply = await this.cdp<{ result: { value?: unknown }; exceptionDetails?: { text?: string } }>(pane, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: fn,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    });
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.text ?? "the page threw");
    return reply.result.value as T;
  }

  /** `role "name"` of a node, as the outline shows it, or its tag. */
  private async describe(pane: Pane, backendNodeId: number, helpers: Helpers): Promise<string> {
    try {
      const { nodes } = await this.cdp<{ nodes: { backendDOMNodeId?: number; role?: { value?: unknown }; name?: { value?: unknown } }[] }>(
        pane,
        "Accessibility.getPartialAXTree",
        { backendNodeId, fetchRelatives: false },
      );
      const node = nodes.find((candidate) => candidate.backendDOMNodeId === backendNodeId) ?? nodes[0];
      const role = typeof node?.role?.value === "string" ? node.role.value : "";
      const name = typeof node?.name?.value === "string" ? node.name.value.trim() : "";
      // A role that says nothing (a <span>'s "generic") gives way to the tag.
      const plain = role && !BLAND_ROLES.has(role) ? role : "";
      if (plain) return name ? `${plain} ${JSON.stringify(helpers.clip(name, 80))}` : plain;
      if (name) return `${await this.tagOf(pane, backendNodeId)} ${JSON.stringify(helpers.clip(name, 80))}`;
    } catch {
      // not in the accessibility tree
    }
    return this.tagOf(pane, backendNodeId);
  }

  private async tagOf(pane: Pane, backendNodeId: number): Promise<string> {
    try {
      const { node } = await this.cdp<{ node: { localName?: string; nodeName?: string } }>(pane, "DOM.describeNode", { backendNodeId });
      return node.localName || node.nodeName?.toLowerCase() || "element";
    } catch {
      return "element";
    }
  }

  /** Why an element is not clicked (its native picker would open over the human's screen), or null. */
  private pickerRefusal(who: string, tag: string, type: string): string | null {
    if (tag === "select") return `${who} is a <select>, so it was not clicked; choose with browser_type and the option's label.`;
    if (tag === "input" && type === "file") return `${who} is a file input, so it was not clicked; file upload is not supported.`;
    if (tag === "input" && PICKERS.has(type)) return `${who} is a ${type} input, so it was not clicked; set its value with browser_eval.`;
    return null;
  }

  private async click(pane: Pane, args: Record<string, unknown>, helpers: Helpers, notes: string[]): Promise<string> {
    const ref = typeof args.ref === "string" ? args.ref : null;
    const viewport = await this.viewport(pane);
    let point: { x: number; y: number };
    let target: { id: number; objectId: string } | null = null;
    if (ref) {
      const element = await this.element(pane, ref);
      const refusal = this.pickerRefusal(ref, element.tag, element.type);
      if (refusal) return refusal;
      target = element;
      await this.cdp(pane, "DOM.scrollIntoViewIfNeeded", { backendNodeId: element.id }).catch(() => {});
      let quads: number[][] = [];
      try {
        ({ quads } = await this.cdp<{ quads: number[][] }>(pane, "DOM.getContentQuads", { backendNodeId: element.id }));
      } catch {
        // not rendered
      }
      const box = quads.map(boxOf).find((candidate) => candidate.right > 0 && candidate.bottom > 0 && candidate.left < viewport.width && candidate.top < viewport.height);
      if (!box) throw new Error(`${ref} has no box in the viewport (it is hidden or not rendered), so it was not clicked.`);
      const left = Math.max(0, box.left);
      const top = Math.max(0, box.top);
      const right = Math.min(viewport.width, box.right);
      const bottom = Math.min(viewport.height, box.bottom);
      point = { x: (left + right) / 2, y: (top + bottom) / 2 };
    } else {
      point = { x: Number(args.x), y: Number(args.y) };
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("A click needs a ref, or both x and y.");
      if (point.x < 0 || point.y < 0 || point.x >= viewport.width || point.y >= viewport.height) {
        throw new Error(`${point.x},${point.y} is outside the viewport (${viewport.width}×${viewport.height} CSS px), so nothing was clicked.`);
      }
    }
    let hit: number | null = null;
    try {
      const found = await this.cdp<{ backendNodeId: number }>(pane, "DOM.getNodeForLocation", {
        x: Math.round(point.x),
        y: Math.round(point.y),
        includeUserAgentShadowDOM: false,
        ignorePointerEventsNone: true,
      });
      hit = found.backendNodeId;
    } catch {
      // nothing there (a blank area of the page)
    }
    const where = `${Math.round(point.x)},${Math.round(point.y)}`;
    if (!ref && hit !== null) {
      const { object } = await this.cdp<{ object: { objectId: string } }>(pane, "DOM.resolveNode", { backendNodeId: hit, objectGroup: "agoryx" });
      const kind = await this.callOn<{ tag: string; type: string }>(pane, object.objectId, KIND_FN);
      const refusal = this.pickerRefusal(`the element at ${where}`, kind.tag, kind.type);
      if (refusal) return refusal;
    }
    if (ref && target && hit !== null && hit !== target.id) {
      const { object } = await this.cdp<{ object: { objectId: string } }>(pane, "DOM.resolveNode", { backendNodeId: hit, objectGroup: "agoryx" });
      const reply = await this.cdp<{ result: { value?: unknown } }>(pane, "Runtime.callFunctionOn", {
        objectId: target.objectId,
        functionDeclaration: CONTAINS_FN,
        arguments: [{ objectId: object.objectId }],
        returnByValue: true,
      }).catch(() => null);
      if (reply && reply.result.value !== true) notes.push(`the click landed on ${await this.describe(pane, hit, helpers)}; something covers ${ref}`);
    }
    const mouse = { x: point.x, y: point.y, button: "left", clickCount: 1 };
    await this.cdp(pane, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await this.cdp(pane, "Input.dispatchMouseEvent", { type: "mousePressed", buttons: 1, ...mouse });
    await this.cdp(pane, "Input.dispatchMouseEvent", { type: "mouseReleased", buttons: 0, ...mouse });
    if (ref && target) return `Clicked ${ref} (${await this.describe(pane, target.id, helpers)}).`;
    return `Clicked at ${where}${hit !== null ? ` (${await this.describe(pane, hit, helpers)})` : ""}.`;
  }

  private async type(pane: Pane, args: Record<string, unknown>, helpers: Helpers): Promise<string> {
    const ref = String(args.ref ?? "");
    const text = String(args.text ?? "");
    const element = await this.element(pane, ref);
    if (element.tag === "select") {
      const chosen = await this.callOn<{ chosen?: string; labels?: string[]; count?: number }>(pane, element.objectId, CHOOSE_FN, [text]);
      if (typeof chosen.chosen === "string") return `Selected ${JSON.stringify(chosen.chosen)} in ${ref}.`;
      const labels = (chosen.labels ?? []).map((label) => JSON.stringify(helpers.clip(label, 80)));
      const more = (chosen.count ?? 0) > labels.length ? `, and ${(chosen.count ?? 0) - labels.length} more` : "";
      throw new Error(
        `${JSON.stringify(helpers.clip(text, 200))} is not an option in ${ref}. Its options: ${labels.length ? labels.join(", ") : "none"}${more}.`,
      );
    }
    await this.cdp(pane, "DOM.scrollIntoViewIfNeeded", { backendNodeId: element.id }).catch(() => {});
    try {
      await this.cdp(pane, "DOM.focus", { backendNodeId: element.id });
    } catch {
      throw new Error(`${ref} cannot take text (it cannot be focused).`);
    }
    if (args.clear !== false) {
      const selected = await this.callOn<boolean>(pane, element.objectId, SELECT_ALL_FN).catch(() => false);
      if (selected && !text) await this.keys(pane, helpers, "Backspace");
    }
    if (text) await this.cdp(pane, "Input.insertText", { text });
    if (args.submit === true) await this.keys(pane, helpers, "Enter");
    const count = [...text].length;
    return `Typed ${count} character${count === 1 ? "" : "s"} into ${ref}.`;
  }

  private async keys(pane: Pane, helpers: Helpers, spec: string): Promise<void> {
    const strokes = helpers.keyEvents(spec);
    if (!Array.isArray(strokes)) throw new Error(strokes.error);
    for (const stroke of strokes) await this.cdp(pane, "Input.dispatchKeyEvent", { ...stroke });
  }

  private async press(pane: Pane, args: Record<string, unknown>, helpers: Helpers): Promise<string> {
    const key = String(args.key ?? "").trim();
    await this.keys(pane, helpers, key);
    return `Pressed ${key}.`;
  }

  /**
   * capturePage keeps working while the pane is hidden (a CDP screenshot does not); image pixels are CSS px.
   * While the window is minimized nothing is drawn, and a capture would only time out.
   */
  private async screenshot(pane: Pane, args: Record<string, unknown>): Promise<{ text: string; image: string }> {
    const win = this.win;
    if (!win || win.isDestroyed() || win.isMinimized() || !win.isVisible()) {
      throw new Error("The Agoryx window is minimized or hidden, so the page is not drawn and cannot be captured now; browser_snapshot still works.");
    }
    const viewport = await this.viewport(pane);
    const zoom = pane.contents.getZoomFactor();
    const ref = typeof args.ref === "string" ? args.ref : null;
    // The client area only: the whole view also holds the scrollbars, and squeezed into the CSS size, its pixels
    // would no longer be click coordinates.
    let crop: Rectangle = { x: 0, y: 0, width: Math.round(viewport.width * zoom), height: Math.round(viewport.height * zoom) };
    let size = { width: viewport.width, height: viewport.height };
    if (ref) {
      const element = await this.element(pane, ref);
      await this.cdp(pane, "DOM.scrollIntoViewIfNeeded", { backendNodeId: element.id }).catch(() => {});
      let border: number[] = [];
      try {
        ({ model: { border } } = await this.cdp<{ model: { border: number[] } }>(pane, "DOM.getBoxModel", { backendNodeId: element.id }));
      } catch {
        // not rendered
      }
      const box = border.length === 8 ? boxOf(border) : null;
      const left = Math.max(0, box?.left ?? 0);
      const top = Math.max(0, box?.top ?? 0);
      const right = Math.min(viewport.width, box?.right ?? 0);
      const bottom = Math.min(viewport.height, box?.bottom ?? 0);
      if (!box || right - left < 1 || bottom - top < 1) throw new Error(`${ref} has no box in the viewport (it is hidden or not rendered).`);
      size = { width: Math.round(right - left), height: Math.round(bottom - top) };
      crop = { x: Math.floor(left * zoom), y: Math.floor(top * zoom), width: Math.ceil((right - left) * zoom), height: Math.ceil((bottom - top) * zoom) };
    }
    const captured = await pane.contents.capturePage(crop, { stayHidden: true });
    if (captured.isEmpty()) throw new Error("The page could not be captured (it has not been drawn yet).");
    const png = captured.resize({ width: size.width, height: size.height, quality: "best" }).toPNG();
    const what = ref ? ref : "the viewport";
    return { text: `Screenshot of ${what} (${size.width}×${size.height} CSS px).`, image: png.toString("base64") };
  }

  private async evaluate(pane: Pane, args: Record<string, unknown>, helpers: Helpers): Promise<string> {
    const reply = await this.cdp<{
      result: { type: string; value?: unknown; unserializableValue?: string; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(pane, "Runtime.evaluate", {
      expression: String(args.expression ?? ""),
      awaitPromise: true,
      returnByValue: true,
      // No userGesture: with one, the page could write to the human's clipboard (execCommand("copy")) or open a
      // native picker over the window. window.open still loads in the same pane without it.
    });
    if (reply.exceptionDetails) {
      const details = reply.exceptionDetails;
      throw new Error(helpers.clip(details.exception?.description ?? details.text ?? "The expression threw.", 4_000));
    }
    const { result } = reply;
    if (result.type === "undefined") return "undefined";
    if (result.unserializableValue !== undefined) return result.unserializableValue;
    const json = JSON.stringify(result.value);
    return helpers.clip(json ?? "undefined", EVAL_CHARS);
  }
}

/** The bounding box of a CDP quad (x1,y1 … x4,y4). */
const boxOf = (quad: number[]): { left: number; top: number; right: number; bottom: number } => {
  const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
  const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};
