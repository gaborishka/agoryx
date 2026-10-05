import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, session, shell } from "electron";
import type { BrowserWindowConstructorOptions, IpcMainEvent, IpcMainInvokeEvent, Rectangle, WebContents, WebPreferences } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAttention, type AttentionCore } from "./attention.js";
import { BrowserPanes } from "./browserpane.js";

/**
 * Agoryx for macOS: one window over the local daemon.
 *
 * The app owns no rooms and runs no agents. It reads the environment a terminal would have, checks the
 * tools, starts (or finds) the same daemon `agoryx up` would, and shows that daemon's UI. The daemon runs
 * detached under the user's own node, so quitting the app leaves running turns alone.
 *
 * The core is loaded from the Agoryx install at runtime (dist/internal/desktop), never imported
 * statically, and nothing it loads reaches better-sqlite3: that is built for the user's node, not Electron's.
 */

// ---------------------------------------------------------------------------
// The core's API, as far as the app uses it (internal/desktop, see docs/archive/plans/2026-09-29-macos-desktop-shell.md)
// ---------------------------------------------------------------------------

type CheckStatus = "ok" | "warn" | "fail";

interface DoctorCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** A command or a one-line hint. */
  fix?: string;
}

interface DaemonInfo {
  pid: number;
  port: number;
  url: string;
  token: string;
  startedAt: string;
}

interface SupervisorFailure {
  message: string;
  /** The last lines of daemon.log. */
  logTail: string;
}

/** What start() rejects with when the daemon does not come up (DaemonStartError). */
interface StartError extends Error {
  reason?: string;
  logPath?: string;
  logTail?: string;
}

interface Supervisor {
  start(): Promise<DaemonInfo>;
  watch(): void;
  /** Stops the daemon and starts a new one; rejects when stop() is called meanwhile. */
  restart(): Promise<DaemonInfo | null>;
  stop(): Promise<void>;
  /** Resolves once a start under way has ended. */
  dispose(): Promise<void>;
  logPath(): string;
  logTail(lines?: number): string;
  on(event: "down", listener: () => void): unknown;
  on(event: "up" | "changed", listener: (info: DaemonInfo) => void): unknown;
  on(event: "failed", listener: (failure: SupervisorFailure) => void): unknown;
  removeAllListeners(): unknown;
}

interface DesktopCore extends AttentionCore {
  desktopEnv(base?: NodeJS.ProcessEnv): Promise<{ env: NodeJS.ProcessEnv; source: "login-shell" | "fallback" }>;
  findExecutable(name: string, env: NodeJS.ProcessEnv): string | null;
  runDoctor(options: { env: NodeJS.ProcessEnv; root: string; probe?: boolean }): Promise<DoctorCheck[]>;
  doctorVerdict(checks: DoctorCheck[]): CheckStatus;
  DaemonSupervisor: new (options: {
    root: string;
    node: string;
    env: NodeJS.ProcessEnv;
    log?: (message: string) => void;
  }) => Supervisor;
}

interface AgoraPaths {
  agoraHome(env?: NodeJS.ProcessEnv): string;
}

// ---------------------------------------------------------------------------
// Where things are
// ---------------------------------------------------------------------------

/** desktop/dist (inside app.asar when packaged). */
const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = resolve(HERE, "..");
const START_PAGE = join(DESKTOP_DIR, "static", "start.html");
const START_URL = pathToFileURL(START_PAGE).href;
const PRELOAD = join(HERE, "preload.cjs");
const DEV_ICON = join(DESKTOP_DIR, "build", "icon.png");

/** The Agoryx install the app runs: AGORYX_ROOT, else the copy inside the app, else (dev) this repo. */
const agoryxRoot = (): string => {
  const override = process.env.AGORYX_ROOT?.trim();
  if (override) return resolve(override);
  if (app.isPackaged) return join(process.resourcesPath, "agoryx");
  return resolve(DESKTOP_DIR, "..");
};

const coreEntry = (root: string): string => join(root, "dist", "internal", "desktop", "index.js");

const loadCore = async (root: string): Promise<{ core: DesktopCore; paths: AgoraPaths }> => {
  const core = (await import(pathToFileURL(coreEntry(root)).href)) as DesktopCore;
  const paths = (await import(pathToFileURL(join(root, "dist", "internal", "agora", "paths.js")).href)) as AgoraPaths;
  return { core, paths };
};

const coreVersion = (): string => {
  try {
    const parsed = JSON.parse(readFileSync(join(agoryxRoot(), "package.json"), "utf8")) as { version?: string };
    return parsed.version ?? app.getVersion();
  } catch {
    return app.getVersion();
  }
};

// ---------------------------------------------------------------------------
// The daemon's environment
// ---------------------------------------------------------------------------

/**
 * What the launching process sets that the login shell must not override: which Agoryx home and
 * workspace root (a terminal's `AGORYX_HOME=… agoryx up` wins over the rc files the same way).
 * A Finder launch sets neither.
 */
const LAUNCH_WINS = ["AGORYX_HOME", "AGORYX_WORKSPACES"];

/**
 * The app's own environment as the base for the shell probe: without what Electron and an npm script
 * add (`npm run desktop`), which a terminal `agoryx up` would not have.
 */
const appEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const fromNpm = Boolean(env.npm_lifecycle_event);
  for (const key of Object.keys(env)) {
    if (key.startsWith("ELECTRON_") || key.startsWith("npm_") || key === "INIT_CWD") delete env[key];
  }
  if (fromNpm && env.PATH) {
    env.PATH = env.PATH.split(delimiter)
      .filter((dir) => !dir.includes("/node_modules/"))
      .join(delimiter);
  }
  return env;
};

const readEnv = async (core: DesktopCore): Promise<{ env: NodeJS.ProcessEnv; source: "login-shell" | "fallback" }> => {
  const { env, source } = await core.desktopEnv(appEnv());
  for (const key of LAUNCH_WINS) {
    const value = process.env[key]?.trim();
    if (value) env[key] = value;
  }
  // The daemon must run as node, never as Electron (its agent shim execs the daemon's own binary).
  delete env.ELECTRON_RUN_AS_NODE;
  return { env, source };
};

// ---------------------------------------------------------------------------
// What the app remembers (userData): the window's bounds and the warnings the user chose to open with
// ---------------------------------------------------------------------------

const userFile = (name: string): string => join(app.getPath("userData"), name);

const readJson = (file: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const writeJson = (file: string, value: unknown): void => {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  } catch {
    // Remembering is a convenience; the app works without it.
  }
};

/** The warnings as the check list shows them: the screen comes back only when one of these changes. */
const warningsKey = (checks: DoctorCheck[]): string =>
  checks
    .filter((check) => check.status !== "ok")
    .map((check) => `${check.id}:${check.status}:${check.fix ?? ""}`)
    .join("\n");

const acceptedWarnings = (): string | null => {
  const value = readJson(userFile("desktop.json")).acceptedWarnings;
  return typeof value === "string" ? value : null;
};

const acceptWarnings = (key: string): void => {
  writeJson(userFile("desktop.json"), { ...readJson(userFile("desktop.json")), acceptedWarnings: key });
};

const DEFAULT_SIZE = { width: 1280, height: 860 };
const MIN_SIZE = { width: 900, height: 600 };

interface SavedBounds extends Partial<Rectangle> {
  width: number;
  height: number;
  maximized?: boolean;
}

/** A window whose title bar is on some screen (a display may have gone since). */
const onScreen = (rect: Rectangle): boolean =>
  screen.getAllDisplays().some(({ workArea: area }) => {
    const width = Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x);
    const height = Math.min(rect.y + 40, area.y + area.height) - Math.max(rect.y, area.y);
    return width >= 100 && height >= 20;
  });

const savedBounds = (): SavedBounds => {
  const saved = readJson(userFile("window.json"));
  const [x, y, width, height] = [saved.x, saved.y, saved.width, saved.height].map(Number);
  if (!(width! >= MIN_SIZE.width && height! >= MIN_SIZE.height)) return { ...DEFAULT_SIZE };
  const maximized = saved.maximized === true;
  if (Number.isFinite(x) && Number.isFinite(y) && onScreen({ x: x!, y: y!, width: width!, height: height! })) {
    return { x, y, width: width!, height: height!, maximized };
  }
  return { width: width!, height: height!, maximized };
};

const saveBounds = (target: BrowserWindow): void => {
  if (target.isDestroyed()) return;
  writeJson(userFile("window.json"), { ...target.getNormalBounds(), maximized: target.isMaximized() });
};

// ---------------------------------------------------------------------------
// The start page's state (static/start.js draws it; it decides nothing itself)
// ---------------------------------------------------------------------------

type StepId = "env" | "doctor" | "daemon";
type StepStatus = "wait" | "run" | "done" | "fail";
type Action = "retry" | "open" | "log" | "doctor" | "probe";

interface Step {
  id: StepId;
  label: string;
  status: StepStatus;
  detail?: string;
}

interface StartState {
  /** Grows with every change, so the page never draws an older state over a newer one. */
  rev: number;
  title: string;
  note?: string;
  steps: Step[];
  checks: DoctorCheck[];
  error?: { message: string; logTail?: string; logPath?: string };
  actions: Action[];
  busy: boolean;
}

const STEPS: ReadonlyArray<Pick<Step, "id" | "label">> = [
  { id: "env", label: "Reading the shell environment" },
  { id: "doctor", label: "Checking tools" },
  { id: "daemon", label: "Starting Agoryx" },
];

const freshSteps = (): Step[] => STEPS.map((step) => ({ ...step, status: "wait" }));

const daemonStep = (status: StepStatus): Step[] => [{ id: "daemon", label: "Starting Agoryx", status }];

let win: BrowserWindow | null = null;
/** What the window shows: the start page, or the daemon's UI. */
let view: "start" | "daemon" = "start";
let state: StartState = { rev: 0, title: "Opening Agoryx", steps: freshSteps(), checks: [], actions: [], busy: true };

let core: DesktopCore | null = null;
let paths: AgoraPaths | null = null;
/** The daemon's environment, once the shell has been read. */
let daemonEnv: NodeJS.ProcessEnv | null = null;
let supervisor: Supervisor | null = null;
let watching = false;
/** Dropped supervisors' starts still under way: their daemons may not answer yet. */
let settling: Promise<unknown> = Promise.resolve();
/** The daemon the window shows (or will show again); null while there is none. */
let daemon: DaemonInfo | null = null;
let checks: DoctorCheck[] = [];
/** Warnings waiting for "Open Agoryx", as warningsKey() gives them. */
let pendingWarnings: string | null = null;
/** A start sequence (or a doctor run) is under way: buttons wait, menu items that would race it do nothing. */
let busy = false;
let stopping = false;
/** The tray, the Dock badge and banners for rooms that wait (attention.ts); made in ready(). */
let attention: ReturnType<typeof createAttention> | null = null;

const show = (next: Omit<StartState, "rev">): void => {
  state = { ...next, rev: state.rev + 1 };
  if (!win || win.isDestroyed()) return;
  if (view !== "start") {
    // The page asks for the state when it loads.
    view = "start";
    win.loadFile(START_PAGE).catch(() => {});
    return;
  }
  win.webContents.send("agoryx:state", state);
};

const update = (patch: Partial<Omit<StartState, "rev">>): void => show({ ...state, ...patch });

const withStep = (id: StepId, status: StepStatus, detail?: string): Step[] =>
  state.steps.map((step) => (step.id === id ? { ...step, status, ...(detail ? { detail } : {}) } : step));

const daemonOrigin = (): string | null => (daemon ? new URL(daemon.url).origin : null);

/** The window on the daemon's UI; `/?t=` trades the token for the UI's cookie and redirects to `/`. */
const showDaemon = (info: DaemonInfo): void => {
  daemon = info;
  // Also with the window closed: the one the Dock opens next shows the daemon, not the start page's last state.
  view = "daemon";
  // Also with the window closed. Neither throws, and both are no-ops for the same daemon (render() calls this again).
  attention?.setDaemon(info);
  panes.connect(info);
  if (!win || win.isDestroyed()) return;
  win.loadURL(`${info.url}/?t=${encodeURIComponent(info.token)}`).catch(() => {});
};

const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split("\n")[0]!.trim();

const logFile = (): string | null => {
  if (supervisor) return supervisor.logPath();
  if (paths) return join(paths.agoraHome(daemonEnv ?? process.env), "daemon.log");
  return null;
};

// ---------------------------------------------------------------------------
// The start sequence
// ---------------------------------------------------------------------------

const exclusive = async (task: () => Promise<void>): Promise<void> => {
  if (busy || stopping) return;
  busy = true;
  try {
    await task();
  } finally {
    busy = false;
  }
};

/**
 * Forget the supervisor (the daemon keeps running): the next start attaches with a fresh environment,
 * after any start the old one still has under way (`settling`), so it never starts a second daemon.
 */
const dropSupervisor = (): void => {
  if (supervisor) {
    supervisor.removeAllListeners();
    settling = Promise.all([settling, supervisor.dispose()]);
  }
  supervisor = null;
  watching = false;
};

/**
 * 1. read the shell, 2. check the tools, 3. stop on a failure, show warnings until the user opens anyway,
 * 4. start or find the daemon, 5. show its UI.
 */
const boot = (): Promise<void> =>
  exclusive(async () => {
    dropSupervisor();
    daemon = null;
    pendingWarnings = null;
    show({ title: "Opening Agoryx", steps: withRunning(freshSteps(), "env"), checks: [], actions: [], busy: true });
    const root = agoryxRoot();
    if (!core || !paths) {
      try {
        ({ core, paths } = await loadCore(root));
      } catch (error) {
        const missing: DoctorCheck = {
          id: "agoryx",
          label: "Agoryx",
          status: "fail",
          detail: `could not load ${coreEntry(root)}: ${firstLine(error)}`,
          fix: app.isPackaged ? "reinstall Agoryx.app" : `cd ${root} && npm run build:core`,
        };
        return blocked([missing], withStep("env", "fail"));
      }
    }
    const { env, source } = await readEnv(core);
    daemonEnv = env;
    // Stop Daemon and Quit meanwhile: the start sequence ends here.
    if (stopping) return;
    const read = source === "login-shell" ? "from your login shell" : "the shell did not answer; using the usual install folders";
    update({ steps: withRunning(withStep("env", "done", read), "doctor") });
    checks = await core.runDoctor({ env, root });
    if (stopping) return;
    const verdict = core.doctorVerdict(checks);
    if (verdict === "fail") return blocked(checks, withStep("doctor", "fail"));
    const warnings = checks.filter((check) => check.status !== "ok").length;
    const steps = withStep("doctor", "done", warnings ? `${warnings} ${warningWord(warnings)}` : "everything found");
    const key = warningsKey(checks);
    if (verdict === "warn" && key !== acceptedWarnings()) {
      pendingWarnings = key;
      return update({
        title: "Agoryx can start, but there are warnings",
        note: "Open it now, or fix these and click “Try again”. This screen comes back only when a check changes.",
        steps,
        checks,
        actions: ["open", "retry"],
        busy: false,
      });
    }
    update({ steps, checks });
    await startDaemon();
  });

/** "1 warning", "3 warnings". */
const warningWord = (count: number): string => (count === 1 ? "warning" : "warnings");

const withRunning = (steps: Step[], id: StepId): Step[] => steps.map((step) => (step.id === id ? { ...step, status: "run" } : step));

const blocked = (found: DoctorCheck[], steps: Step[]): void =>
  update({
    title: "Agoryx needs a few things first",
    note: "Nothing was started. Fix the items marked ✕ and click “Try again”.",
    steps,
    checks: found,
    actions: ["retry"],
    busy: false,
  });

const ensureSupervisor = (): Supervisor => {
  if (supervisor) return supervisor;
  if (!core || !daemonEnv) throw new Error("the environment has not been read yet");
  const node = core.findExecutable("node", daemonEnv);
  if (!node) throw new Error("node is not in your PATH (brew install node)");
  const next = new core.DaemonSupervisor({ root: agoryxRoot(), node, env: daemonEnv, log: (message) => console.log(`[agoryx] ${message}`) });
  next.on("down", onDown);
  next.on("up", showDaemon);
  next.on("changed", showDaemon);
  next.on("failed", onFailed);
  supervisor = next;
  return next;
};

/** Follow the daemon from now on, whichever way it came up (a start, a restart from the menu). */
const watchDaemon = (running: Supervisor): void => {
  if (watching) return;
  running.watch();
  watching = true;
};

const startDaemon = async (): Promise<void> => {
  update({ steps: withRunning(state.steps, "daemon"), actions: [], busy: true });
  try {
    await settling;
    // Stop Daemon and Quit meanwhile: nothing more is started.
    if (stopping) return;
    const running = ensureSupervisor();
    const info = await running.start();
    if (stopping) return;
    watchDaemon(running);
    showDaemon(info);
  } catch (error) {
    if (stopping) return;
    update({ title: "Agoryx could not start", note: undefined, steps: withStep("daemon", "fail"), error: startError(error), actions: ["retry", "log"], busy: false });
  }
};

/** A DaemonStartError carries its reason, log and tail; anything else (no node, say) gets the log's end. */
const startError = (error: unknown): StartState["error"] => {
  const failed = error as StartError;
  const tail = (failed.logTail ?? supervisor?.logTail(20) ?? "").trimEnd();
  return { message: failed.reason ?? firstLine(error), logTail: tail || undefined, logPath: failed.logPath ?? logFile() ?? undefined };
};

const onDown = (): void => {
  if (stopping) return;
  daemon = null;
  attention?.setDaemon(null);
  show({ title: "Agoryx stopped — restarting…", steps: daemonStep("run"), checks: [], actions: ["log"], busy: true });
};

const onFailed = (failure: SupervisorFailure): void => {
  if (stopping) return;
  daemon = null;
  attention?.setDaemon(null);
  show({
    title: "Agoryx stopped and did not come back",
    note: "Several attempts in a row to start it again failed. The log usually says why.",
    steps: daemonStep("fail"),
    checks: [],
    error: { message: failure.message, logTail: failure.logTail.trimEnd() || undefined, logPath: logFile() ?? undefined },
    actions: ["retry", "log"],
    busy: false,
  });
};

/** "Open Agoryx": past the warnings (remembered), or back to the UI from the doctor. */
const openAnyway = async (): Promise<void> => {
  if (pendingWarnings !== null) {
    acceptWarnings(pendingWarnings);
    pendingWarnings = null;
    await exclusive(startDaemon);
    return;
  }
  if (daemon) {
    showDaemon(daemon);
    return;
  }
  await boot();
};

/** The check list on demand (menu "Check Tools", the page's "Check again" / "Check agents"). */
const runChecks = (probe: boolean): Promise<void> => {
  // Nothing to check with yet (the core did not load): the start sequence says why.
  if (!core || !daemonEnv) return boot();
  return exclusive(async () => {
    if (!core || !daemonEnv) return;
    const title = "Checks";
    const note = probe ? "Sending one short request to each agent that is signed in…" : "Checking tools…";
    // The last run's checks would read as this run's answer: only the running step shows until it is in.
    const running: Step[] = [{ id: "doctor", label: probe ? "Checking tools and agents" : "Checking tools", status: "run" }];
    show({ title, note, steps: running, checks: [], actions: [], busy: true });
    checks = await core.runDoctor({ env: daemonEnv, root: agoryxRoot(), probe });
    const actions: Action[] = daemon ? ["open", "doctor", "probe", "log"] : pendingWarnings !== null ? ["open", "retry", "probe"] : ["retry", "probe"];
    show({ title, note: daemon ? "Agoryx keeps running while you look." : undefined, steps: [], checks, actions, busy: false });
  });
};

const restartDaemon = (): Promise<void> => {
  if (!supervisor) return boot();
  return exclusive(async () => {
    const running = supervisor!;
    daemon = null;
    show({ title: "Restarting Agoryx", steps: daemonStep("run"), checks: [], actions: [], busy: true });
    try {
      const info = await running.restart();
      if (stopping) return;
      // Not watched yet when the first start failed.
      watchDaemon(running);
      // An "up" for this same daemon may have shown it already.
      if (info && daemon !== info) showDaemon(info);
    } catch (error) {
      if (stopping) return;
      show({ title: "Agoryx could not restart", steps: daemonStep("fail"), checks: [], error: startError(error), actions: ["retry", "log"], busy: false });
    }
  });
};

/** The one button of the app's dialogs. */
const OK = ["OK"];

/**
 * Quitting leaves the daemon running; this is the one way the app stops it. It wins over whatever is
 * under way: no start begins after it, and a restart under way gives way (the supervisor's restart rejects).
 */
const stopAndQuit = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  show({ title: "Stopping Agoryx", note: "The agents’ current turns will stop.", steps: [], checks: [], actions: [], busy: true });
  let why: string | null = null;
  try {
    // Picked while the shell is still being read (the first start): read it here rather than not stop.
    if (!core || !paths) ({ core, paths } = await loadCore(agoryxRoot()));
    if (!daemonEnv) daemonEnv = (await readEnv(core)).env;
    // A supervisor dropped by Retry may still be starting a daemon: the stop waits for it.
    await settling;
    await (supervisor ?? ensureSupervisor()).stop();
  } catch (error) {
    why = firstLine(error);
  }
  if (why !== null) await dialog.showMessageBox({ type: "warning", message: "Agoryx did not stop", detail: why, buttons: OK });
  app.quit();
};

const openLog = async (): Promise<void> => {
  const file = logFile();
  if (!file || !existsSync(file)) {
    await dialog.showMessageBox({ type: "info", message: "No daemon log yet", detail: file ?? "The daemon has not been started from here yet.", buttons: OK });
    return;
  }
  const error = await shell.openPath(file);
  if (error) await dialog.showMessageBox({ type: "warning", message: "Could not open the daemon log", detail: `${file}\n${error}`, buttons: OK });
};

// ---------------------------------------------------------------------------
// The window: what may load in it, and what may be asked of it
// ---------------------------------------------------------------------------

const WEB_PREFERENCES: WebPreferences = {
  preload: PRELOAD,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webviewTag: false,
  spellcheck: true,
};

const backgroundColor = (): string => (nativeTheme.shouldUseDarkColors ? "#111411" : "#f3f4ef");

const isStartPage = (url: string): boolean => url.split(/[?#]/)[0] === START_URL;

const isDaemonUrl = (url: string): boolean => {
  const origin = daemonOrigin();
  if (!origin) return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
};

/** An agent's file or HTML preview (`/raw/…`, its `~block/…`): the agent's page, with the agent's scripts. */
const isPreviewUrl = (url: string): boolean => {
  try {
    return new URL(url).pathname.startsWith("/raw/");
  } catch {
    return false;
  }
};

/** Links out of Agoryx open in the user's browser or mail app; any other scheme goes nowhere. */
const openOutside = (url: string): void => {
  try {
    const { protocol } = new URL(url);
    if (protocol === "http:" || protocol === "https:" || protocol === "mailto:") void shell.openExternal(url);
  } catch {
    // not a URL
  }
};

/**
 * When the user last clicked, tapped, or pressed Enter or Space in each page. Electron has no popup
 * blocker, and an agent's HTML preview runs its own scripts in the room's page: a window or a link outside
 * opens only on such a gesture from the last GESTURE_MS, one per gesture.
 */
const gestures = new WeakMap<WebContents, number>();
const GESTURE_MS = 2000;
const GESTURE_INPUTS = new Set(["mouseDown", "mouseUp", "touchEnd", "gestureTap"]);

/** Whether the user just did something in this page; taken, so the next open needs a gesture of its own. */
const takeGesture = (contents: WebContents): boolean => {
  const at = gestures.get(contents);
  gestures.delete(contents);
  return at !== undefined && Date.now() - at <= GESTURE_MS;
};

/**
 * Every page, the main window's and any child's: only the start page (loaded by the app) and the daemon's
 * origin load in a window; same-origin window.open gets a child window like this one; an agent's preview
 * and the rest go out. Nothing opens without the user's gesture.
 */
const guard = (contents: WebContents): void => {
  contents.on("input-event", (_event, input) => {
    if (GESTURE_INPUTS.has(input.type)) gestures.set(contents, Date.now());
  });
  contents.on("before-input-event", (_event, input) => {
    if (input.type === "keyDown" && !input.isAutoRepeat && (input.key === "Enter" || input.key === " ")) gestures.set(contents, Date.now());
  });
  contents.on("will-navigate", (event) => {
    if (isDaemonUrl(event.url) && !isPreviewUrl(event.url)) return;
    event.preventDefault();
    if (takeGesture(contents)) openOutside(event.url);
  });
  contents.on("will-redirect", (event) => {
    if (event.isMainFrame && !isDaemonUrl(event.url)) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (!takeGesture(contents)) {
      console.log(`[agoryx] refused a window the page opened without a click: ${url}`);
      return { action: "deny" };
    }
    if (isDaemonUrl(url) && !isPreviewUrl(url)) {
      const child: BrowserWindowConstructorOptions = {
        width: 1100,
        height: 800,
        minWidth: 480,
        minHeight: 360,
        backgroundColor: backgroundColor(),
        webPreferences: WEB_PREFERENCES,
      };
      return { action: "allow", overrideBrowserWindowOptions: child };
    }
    openOutside(url);
    return { action: "deny" };
  });
};

/** Denied unless listed, and only for the app's own pages: copying (the UI's copy buttons) and a video's full screen. */
const GRANTED = new Set(["clipboard-sanitized-write", "fullscreen"]);

const trustedRequest = (contents: WebContents | null, requesting: string): boolean => {
  if (!contents || contents.isDestroyed()) return false;
  const page = contents.getURL();
  if (isStartPage(page)) return requesting.startsWith("file:");
  return isDaemonUrl(page) && isDaemonUrl(requesting);
};

const guardPermissions = (): void => {
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(GRANTED.has(permission) && trustedRequest(contents, details.requestingUrl));
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin) =>
    GRANTED.has(permission) && trustedRequest(contents, requestingOrigin),
  );
};

/** Draw the current view in the (new or crashed) window. */
const render = (target: BrowserWindow): void => {
  if (view === "daemon" && daemon) {
    showDaemon(daemon);
    return;
  }
  view = "start";
  target.loadFile(START_PAGE).catch(() => {});
};

const createWindow = (): BrowserWindow => {
  const bounds = savedBounds();
  const next = new BrowserWindow({
    ...(bounds.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    width: bounds.width,
    height: bounds.height,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    title: "Agoryx",
    show: false,
    backgroundColor: backgroundColor(),
    webPreferences: WEB_PREFERENCES,
  });
  if (bounds.maximized) next.maximize();
  next.once("ready-to-show", () => next.show());
  let saving: NodeJS.Timeout | undefined;
  const saveSoon = () => {
    clearTimeout(saving);
    saving = setTimeout(() => saveBounds(next), 500);
  };
  next.on("resized", saveSoon);
  next.on("moved", saveSoon);
  next.on("close", () => {
    clearTimeout(saving);
    saveBounds(next);
  });
  next.on("closed", () => {
    if (win === next) win = null;
  });
  next.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit" && !next.isDestroyed()) render(next);
  });
  next.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    // -3: aborted, i.e. a newer load replaced this one.
    if (!isMainFrame || code === -3 || stopping || !isDaemonUrl(url)) return;
    show({
      title: "Agoryx is not responding",
      note: "If it stopped, the app will start it again; otherwise click “Try again”.",
      steps: [],
      checks: [],
      error: { message: `${description} (${new URL(url).host})` },
      actions: ["retry", "log"],
      busy: false,
    });
  });
  win = next;
  panes.attachWindow(next);
  render(next);
  return next;
};

const focusWindow = (): void => {
  const target = win && !win.isDestroyed() ? win : createWindow();
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
};

// ---------------------------------------------------------------------------
// The start page's calls (desktop/src/preload.cts); only the bundled start page may make them
// ---------------------------------------------------------------------------

const fromStartPage = (event: IpcMainInvokeEvent): void => {
  if (!isStartPage(event.senderFrame?.url ?? "")) throw new Error("only the start page may ask this");
};

/** The daemon's UI in the main window's main frame, not a preview: the only page that may use the room's browser. */
const trustedUi = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
  win !== null &&
  !win.isDestroyed() &&
  event.sender === win.webContents &&
  event.senderFrame === win.webContents.mainFrame &&
  isDaemonUrl(event.senderFrame?.url ?? "") &&
  !isPreviewUrl(event.senderFrame?.url ?? "");

/** The room's browser (browserpane.ts): one pane per room, inside the main window. */
const panes = new BrowserPanes({
  root: agoryxRoot(),
  trustedUi,
  userGesture: (contents) => takeGesture(contents),
  log: (line) => console.log(`[browser] ${line}`),
});

const listen = (): void => {
  ipcMain.handle("agoryx:state", (event) => {
    fromStartPage(event);
    return state;
  });
  ipcMain.handle("agoryx:retry", (event) => {
    fromStartPage(event);
    void boot();
  });
  ipcMain.handle("agoryx:open", (event) => {
    fromStartPage(event);
    void openAnyway();
  });
  ipcMain.handle("agoryx:log", (event) => {
    fromStartPage(event);
    return openLog();
  });
  ipcMain.handle("agoryx:doctor", (event, probe: unknown) => {
    fromStartPage(event);
    return runChecks(probe === true).then(() => checks);
  });
  panes.listen();
};

// ---------------------------------------------------------------------------
// Menu and lifecycle
// ---------------------------------------------------------------------------

/**
 * “View” acts on the focused window's own page (the UI, or a daemon child window), never on the focused
 * contents: with the room's browser focused, the roles would reload it, zoom it (moving the agents' coordinates)
 * or open its DevTools.
 */
const onPage = (act: (page: WebContents) => void): void => {
  const target = BrowserWindow.getFocusedWindow() ?? win;
  if (target && !target.isDestroyed()) act(target.webContents);
};

/** The standard menus spelled out, with the app's own Daemon menu and a View menu that acts on the page (see onPage). */
const buildMenu = (): Menu =>
  Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: "about", label: "About Agoryx" },
        { type: "separator" },
        {
          label: "Settings…",
          accelerator: "CmdOrCtrl+,",
          // The page's own settings; the start page (doctor, the daemon down) has none.
          click: () =>
            onPage((page) => {
              if (isDaemonUrl(page.getURL())) void page.executeJavaScript(`location.hash = "#settings"`).catch(() => {});
            }),
        },
        { type: "separator" },
        { role: "hide", label: "Hide Agoryx" },
        { role: "hideOthers", label: "Hide Others" },
        { role: "unhide", label: "Show All" },
        { type: "separator" },
        { role: "quit", label: "Quit Agoryx" },
      ],
    },
    {
      label: "Daemon",
      submenu: [
        {
          label: "Check Tools",
          click: () => {
            focusWindow();
            void runChecks(false);
          },
        },
        { label: "Open Daemon Log", click: () => void openLog() },
        { type: "separator" },
        {
          label: "Restart Daemon",
          click: () => {
            focusWindow();
            void restartDaemon();
          },
        },
        { label: "Stop Daemon and Quit", click: () => void stopAndQuit() },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo", label: "Undo" },
        { role: "redo", label: "Redo" },
        { type: "separator" },
        { role: "cut", label: "Cut" },
        { role: "copy", label: "Copy" },
        { role: "paste", label: "Paste" },
        { role: "pasteAndMatchStyle", label: "Paste and Match Style" },
        { role: "delete", label: "Delete" },
        { role: "selectAll", label: "Select All" },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => onPage((page) => page.reload()) },
        { label: "Force Reload", accelerator: "Shift+CmdOrCtrl+R", click: () => onPage((page) => page.reloadIgnoringCache()) },
        { label: "Toggle Developer Tools", accelerator: "Alt+CmdOrCtrl+I", click: () => onPage((page) => page.toggleDevTools()) },
        { type: "separator" },
        { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: () => onPage((page) => page.setZoomLevel(0)) },
        { label: "Zoom In", accelerator: "CmdOrCtrl+Plus", click: () => onPage((page) => page.setZoomLevel(page.getZoomLevel() + 0.5)) },
        { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => onPage((page) => page.setZoomLevel(page.getZoomLevel() - 0.5)) },
        { type: "separator" },
        { role: "togglefullscreen", label: "Toggle Full Screen" },
      ],
    },
    {
      role: "windowMenu",
      label: "Window",
      submenu: [
        { role: "minimize", label: "Minimize" },
        { role: "zoom", label: "Zoom" },
        { type: "separator" },
        { role: "front", label: "Bring All to Front" },
      ],
    },
  ]);

const ready = (): void => {
  app.setAboutPanelOptions({ applicationName: "Agoryx", applicationVersion: coreVersion(), version: "", copyright: "MIT License" });
  if (!app.isPackaged && existsSync(DEV_ICON)) app.dock?.setIcon(DEV_ICON);
  guardPermissions();
  listen();
  Menu.setApplicationMenu(buildMenu());
  createWindow();
  attention = createAttention({ core: () => core, window: () => win, focusWindow, isDaemonUrl, daemonOrigin, log: (message) => console.log(`[attention] ${message}`) });
  void boot();
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", focusWindow);
  // A pane of the room's browser has its own rules (browserpane.ts); every other page gets guard().
  app.on("web-contents-created", (_event, contents) => {
    if (!panes.owns(contents)) guard(contents);
  });
  // Closing the window keeps the app (and its watch over the daemon) in the Dock, as macOS apps do.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (app.isReady()) focusWindow();
  });
  // Quit leaves the daemon running: rooms keep going. Only "Stop Daemon and Quit" stops it.
  app.on("before-quit", () => {
    attention?.dispose();
    panes.close();
    supervisor?.removeAllListeners();
    void supervisor?.dispose();
  });
  void app.whenReady().then(ready);
}
