import process from "node:process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ora, { type Ora } from "ora";
import cliCursor from "cli-cursor";
import pc from "picocolors";
import { createAdapterRegistry } from "../../internal/adapters/registry.js";
import {
  collectRoomExportData,
  collectTargetExportData,
  parseExportCommandArgs,
  renderSessionExport,
} from "./session-export.js";
import { runInkChat } from "./ink-chat.js";
import type { ChatRuntimeConfig } from "../../internal/config/default.js";
import { loadConfig, toRuntimeConfig } from "../../internal/config/index.js";
import {
  ensureParentDirectory,
  resolveConfigPathForLoad,
  resolveDefaultWorktreeDir,
  resolveWorkspaceStateRoot,
} from "../../internal/config/paths.js";
import { ChatEngine } from "../../internal/engine/chat.js";
import type { AdapterEvent } from "../../internal/adapters/adapter.js";
import type { OrchestrationMode } from "../../internal/events/types.js";
import { SessionService } from "../../internal/session/service.js";
import { SQLiteStore } from "../../internal/storage/sqlite.js";
import { MemoryService } from "../../internal/memory/service.js";
import {
  isValidWorktreeAgentName,
  normalizeWorktreeAgentName,
  WorktreeManager,
} from "../../internal/worktree/manager.js";
import { WorkspaceCollector } from "../../internal/workspace/collector.js";
import { sanitizeRenderedDelta } from "../../internal/rendering/sanitize.js";
import {
  describeSessionBinding,
  extractPayloadText,
  formatSessionId,
  normalizeStatusText,
} from "./render-helpers.js";

const MODES: OrchestrationMode[] = ["manual", "round-robin", "auto", "team"];
const ROOT_COMMANDS = ["chat", "sessions", "config", "completion", "man", "help"] as const;
const APP_VERSION = resolveAppVersion();
const EXIT_USAGE_ERROR = 2;

type OutputWriter = (line?: string) => void;

interface OptionSpec {
  long: string;
  short?: string;
  takesValue: boolean;
}

const CHAT_OPTION_SPECS: OptionSpec[] = [
  { long: "help", short: "h", takesValue: false },
  { long: "agents", takesValue: true },
  { long: "mode", short: "m", takesValue: true },
  { long: "config", short: "c", takesValue: true },
  { long: "db", takesValue: true },
  { long: "adapter-mode", takesValue: true },
  { long: "quiet-system", takesValue: false },
  { long: "plain-ui", takesValue: false },
  { long: "no-color", takesValue: false },
  { long: "resume", takesValue: true },
  { long: "room-name", takesValue: true },
];

const SESSIONS_LIST_OPTION_SPECS: OptionSpec[] = [
  { long: "help", short: "h", takesValue: false },
  { long: "limit", takesValue: true },
  { long: "db", takesValue: true },
  { long: "config", takesValue: true },
];

const SESSIONS_EXPORT_OPTION_SPECS: OptionSpec[] = [
  { long: "help", short: "h", takesValue: false },
  { long: "format", takesValue: true },
  { long: "out", takesValue: true },
  { long: "db", takesValue: true },
  { long: "config", takesValue: true },
];

const COMPLETION_OPTION_SPECS: OptionSpec[] = [
  { long: "help", short: "h", takesValue: false },
];

class CliUsageError extends Error {
  public readonly exitCode = EXIT_USAGE_ERROR;

  public constructor(
    message: string,
    public readonly usage?: (write?: OutputWriter) => void,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "CliUsageError";
  }
}

interface SlashCommandHint {
  command: string;
  description: string;
}

const SLASH_COMMAND_HINTS: SlashCommandHint[] = [
  { command: "/help", description: "show in-chat command help" },
  { command: "/mode", description: "switch orchestration mode" },
  { command: "/status", description: "show adapter health and mode" },
  { command: "/adapter", description: "change adapter mode for an agent" },
  { command: "/team", description: "team runtime commands" },
  { command: "/pin", description: "pin persistent context" },
  { command: "/unpin", description: "remove pinned context by id" },
  { command: "/pins", description: "list pinned context entries" },
  { command: "/summary", description: "create or show checkpoint summary" },
  { command: "/checkpoint", description: "alias for /summary" },
  { command: "/history", description: "print recent room messages" },
  { command: "/memory", description: "memory log and snapshot commands" },
  { command: "/worktree", description: "manage agent git worktrees" },
  { command: "/workspace", description: "show workspace context block" },
  { command: "/retry", description: "retry latest failed adapter request" },
  { command: "/export", description: "export current session" },
  { command: "/quit", description: "exit chat session" },
  { command: "/exit", description: "exit chat session" },
];

function resolveAppVersion(): string {
  const startDir = dirname(fileURLToPath(import.meta.url));
  let current = startDir;

  while (true) {
    const candidate = resolve(current, "package.json");
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf-8")) as {
          name?: string;
          version?: string;
        };
        if (parsed.name === "agoryx" && typeof parsed.version === "string") {
          const version = parsed.version.trim();
          if (version.length > 0) {
            return version;
          }
        }
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[cli] Failed to parse '${candidate}': ${detail}`);
      }
    }

    const parent = resolve(current, "..");
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return "dev";
}

interface RenderOptions {
  richUi: boolean;
  hideSystem: boolean;
  color: boolean;
}

const renderOptions: RenderOptions = {
  richUi: output.isTTY,
  hideSystem: false,
  color: output.isTTY && !("NO_COLOR" in process.env),
};

let cursorHidden = false;
let escInterruptInFlight = false;

function isEnabledFlag(value?: string): boolean {
  if (!value) {
    return false;
  }
  return value === "true" || value === "1";
}

const parseAgentList = (raw: string): string[] =>
  raw
    .split(",")
    .map((value) => normalizeWorktreeAgentName(value))
    .filter(Boolean);

const ensureValidAgentNames = (agents: string[], source: string): void => {
  const invalid = agents.filter((agent) => !isValidWorktreeAgentName(agent));
  if (invalid.length === 0) {
    return;
  }

  throw new CliUsageError(
    `Invalid agent name in ${source}: ${invalid.join(", ")}`,
    printChatUsage,
    "Allowed agent characters: a-z, 0-9, dot (.), underscore (_), and hyphen (-).",
  );
};

function configureRenderOptions(next: RenderOptions): void {
  renderOptions.richUi = next.richUi;
  renderOptions.hideSystem = next.hideSystem;
  renderOptions.color = next.color;
}

function shouldShowSystemLines(): boolean {
  return !renderOptions.hideSystem;
}

function colorize(value: string, paint: (text: string) => string): string {
  if (!renderOptions.color) {
    return value;
  }
  return paint(value);
}

function formatStatusLabel(adapterName: string): string {
  return colorize(`[${adapterName}]`, pc.cyan);
}

function formatAdapterName(adapterName: string): string {
  return colorize(adapterName, pc.bold);
}

function formatInfoLabel(value: string): string {
  return colorize(value, pc.dim);
}

function formatErrorText(value: string): string {
  return colorize(value, pc.red);
}

function formatInfoLine(value: string): string {
  return colorize(value, pc.cyan);
}

function formatSuccessLine(value: string): string {
  return colorize(value, pc.green);
}

function formatWarnLine(value: string): string {
  return colorize(value, pc.yellow);
}

function formatHintLine(value: string): string {
  return colorize(value, pc.yellow);
}

function formatUsageErrorLine(value: string): string {
  return formatErrorText(value);
}

function ensureCursorHidden(): void {
  if (!renderOptions.richUi || cursorHidden) {
    return;
  }
  cliCursor.hide(output);
  cursorHidden = true;
}

function cleanupRenderState(): void {
  for (const state of adapterRenderStates.values()) {
    if (state.spinner?.isSpinning) {
      state.spinner.stop();
    }
    state.spinner = null;
    state.lineOpen = false;
    state.sawContent = false;
    state.pendingSessionId = null;
    state.lastSessionId = null;
    state.insideSystemReminder = false;
    state.prefixPrinted = false;
    state.currentStatusText = "generating...";
  }
  if (cursorHidden) {
    cliCursor.show(output);
    cursorHidden = false;
  }
}

async function main(): Promise<void> {
  const [, , ...argv] = process.argv;
  const [command, ...rest] = argv;

  if (!command) {
    await runChat(argv);
    return;
  }

  if (command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  if (command === "--version" || command === "-V") {
    printVersion();
    return;
  }

  if (command.startsWith("-")) {
    await runChat(argv);
    return;
  }

  switch (command) {
    case "help":
      if (rest[0] === "chat") {
        printChatUsage();
      } else if (rest[0] === "sessions") {
        printSessionsUsage();
      } else if (rest[0] === "config") {
        printConfigUsage();
      } else if (rest[0] === "completion") {
        printCompletionUsage();
      } else {
        printUsage();
      }
      return;
    case "chat":
      await runChat(rest);
      return;
    case "sessions":
      runSessions(rest);
      return;
    case "config":
      runConfig(rest);
      return;
    case "completion":
      runCompletion(rest);
      return;
    case "man":
      printManPage();
      return;
    default:
      throw new CliUsageError(
        renderUnknownCommandMessage(command),
        printUsage,
        "Run `agoryx help` or `agoryx --help` to see available commands.",
      );
  }
}

const runChat = async (argv: string[]): Promise<void> => {
  const parsed = parseCliArgsOrThrow(argv, CHAT_OPTION_SPECS, printChatUsage);
  if (isEnabledFlag(parsed.options.help)) {
    printChatUsage();
    return;
  }
  if (parsed.positionals.length > 0) {
    throw new CliUsageError(
      `Unexpected argument for chat command: ${parsed.positionals[0]}`,
      printChatUsage,
      "Remove extra positional args, or pipe input to stdin for non-interactive mode.",
    );
  }

  const args = parsed.options;
  configureRenderOptions({
    richUi: output.isTTY && !isEnabledFlag(args["plain-ui"]),
    hideSystem: isEnabledFlag(args["quiet-system"]),
    color: output.isTTY && !isEnabledFlag(args["no-color"]) && !("NO_COLOR" in process.env),
  });

  const cliAgents = args.agents ? parseAgentList(args.agents) : undefined;
  if (cliAgents) {
    ensureValidAgentNames(cliAgents, "--agents");
  }

  const loadedConfig = loadConfig(args.config);
  const runtimeConfig = toRuntimeConfig(loadedConfig, {
    roomName: args["room-name"] ?? "Agoryx Room",
    resumeRoomId: args.resume,
    agents: cliAgents,
  });

  const mode = normalizeMode(args.mode ?? runtimeConfig.mode);
  if (!mode) {
    throw new CliUsageError(
      `Invalid mode '${args.mode ?? runtimeConfig.mode}'. Valid modes: ${MODES.join(", ")}`,
      printChatUsage,
      "Use one of: manual, round-robin, auto, team.",
    );
  }

  const config: ChatRuntimeConfig = {
    ...runtimeConfig,
    mode,
    roomConfig: {
      ...runtimeConfig.roomConfig,
      mode,
    },
    dbPath: normalizeDbPath(args.db ?? runtimeConfig.dbPath),
  };

  ensureDbPathReady(config.dbPath);

  config.agents = config.agents
    .map((value) => normalizeWorktreeAgentName(value))
    .filter(Boolean);
  ensureValidAgentNames(config.agents, "resolved agent list");
  const adapterMode = args["adapter-mode"];
  if (
    adapterMode === "cli" ||
    adapterMode === "stub" ||
    adapterMode === "persistent" ||
    adapterMode === "agentic"
  ) {
    for (const agent of config.agents) {
      if (config.adapterConfig[agent]) {
        config.adapterConfig[agent] = {
          ...config.adapterConfig[agent],
          mode: adapterMode,
        };
      }
    }
  } else if (mode === "team") {
    promoteCliAdaptersToAgentic(config);
  }

  const store = new SQLiteStore(config.dbPath);
  store.init();
  const session = new SessionService(store, {
    workspace: {
      config: config.workspace,
      rootCwd: process.cwd(),
      resolveAgentCwd: (agentName) => config.adapterConfig[agentName]?.workspaceCwd,
    },
  });
  const adapters = createAdapterRegistry();
  const configuredMemoryRoot = process.env.AGORYX_MEMORY_ROOT?.trim();
  const defaultWorkspaceStateRoot = resolveWorkspaceStateRoot(process.cwd());
  const configuredDebounce = Number(process.env.AGORYX_MEMORY_DEBOUNCE_MS ?? "");
  const memoryDebounceMs = Number.isFinite(configuredDebounce) && configuredDebounce >= 0
    ? configuredDebounce
    : undefined;
  const memoryService = new MemoryService(store, {
    rootDir: configuredMemoryRoot || defaultWorkspaceStateRoot,
    debounceMs: memoryDebounceMs,
  });
  const configuredWorktreeRoot = process.env.AGORYX_WORKTREE_ROOT?.trim();
  const worktreeManager = new WorktreeManager(
    process.cwd(),
    configuredWorktreeRoot || resolveDefaultWorktreeDir(process.cwd()),
  );

  let inkAdapterEventSink: ((adapterName: string, event: AdapterEvent) => void) | null = null;
  let engineRef: ChatEngine | null = null;
  const engine = new ChatEngine(session, adapters, config, {
    onAdapterEvent: (adapterName, event) => {
      if (inkAdapterEventSink) {
        inkAdapterEventSink(adapterName, event);
        return;
      }
      renderAdapterEvent(
        adapterName,
        event,
        () => engineRef?.getState().room.config.mode ?? config.mode,
      );
    },
  }, memoryService, worktreeManager);
  engineRef = engine;

  const initialized = engine.init();

  try {
    if (input.isTTY) {
      await runInkChat({
        version: APP_VERSION,
        roomId: initialized.room.id,
        sessionId: initialized.sessionId,
        mode: initialized.mode,
        richUi: renderOptions.richUi,
        hideSystem: renderOptions.hideSystem,
        agents: config.agents,
        adapterConfig: config.adapterConfig,
        slashCommands: SLASH_COMMAND_HINTS,
        getMode: () => engine.getState().room.config.mode,
        submitLine: async (rawLine) =>
          processChatInputLine(
            rawLine,
            engine,
            config,
            store,
            memoryService,
            worktreeManager,
          ),
        interruptActiveRun: () => interruptActiveTeamRun(engine),
        attachAdapterEventSink: (sink) => {
          inkAdapterEventSink = sink;
        },
      });
      return;
    }

    printBanner(
      initialized.room.id,
      initialized.sessionId,
      initialized.mode,
      config.agents,
      config.adapterConfig,
    );

    const rl = readline.createInterface({
      input,
      output,
    });
    try {
      for await (const rawLine of rl) {
        const shouldContinue = await processChatInputLine(
          rawLine,
          engine,
          config,
          store,
          memoryService,
          worktreeManager,
        );
        if (!shouldContinue) {
          break;
        }
      }
    } finally {
      rl.close();
    }
  } finally {
    inkAdapterEventSink = null;
    cleanupRenderState();
    const shutdownReport = await engine.shutdown();
    for (const failure of shutdownReport.destroyFailures) {
      console.error(formatWarnLine(`Shutdown cleanup warning: ${failure}`));
    }
    await memoryService.dispose();
    store.close();
  }
};

const processChatInputLine = async (
  rawLine: string,
  engine: ChatEngine,
  config: ChatRuntimeConfig,
  store: SQLiteStore,
  memoryService: MemoryService,
  worktreeManager: WorktreeManager,
): Promise<boolean> => {
  const line = rawLine.trim();
  if (!line) {
    return true;
  }

  if (line.startsWith("/")) {
    return handleCommand(line, engine, config, store, memoryService, worktreeManager);
  }

  const mode = engine.getState().room.config.mode;
  const isTeamTrigger = /^@team\s/i.test(line);
  const teamStatusBefore = (mode === "team" || isTeamTrigger) ? engine.teamStatus() : null;

  const results = await engine.processUserMessage(line);
  if (results.length === 0) {
    if (mode === "team" || isTeamTrigger) {
      const status = engine.teamStatus();
      if (status && !teamStatusBefore) {
        console.log(formatSuccessLine(`Team run started: ${status.run.id}`));
        const warnings = engine.consumeTeamRunStartWarnings(status.run.id);
        for (const warning of warnings) {
          console.log(formatWarnLine(`Team run warning: ${warning}`));
        }
      } else if (status?.run.status === "active") {
        console.log(formatInfoLine(`Feedback queued for team run ${status.run.id}.`));
      } else if (status?.run.status === "waiting_user_input") {
        console.log(
          formatWarnLine(`Team run ${status.run.id} is waiting for approval. Use /team approve.`),
        );
      }
      return true;
    }

    console.log(formatWarnLine("No dispatch generated."));
    console.log(formatHintLine("In manual mode, mention an agent (e.g. @codex)."));
    return true;
  }

  for (const result of results) {
    if (!result.success) {
      console.error(formatUsageErrorLine(`[${result.adapter}] error: ${result.error ?? "unknown error"}`));
    }
  }

  return true;
};

const runSessions = (argv: string[]): void => {
  if (argv.length === 0) {
    throw new CliUsageError(
      "Missing sessions subcommand.",
      printSessionsUsage,
      "Use `sessions list` or `sessions export <room_or_session_id>`.",
    );
  }

  const [subcommand, ...rest] = argv;
  if (subcommand === "--help" || subcommand === "-h") {
    printSessionsUsage();
    return;
  }

  if (subcommand === "list") {
    const parsed = parseCliArgsOrThrow(rest, SESSIONS_LIST_OPTION_SPECS, printSessionsListUsage);
    if (isEnabledFlag(parsed.options.help)) {
      printSessionsListUsage();
      return;
    }
    if (parsed.positionals.length > 0) {
      throw new CliUsageError(
        `Unexpected positional argument for sessions list: ${parsed.positionals[0]}`,
        printSessionsListUsage,
        "Use only flags with `sessions list`.",
      );
    }

    const loadedConfig = loadConfig(parsed.options.config);
    const dbPath = normalizeDbPath(parsed.options.db ?? loadedConfig.session.dbPath);
    ensureDbPathReady(dbPath);
    const store = new SQLiteStore(dbPath);
    store.init();
    try {
      const parsedLimit = Number(parsed.options.limit ?? "20");
      if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
        throw new CliUsageError(
          `Invalid value for --limit: ${parsed.options.limit ?? ""}`,
          printSessionsListUsage,
          "Provide a positive integer, for example `--limit 20`.",
        );
      }
      const sessions = store.listSessionRuns(parsedLimit);
      if (sessions.length === 0) {
        console.log(formatInfoLine("No sessions found."));
        return;
      }

      console.log("session_id\troom_id\troom_name\tcreated_at");
      for (const session of sessions) {
        console.log(
          `${session.id}\t${session.roomId}\t${session.roomName}\t${session.createdAt}`,
        );
      }
      return;
    } finally {
      store.close();
    }
  }

  if (subcommand === "export") {
    const parsed = parseCliArgsOrThrow(rest, SESSIONS_EXPORT_OPTION_SPECS, printSessionsExportUsage);
    if (isEnabledFlag(parsed.options.help)) {
      printSessionsExportUsage();
      return;
    }

    const [targetId, ...extraPositionals] = parsed.positionals;
    if (!targetId) {
      throw new CliUsageError(
        "Missing <room_or_session_id>.",
        printSessionsExportUsage,
        "Run `sessions list` first to copy a room/session id.",
      );
    }
    if (extraPositionals.length > 0) {
      throw new CliUsageError(
        `Unexpected positional argument for sessions export: ${extraPositionals[0]}`,
        printSessionsExportUsage,
        "Use only one positional id: <room_or_session_id>.",
      );
    }

    const format = parsed.options.format?.toLowerCase();
    if (format && format !== "markdown" && format !== "json") {
      throw new CliUsageError(
        `Unsupported export format: ${format}`,
        printSessionsExportUsage,
        "Supported formats: markdown, json.",
      );
    }

    const loadedConfig = loadConfig(parsed.options.config);
    const dbPath = normalizeDbPath(parsed.options.db ?? loadedConfig.session.dbPath);
    ensureDbPathReady(dbPath);
    const store = new SQLiteStore(dbPath);
    store.init();
    try {
      const outputText = renderSessionExport(
        collectTargetExportData(store, targetId),
        format === "json" ? "json" : "markdown",
      );

      const outPath = parsed.options.out;
      if (outPath) {
        writeFileSync(outPath, outputText, "utf8");
        console.log(formatSuccessLine(`Session export written to ${outPath}`));
        return;
      }

      console.log(outputText);
      return;
    } finally {
      store.close();
    }
  }

  throw new CliUsageError(
    `Unknown sessions subcommand: ${subcommand}`,
    printSessionsUsage,
    "Use `sessions list` or `sessions export`.",
  );
};

const runConfig = (argv: string[]): void => {
  if (argv.length === 0 || argv[0] === "explain") {
    const parsed = parseCliArgsOrThrow(argv[0] === "explain" ? argv.slice(1) : argv, [
      { long: "help", short: "h", takesValue: false },
      { long: "config", takesValue: true },
      { long: "db", takesValue: true },
    ], printConfigUsage);
    if (isEnabledFlag(parsed.options.help)) {
      printConfigUsage();
      return;
    }
    if (parsed.positionals.length > 0) {
      throw new CliUsageError(
        `Unexpected positional argument for config explain: ${parsed.positionals[0]}`,
        printConfigUsage,
        "Use only flags with `config explain`.",
      );
    }

    const resolvedConfigPath = resolveConfigPathForLoad(parsed.options.config);
    const loadedConfig = loadConfig(parsed.options.config);
    const resolvedDbPath = normalizeDbPath(parsed.options.db ?? loadedConfig.session.dbPath);
    const workspaceStateRoot = resolveWorkspaceStateRoot(process.cwd());

    console.log("Config precedence: flags > env > config file > defaults");
    console.log(`Resolved config path: ${resolvedConfigPath}`);
    console.log(`Resolved db path: ${resolvedDbPath}`);
    console.log(`Workspace state root: ${workspaceStateRoot}`);
    console.log(`Worktree root: ${process.env.AGORYX_WORKTREE_ROOT?.trim() || resolveDefaultWorktreeDir(process.cwd())}`);
    console.log(`Memory root: ${process.env.AGORYX_MEMORY_ROOT?.trim() || workspaceStateRoot}`);
    return;
  }

  if (argv[0] === "--help" || argv[0] === "-h") {
    printConfigUsage();
    return;
  }

  throw new CliUsageError(
    `Unknown config subcommand: ${argv[0]}`,
    printConfigUsage,
    "Only `config explain` is supported.",
  );
};

const runCompletion = (argv: string[]): void => {
  const parsed = parseCliArgsOrThrow(argv, COMPLETION_OPTION_SPECS, printCompletionUsage);
  if (isEnabledFlag(parsed.options.help)) {
    printCompletionUsage();
    return;
  }
  const [shell, ...extra] = parsed.positionals;
  if (!shell) {
    throw new CliUsageError(
      "Missing shell name (bash|zsh|fish).",
      printCompletionUsage,
      "Example: `agoryx completion zsh`.",
    );
  }
  if (extra.length > 0) {
    throw new CliUsageError(
      `Unexpected positional argument: ${extra[0]}`,
      printCompletionUsage,
      "Provide exactly one shell argument.",
    );
  }

  if (shell === "bash") {
    console.log(renderBashCompletion());
    return;
  }
  if (shell === "zsh") {
    console.log(renderZshCompletion());
    return;
  }
  if (shell === "fish") {
    console.log(renderFishCompletion());
    return;
  }

  throw new CliUsageError(
    `Unsupported shell for completion: ${shell}`,
    printCompletionUsage,
    "Supported shells: bash, zsh, fish.",
  );
};

const handleCommand = async (
  line: string,
  engine: ChatEngine,
  config: ChatRuntimeConfig,
  store: SQLiteStore,
  memoryService: MemoryService,
  worktreeManager: WorktreeManager,
): Promise<boolean> => {
  const [command, ...rest] = line.split(/\s+/);
  switch (command) {
    case "/":
      printSlashCommandSuggestions("/");
      return true;
    case "/quit":
    case "/exit":
      return false;
    case "/help":
      printChatHelp();
      return true;
    case "/mode": {
      if (!rest[0]) {
        console.log(formatInfoLine(`Current mode: ${engine.getState().room.config.mode}`));
        console.log(formatHintLine("Usage: /mode <manual|round-robin|auto|team>"));
        return true;
      }
      const target = normalizeMode(rest[0]);
      if (!target) {
        console.log(formatWarnLine(`Unknown mode: ${rest[0]}`));
        console.log(formatHintLine("Usage: /mode <manual|round-robin|auto|team>"));
        return true;
      }
      const promoted = target === "team" ? promoteCliAdaptersToAgentic(config) : [];
      engine.setMode(target);
      console.log(formatSuccessLine(`Mode switched to: ${target}`));
      if (promoted.length > 0) {
        console.log(formatInfoLine(`Auto-switched adapters to agentic for team mode: ${promoted.join(", ")}`));
      }
      return true;
    }
    case "/status": {
      const status = await engine.adapterStatus();
      console.log("Adapter status:");
      for (const [adapter, value] of Object.entries(status)) {
        const mode = config.adapterConfig[adapter]?.mode ?? "stub";
        console.log(`- ${adapter}: ${value} (mode=${mode})`);
      }
      return true;
    }
    case "/adapter": {
      const [agent, mode] = rest;
      if (
        !agent ||
        (mode !== "stub" && mode !== "cli" && mode !== "persistent" && mode !== "agentic")
      ) {
        console.log(formatHintLine("Usage: /adapter <codex|claude> <stub|cli|persistent|agentic>"));
        return true;
      }
      if (!config.adapterConfig[agent]) {
        console.log(formatWarnLine(`Unknown adapter: ${agent}`));
        console.log(formatHintLine("Use /status to see available adapters."));
        return true;
      }
      config.adapterConfig[agent] = {
        ...config.adapterConfig[agent],
        mode,
      };
      console.log(formatSuccessLine(`Adapter ${agent} switched to mode=${mode}`));
      return true;
    }
    case "/team": {
      return handleTeamCommand(rest, engine);
    }
    case "/memory": {
      return handleMemoryCommand(rest, engine, store, memoryService);
    }
    case "/worktree": {
      return handleWorktreeCommand(rest, engine, config, worktreeManager, memoryService);
    }
    case "/workspace": {
      return handleWorkspaceCommand(rest, config);
    }
    case "/pin": {
      const text = rest.join(" ").trim();
      if (!text) {
        console.log(formatHintLine("Usage: /pin <label>: <content>"));
        return true;
      }

      const [maybeLabel, ...contentParts] = text.split(":");
      const content = contentParts.join(":").trim();
      const label = content ? maybeLabel.trim() : `pin-${Date.now()}`;
      const resolvedContent = content || maybeLabel.trim();
      const id = engine.addPinnedContext(label, resolvedContent);
      console.log(formatSuccessLine(`Pinned context created: ${id}`));
      return true;
    }
    case "/unpin": {
      const [pinId] = rest;
      if (!pinId) {
        console.log(formatHintLine("Usage: /unpin <pin_id>"));
        return true;
      }
      const removed = engine.removePinnedContext(pinId);
      if (removed) {
        console.log(formatSuccessLine(`Removed pinned context ${pinId}`));
      } else {
        console.log(formatWarnLine(`Pin ${pinId} not found`));
      }
      return true;
    }
    case "/pins": {
      const subcommand = rest[0]?.toLowerCase();
      if (rest.length > 1 || (subcommand && subcommand !== "list")) {
        console.log("Usage: /pins [list]");
        return true;
      }

      const pinned = engine.listPinnedContext();
      if (pinned.length === 0) {
        console.log(formatInfoLine("No pinned context."));
        return true;
      }

      console.log("pin_id\tlabel\tcontent");
      for (const pin of pinned) {
        console.log(`${pin.id}\t${pin.label}\t${pin.content}`);
      }
      return true;
    }
    case "/summary":
    case "/checkpoint": {
      const summary = engine.checkpointNow();
      if (!summary) {
        console.log(formatWarnLine("Not enough conversation history to create a checkpoint."));
        console.log(formatHintLine("Keep chatting and try /summary again."));
      } else {
        console.log(formatSuccessLine("Checkpoint created."));
      }
      return true;
    }
    case "/history": {
      const requested = Number(rest[0] ?? "10");
      const limit = Number.isFinite(requested) && requested > 0 ? requested : 10;
      const messages = engine.listMessages(limit);
      for (const message of messages.slice(-limit)) {
        console.log(`[${message.author}] ${message.text}`);
      }
      return true;
    }
    case "/retry": {
      const [rawTarget] = rest;
      const target = rawTarget?.replace("@", "").trim();
      if (!target) {
        console.log(formatHintLine("Usage: /retry @codex"));
        return true;
      }
      const retry = await engine.retryFailed(target);
      if (!retry) {
        console.log(formatInfoLine(`No failed request found for ${target}.`));
      } else if (!retry.success) {
        console.error(
          formatUsageErrorLine(
            `[${retry.adapter}] retry failed (${retry.failedRequestId} -> ${retry.requestId}): ${
              retry.error ?? "unknown error"
            }`,
          ),
        );
      } else {
        console.log(
          formatSuccessLine(
            `[${retry.adapter}] retry succeeded (${retry.failedRequestId} -> ${retry.requestId})`,
          ),
        );
      }
      return true;
    }
    case "/export": {
      const parsed = parseExportCommandArgs(rest);
      if (!parsed) {
        console.log(formatHintLine("Usage: /export [markdown|json] [--out <file>]"));
        return true;
      }

      const state = engine.getState();
      const exportData = collectRoomExportData(store, state.room.id, state.sessionId);
      const outputText = renderSessionExport(exportData, parsed.format);
      if (parsed.outPath) {
        writeFileSync(parsed.outPath, outputText, "utf8");
        console.log(formatSuccessLine(`Session export written to ${parsed.outPath}`));
      } else {
        console.log(outputText);
      }

      return true;
    }
    default:
      console.log(formatWarnLine(`Unknown command: ${command}.`));
      console.log(formatHintLine("Use /help."));
      printSlashCommandSuggestions(command);
      return true;
  }
};

const handleTeamCommand = async (
  args: string[],
  engine: ChatEngine,
): Promise<boolean> => {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "start": {
      const parsed = parseTeamStartArgs(rest);
      if (!parsed) {
        console.log(formatHintLine("Usage: /team start <goal> [--strict] [--no-checks]"));
        return true;
      }

      try {
        const run = engine.startTeamRun(parsed.goal, {
          strict: parsed.strict,
          checksEnabled: parsed.checksEnabled,
        });
        console.log(formatSuccessLine(`Team run started: ${run.id}`));
        const warnings = engine.consumeTeamRunStartWarnings(run.id);
        for (const warning of warnings) {
          console.log(formatWarnLine(`Team run warning: ${warning}`));
        }
      } catch (error) {
        console.error(
          formatUsageErrorLine(error instanceof Error ? error.message : "Failed to start team run."),
        );
      }
      return true;
    }
    case "status": {
      const status = engine.teamStatus();
      if (!status) {
        console.log(formatInfoLine("No active team run."));
        return true;
      }
      const run = status.run;
      const startedAtMs = Date.parse(run.startedAt);
      const elapsed = Number.isFinite(startedAtMs)
        ? Math.max(0, Date.now() - startedAtMs)
        : 0;
      console.log(`run_id: ${run.id}`);
      console.log(`status: ${run.status}`);
      console.log(`stage: ${run.stage}`);
      console.log(`steps: ${run.stepCount}/${run.maxSteps}`);
      console.log(`no_progress: ${run.noProgressCount}/${run.maxNoProgressSteps}`);
      console.log(`elapsed_ms: ${elapsed}`);
      console.log(`pending_feedback: ${status.pendingFeedback}`);
      return true;
    }
    case "log": {
      const requested = Number(rest[0] ?? "20");
      const limit = Number.isFinite(requested) && requested > 0 ? requested : 20;
      const log = engine.teamLog(limit);
      if (!log) {
        console.log(formatInfoLine("No team run logs."));
        return true;
      }
      console.log(`run_id: ${log.run.id}`);
      console.log("steps:");
      for (const step of log.steps) {
        console.log(
          `- #${step.seq} ${step.stage} ${step.actor} result=${step.result}` +
            (step.errorClass ? ` error=${step.errorClass}` : ""),
        );
      }
      console.log("checks:");
      for (const check of log.checks) {
        console.log(
          `- ${check.command}: ${check.status}` +
            (check.exitCode !== null ? ` (exit=${check.exitCode})` : ""),
        );
      }
      return true;
    }
    case "resume": {
      const run = engine.teamResume();
      if (!run) {
        console.log(formatInfoLine("No resumable team run."));
      } else {
        console.log(formatSuccessLine(`Team run resumed: ${run.id} (status=${run.status})`));
      }
      return true;
    }
    case "approve": {
      const run = engine.teamApprove(rest[0]);
      if (!run) {
        console.log(formatInfoLine("No waiting team run to approve."));
      } else {
        console.log(formatSuccessLine(`Team run approved: ${run.id}`));
      }
      return true;
    }
    case "interrupt": {
      const feedback = rest.join(" ").trim();
      const result = await engine.interruptTeamRun(feedback || undefined);
      if (!result) {
        console.log(formatInfoLine("No active team run to interrupt."));
        return true;
      }
      if (result.interrupted) {
        if (result.feedbackQueued) {
          console.log(formatWarnLine(`Team run interrupted: ${result.run.id}. Feedback queued.`));
        } else {
          console.log(formatWarnLine(`Team run interrupted: ${result.run.id}.`));
        }
      } else if (result.feedbackQueued) {
        console.log(formatInfoLine(`Feedback queued for team run ${result.run.id}.`));
      } else {
        console.log(formatInfoLine(`No active team step to interrupt for run ${result.run.id}.`));
      }
      return true;
    }
    case "stop": {
      const run = engine.teamStop(rest[0]);
      if (!run) {
        console.log(formatInfoLine("No active team run to stop."));
      } else {
        console.log(formatWarnLine(`Team run stopped: ${run.id}`));
      }
      return true;
    }
    default:
      console.log(formatHintLine("Usage: /team <start|status|log|resume|approve|interrupt|stop> ..."));
      return true;
  }
};

interface MemoryLogCommandOptions {
  source?: string;
  eventType?: string;
  since?: string;
  limit?: number;
  json: boolean;
}

const parseMemoryLogCommandArgs = (
  args: string[],
): MemoryLogCommandOptions | null => {
  const parsed: MemoryLogCommandOptions = { json: false };
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === "--json") {
      parsed.json = true;
      continue;
    }
    if (token === "--source") {
      const value = args[i + 1];
      if (!value) {
        return null;
      }
      parsed.source = value;
      i += 1;
      continue;
    }
    if (token === "--type") {
      const value = args[i + 1];
      if (!value) {
        return null;
      }
      parsed.eventType = value;
      i += 1;
      continue;
    }
    if (token === "--since") {
      const value = args[i + 1];
      if (!value) {
        return null;
      }
      parsed.since = value;
      i += 1;
      continue;
    }
    if (token === "--limit") {
      const value = Number(args[i + 1] ?? "");
      if (!Number.isFinite(value) || value < 0) {
        return null;
      }
      parsed.limit = value;
      i += 1;
      continue;
    }
    return null;
  }
  return parsed;
};

const renderMemorySnapshot = (snapshot: ReturnType<SQLiteStore["getMemorySnapshot"]>): string => {
  if (!snapshot) {
    return "No memory snapshot yet.";
  }

  const decisions = snapshot.keyDecisions.length > 0
    ? snapshot.keyDecisions.map((item) => `  - ${item}`).join("\n")
    : "  - (none)";
  const blockers = snapshot.blockers.length > 0
    ? snapshot.blockers.map((item) => `  - ${item}`).join("\n")
    : "  - (none)";
  const nextActions = snapshot.nextActions.length > 0
    ? snapshot.nextActions.map((item) => `  - ${item}`).join("\n")
    : "  - (none)";
  const worktrees = snapshot.activeWorktrees.length > 0
    ? snapshot.activeWorktrees.map((item) => `  - ${String(item)}`).join("\n")
    : "  - (none)";

  return [
    "Memory snapshot:",
    `- current_goal: ${snapshot.currentGoal || "(empty)"}`,
    `- active_branch: ${snapshot.activeBranch || "(empty)"}`,
    "- active_worktrees:",
    worktrees,
    "- key_decisions:",
    decisions,
    "- blockers:",
    blockers,
    "- next_actions:",
    nextActions,
    `- last_log_id: ${snapshot.lastLogId}`,
    `- reducer_version: ${snapshot.reducerVersion}`,
    `- updated_at: ${snapshot.updatedAt}`,
  ].join("\n");
};

const handleMemoryCommand = async (
  args: string[],
  engine: ChatEngine,
  store: SQLiteStore,
  memoryService: MemoryService,
): Promise<boolean> => {
  const [subcommand = "show", ...rest] = args;
  const roomId = engine.getState().room.id;

  switch (subcommand) {
    case "show": {
      memoryService.checkAndRecover(roomId);
      const snapshot = store.getMemorySnapshot(roomId);
      console.log(renderMemorySnapshot(snapshot));
      return true;
    }
    case "decision": {
      const text = rest.join(" ").trim();
      if (!text) {
        console.log("Usage: /memory decision <text>");
        return true;
      }
      memoryService.recordDecision(roomId, text);
      console.log("Memory decision recorded.");
      return true;
    }
    case "note": {
      const text = rest.join(" ").trim();
      if (!text) {
        console.log("Usage: /memory note <text>");
        return true;
      }
      memoryService.recordNote(roomId, text);
      console.log("Memory note recorded.");
      return true;
    }
    case "log": {
      const options = parseMemoryLogCommandArgs(rest);
      if (!options) {
        console.log("Usage: /memory log [--source <source>] [--type <event_type>] [--since <iso>] [--limit <n>] [--json]");
        return true;
      }

      let events = store.listMemoryEvents(roomId, {
        source: options.source,
        eventType: options.eventType,
        since: options.since,
      });
      if (options.limit != null) {
        events = events.slice(-options.limit);
      }

      if (options.json) {
        console.log(JSON.stringify(events, null, 2));
        return true;
      }

      if (events.length === 0) {
        console.log("No memory events.");
        return true;
      }

      console.log("id\ttimestamp\tsource\ttype\tpayload");
      for (const event of events) {
        console.log(
          `${event.id}\t${event.timestamp}\t${event.source}\t${event.eventType}\t${JSON.stringify(event.payload)}`,
        );
      }
      return true;
    }
    case "rebuild": {
      const payload = await memoryService.withRoomLock(roomId, async () => {
        const startedAt = Date.now();
        const snapshot = memoryService.rebuildSnapshot(roomId);
        const durationMs = Date.now() - startedAt;
        const processed = store.listMemoryEvents(roomId).length;
        return {
          processed,
          deduped: 0,
          snapshot_version: snapshot?.reducerVersion ?? 1,
          duration_ms: durationMs,
        };
      });
      console.log(`Memory rebuild: ${JSON.stringify(payload)}`);
      return true;
    }
    case "render": {
      try {
        const content = memoryService.renderToFile(roomId) ?? memoryService.renderMarkdown(roomId);
        console.log(content);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`Failed to render memory file: ${reason}`);
        try {
          console.log(memoryService.renderMarkdown(roomId));
        } catch (fallbackError) {
          const fallbackReason = fallbackError instanceof Error
            ? fallbackError.message
            : String(fallbackError);
          console.error(`Failed to render memory snapshot: ${fallbackReason}`);
        }
      }
      return true;
    }
    default:
      console.log("Usage: /memory <show|decision|note|log|rebuild|render> ...");
      return true;
  }
};

interface WorktreeCreateArgs {
  agent: string;
  json: boolean;
}

interface WorktreeRemoveArgs {
  agent: string;
  force: boolean;
  json: boolean;
}

const parseWorktreeCreateArgs = (args: string[]): WorktreeCreateArgs | null => {
  if (args.length === 0) {
    return null;
  }
  const [agent, ...rest] = args;
  const normalizedAgent = normalizeWorktreeAgentName(agent ?? "");
  if (!normalizedAgent || agent?.startsWith("--") || !isValidWorktreeAgentName(normalizedAgent)) {
    return null;
  }
  if (rest.length === 0) {
    return { agent: normalizedAgent, json: false };
  }
  if (rest.length === 1 && rest[0] === "--json") {
    return { agent: normalizedAgent, json: true };
  }
  return null;
};

const parseWorktreeRemoveArgs = (args: string[]): WorktreeRemoveArgs | null => {
  if (args.length === 0) {
    return null;
  }

  const [agent, ...rest] = args;
  const normalizedAgent = normalizeWorktreeAgentName(agent ?? "");
  if (!normalizedAgent || agent?.startsWith("--") || !isValidWorktreeAgentName(normalizedAgent)) {
    return null;
  }

  let force = false;
  let json = false;
  for (const token of rest) {
    if (token === "--force") {
      force = true;
      continue;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    return null;
  }

  return { agent: normalizedAgent, force, json };
};

const parseWorktreeListArgs = (args: string[]): { json: boolean } | null => {
  if (args.length === 0) {
    return { json: false };
  }
  if (args.length === 1 && args[0] === "--json") {
    return { json: true };
  }
  return null;
};

const handleWorktreeCommand = async (
  args: string[],
  engine: ChatEngine,
  config: ChatRuntimeConfig,
  worktreeManager: WorktreeManager,
  memoryService: MemoryService,
): Promise<boolean> => {
  const [subcommand, ...rest] = args;
  const roomId = engine.getState().room.id;

  switch (subcommand) {
    case "list": {
      const parsed = parseWorktreeListArgs(rest);
      if (!parsed) {
        console.log("Usage: /worktree list [--json]");
        return true;
      }
      const items = worktreeManager.list();
      if (parsed.json) {
        console.log(JSON.stringify(items, null, 2));
        return true;
      }
      if (items.length === 0) {
        console.log("No worktrees.");
        return true;
      }
      console.log("agent\tpath\tbranch\thead");
      for (const item of items) {
        console.log(`${item.agent}\t${item.path}\t${item.branch}\t${item.head}`);
      }
      return true;
    }
    case "status": {
      const parsed = parseWorktreeListArgs(rest);
      if (!parsed) {
        console.log("Usage: /worktree status [--json]");
        return true;
      }
      const items = worktreeManager.status();
      if (parsed.json) {
        console.log(JSON.stringify(items, null, 2));
        return true;
      }
      if (items.length === 0) {
        console.log("No worktrees.");
        return true;
      }
      console.log("agent\tdirty\tahead\tbehind\tpath");
      for (const item of items) {
        const ahead = item.ahead == null ? "?" : String(item.ahead);
        const behind = item.behind == null ? "?" : String(item.behind);
        console.log(
          `${item.agent}\t${item.dirty ? "yes" : "no"}\t${ahead}\t${behind}\t${item.path}`,
        );
        if (item.syncUnavailable) {
          console.log(`  sync unavailable: ${item.syncUnavailable}`);
        }
      }
      return true;
    }
    case "create": {
      const parsed = parseWorktreeCreateArgs(rest);
      if (!parsed) {
        console.log("Usage: /worktree create <agent> [--json]");
        return true;
      }
      const info = worktreeManager.create(parsed.agent);
      memoryService.recordWorktreeCreate(roomId, parsed.agent, info.path, info.branch);
      if (parsed.json) {
        console.log(JSON.stringify(info, null, 2));
      } else {
        console.log(
          `Worktree created for ${parsed.agent}: ${info.path} (branch=${info.branch})`,
        );
      }
      return true;
    }
    case "remove": {
      const parsed = parseWorktreeRemoveArgs(rest);
      if (!parsed) {
        console.log("Usage: /worktree remove <agent> [--force] [--json]");
        return true;
      }
      const existing = worktreeManager.getForAgent(parsed.agent);
      if (!existing) {
        console.log(`Worktree for ${parsed.agent} not found.`);
        return true;
      }
      try {
        worktreeManager.remove(parsed.agent, parsed.force);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(message);
        return true;
      }
      const adapterConfig = config.adapterConfig[parsed.agent];
      if (adapterConfig?.workspaceCwd === existing.path) {
        const { workspaceCwd: _workspaceCwd, ...restConfig } = adapterConfig;
        config.adapterConfig[parsed.agent] = restConfig;
      }
      memoryService.recordWorktreeRemove(roomId, parsed.agent, existing.path);
      if (parsed.json) {
        console.log(JSON.stringify({ removed: true, ...existing }, null, 2));
      } else {
        console.log(`Worktree removed for ${parsed.agent}: ${existing.path}`);
      }
      return true;
    }
    default:
      console.log("Usage: /worktree <list|create|remove|status> ...");
      return true;
  }
};

const parseWorkspaceArgs = (
  args: string[],
): { subcommand: "show" | "full"; json: boolean } | null => {
  const [subcommand = "show", ...rest] = args;
  if (subcommand !== "show" && subcommand !== "full") {
    return null;
  }
  if (rest.length === 0) {
    return { subcommand, json: false };
  }
  if (rest.length === 1 && rest[0] === "--json") {
    return { subcommand, json: true };
  }
  return null;
};

const handleWorkspaceCommand = async (
  args: string[],
  config: ChatRuntimeConfig,
): Promise<boolean> => {
  const parsed = parseWorkspaceArgs(args);
  if (!parsed) {
    console.log("Usage: /workspace <show|full> [--json]");
    return true;
  }

  const collector = new WorkspaceCollector(config.workspace);
  const cwd = process.cwd();
  const alwaysOn = collector.collectAlwaysOn(cwd);

  if (parsed.subcommand === "show") {
    if (parsed.json) {
      console.log(JSON.stringify(alwaysOn, null, 2));
    } else {
      console.log(collector.format(alwaysOn));
    }
    return true;
  }

  const onDemand = collector.collectOnDemand(cwd);
  if (parsed.json) {
    console.log(JSON.stringify({ alwaysOn, onDemand }, null, 2));
  } else {
    console.log(collector.formatFull(alwaysOn, onDemand));
  }
  return true;
};

const parseTeamStartArgs = (
  args: string[],
): { goal: string; strict?: boolean; checksEnabled?: boolean } | null => {
  let strict: boolean | undefined;
  let checksEnabled: boolean | undefined;
  const goalParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === "--strict") {
      strict = true;
      continue;
    }
    if (token === "--no-checks") {
      checksEnabled = false;
      continue;
    }
    goalParts.push(token);
  }

  const goal = goalParts.join(" ").trim();
  if (!goal) {
    return null;
  }

  return { goal, strict, checksEnabled };
};

interface AdapterRenderState {
  lineOpen: boolean;
  sawContent: boolean;
  pendingSessionId: string | null;
  lastSessionId: string | null;
  insideSystemReminder: boolean;
  prefixPrinted: boolean;
  currentStatusText: string;
  spinner: Ora | null;
}

const adapterRenderStates = new Map<string, AdapterRenderState>();

const getAdapterRenderState = (adapterName: string): AdapterRenderState => {
  const existing = adapterRenderStates.get(adapterName);
  if (existing) {
    return existing;
  }
  const created: AdapterRenderState = {
    lineOpen: false,
    sawContent: false,
    pendingSessionId: null,
    lastSessionId: null,
    insideSystemReminder: false,
    prefixPrinted: false,
    currentStatusText: "generating...",
    spinner: null,
  };
  adapterRenderStates.set(adapterName, created);
  return created;
};

const renderAdapterEvent = (
  adapterName: string,
  event: AdapterEvent,
  resolveMode: () => OrchestrationMode = () => "manual",
): void => {
  const state = getAdapterRenderState(adapterName);
  switch (event.type) {
    case "message.started": {
      stopAdapterSpinner(state);
      state.lineOpen = true;
      state.sawContent = false;
      state.pendingSessionId = null;
      state.insideSystemReminder = false;
      state.prefixPrinted = false;
      state.currentStatusText = "generating...";
      if (renderOptions.richUi) {
        if (shouldShowSystemLines()) {
          ensureCursorHidden();
          state.spinner = ora({
            stream: output,
            text: `${formatStatusLabel(adapterName)} ${state.currentStatusText}`,
            discardStdin: false,
          }).start();
        }
        return;
      }
      if (shouldShowSystemLines()) {
        output.write(`\n[${adapterName}] generating...\n`);
      } else {
        output.write("\n");
      }
      output.write(`${adapterName}: `);
      state.prefixPrinted = true;
      return;
    }
    case "message.delta": {
      const { text, statusText } = sanitizeRenderedDelta(
        extractPayloadText(event.payload),
        state,
        resolveMode(),
      );
      if (statusText) {
        updateAdapterLiveStatus(adapterName, state, statusText);
      }
      if (text) {
        if (!state.prefixPrinted) {
          persistAdapterGeneratingStatus(adapterName, state);
          output.write(`\n${formatAdapterName(adapterName)}: `);
          state.prefixPrinted = true;
        }
        state.sawContent = true;
        output.write(text);
      }
      return;
    }
    case "session.bound": {
      const payload = event.payload as { nativeSessionId?: string };
      const nativeSessionId = payload.nativeSessionId;
      if (!nativeSessionId) {
        return;
      }

      if (!shouldShowSystemLines()) {
        state.lastSessionId = nativeSessionId;
        return;
      }

      if (state.lineOpen && state.sawContent) {
        // Defer non-text status to avoid interrupting streamed answer text.
        state.pendingSessionId = nativeSessionId;
        return;
      }

      const label = describeSessionBinding(state.lastSessionId, nativeSessionId);
      state.lastSessionId = nativeSessionId;
      const renderedStatus = `${formatStatusLabel(adapterName)} ${label} (${formatSessionId(
        nativeSessionId,
      )})`;
      state.currentStatusText = `${label} (${formatSessionId(nativeSessionId)})`;

      if (state.spinner?.isSpinning) {
        state.spinner.text = renderedStatus;
        return;
      }

      if (state.lineOpen && !state.sawContent) {
        output.write(`\n${renderedStatus}\n${formatAdapterName(adapterName)}: `);
        state.prefixPrinted = true;
        return;
      }

      output.write(`\n${renderedStatus}\n`);
      return;
    }
    case "message.completed": {
      stopAdapterSpinner(state);
      if (state.lineOpen && state.prefixPrinted) {
        output.write("\n");
      }
      if (state.pendingSessionId) {
        const label = describeSessionBinding(state.lastSessionId, state.pendingSessionId);
        state.lastSessionId = state.pendingSessionId;
        output.write(`${formatStatusLabel(adapterName)} ${label} (${formatSessionId(state.pendingSessionId)})\n`);
        state.pendingSessionId = null;
      }
      state.lineOpen = false;
      state.sawContent = false;
      state.insideSystemReminder = false;
      state.prefixPrinted = false;
      state.currentStatusText = "generating...";
      if (shouldShowSystemLines()) {
        output.write(`${formatStatusLabel(adapterName)} done\n`);
        output.write("\n");
      }
      return;
    }
    case "message.error": {
      stopAdapterSpinner(state);
      const payload = event.payload as { class?: string; message?: string };
      if (state.lineOpen && state.prefixPrinted) {
        output.write("\n");
      }
      if (state.pendingSessionId) {
        const label = describeSessionBinding(state.lastSessionId, state.pendingSessionId);
        state.lastSessionId = state.pendingSessionId;
        if (shouldShowSystemLines()) {
          output.write(`${formatStatusLabel(adapterName)} ${label} (${formatSessionId(state.pendingSessionId)})\n`);
        }
        state.pendingSessionId = null;
      }
      state.lineOpen = false;
      state.sawContent = false;
      state.insideSystemReminder = false;
      state.prefixPrinted = false;
      state.currentStatusText = "generating...";
      output.write(
        `\n${formatErrorText(`${adapterName} error (${payload.class ?? "UNKNOWN"}): ${
          payload.message ?? "unknown"
        }`)}\n`,
      );
      return;
    }
    default:
      return;
  }
};

const stopAdapterSpinner = (state: AdapterRenderState): void => {
  if (!state.spinner) {
    return;
  }
  if (state.spinner.isSpinning) {
    state.spinner.stop();
  }
  state.spinner = null;
};

const persistAdapterGeneratingStatus = (
  adapterName: string,
  state: AdapterRenderState,
): void => {
  if (!state.spinner) {
    return;
  }
  if (state.spinner.isSpinning) {
    if (shouldShowSystemLines()) {
      state.spinner.stopAndPersist({
        symbol: colorize("●", pc.cyan),
        text: `${formatStatusLabel(adapterName)} ${state.currentStatusText}`,
      });
    } else {
      state.spinner.stop();
    }
  }
  state.spinner = null;
};

const updateAdapterLiveStatus = (
  adapterName: string,
  state: AdapterRenderState,
  statusText: string,
): void => {
  const normalized = normalizeStatusText(statusText);
  if (!normalized) {
    return;
  }

  state.currentStatusText = normalized;
  if (state.spinner?.isSpinning && shouldShowSystemLines()) {
    state.spinner.text = `${formatStatusLabel(adapterName)} ${normalized}`;
  }
};

const normalizeMode = (value?: string): OrchestrationMode | null => {
  if (!value) {
    return null;
  }
  if ((MODES as string[]).includes(value)) {
    return value as OrchestrationMode;
  }
  return null;
};

const getSlashCommandSuggestions = (
  query: string,
  limit = 8,
): SlashCommandHint[] => {
  const normalized = query.trim().toLowerCase();
  if (!normalized || normalized === "/") {
    return SLASH_COMMAND_HINTS.slice(0, limit);
  }

  const prefixed = normalized.startsWith("/") ? normalized : `/${normalized}`;
  const prefixMatches = SLASH_COMMAND_HINTS.filter(({ command }) =>
    command.startsWith(prefixed),
  );
  if (prefixMatches.length > 0) {
    return prefixMatches.slice(0, limit);
  }

  const containsNeedle = prefixed.slice(1);
  const containsMatches = SLASH_COMMAND_HINTS.filter(({ command }) =>
    command.includes(containsNeedle),
  );
  return containsMatches.slice(0, limit);
};

const printSlashCommandSuggestions = (query: string): void => {
  const suggestions = getSlashCommandSuggestions(query, 10);
  if (suggestions.length === 0) {
    console.log(formatWarnLine("No matching slash commands."));
    console.log(formatHintLine("Use /help to list available commands."));
    return;
  }

  const title =
    query === "/"
      ? "Slash commands:"
      : `Slash command suggestions for "${query}":`;
  console.log(title);
  for (const entry of suggestions) {
    console.log(`- ${entry.command}  ${entry.description}`);
  }
};

const promoteCliAdaptersToAgentic = (config: ChatRuntimeConfig): string[] => {
  const promoted: string[] = [];
  for (const agent of config.agents) {
    const entry = config.adapterConfig[agent];
    if (!entry || entry.mode !== "cli") {
      continue;
    }
    config.adapterConfig[agent] = {
      ...entry,
      mode: "agentic",
    };
    promoted.push(agent);
  }
  return promoted;
};

const interruptActiveTeamRun = async (engine: ChatEngine): Promise<string | null> => {
  if (escInterruptInFlight) {
    return null;
  }
  const status = engine.teamStatus();
  if (!status || status.run.status !== "active") {
    return null;
  }

  escInterruptInFlight = true;
  try {
    const result = await engine.interruptTeamRun();
    if (!result) {
      return null;
    }
    if (result.interrupted) {
      return formatWarnLine(`[team] Interrupted run ${result.run.id}. Add correction and press Enter.`);
    }
    return formatInfoLine(`[team] No active step to interrupt for run ${result.run.id}.`);
  } finally {
    escInterruptInFlight = false;
  }
};

const printVersion = (write: OutputWriter = console.log): void => {
  write(`agoryx ${APP_VERSION}`);
};

const printUsage = (write: OutputWriter = console.log): void => {
  const title = "agoryx — local-first multi-agent CLI chat orchestrator";
  write([
    title,
    "",
    "Usage:",
    "  agoryx [chat] [options]",
    "  agoryx sessions <list|export> [options]",
    "  agoryx config explain [--config <path>] [--db <path>]",
    "  agoryx completion <bash|zsh|fish>",
    "  agoryx man",
    "",
    "Commands:",
    "  chat         Start interactive/non-interactive chat (default command)",
    "  sessions     List and export saved sessions",
    "  config       Explain resolved configuration and path precedence",
    "  completion   Print shell completion script",
    "  man          Print manual page",
    "  help         Show command help",
    "",
    "Global options:",
    "  -h, --help      Show this help message and exit",
    "  -V, --version   Print version and exit",
    "",
    "Quick start:",
    "  agoryx                        Start chat in manual mode (default)",
    "  agoryx -m auto                Start chat with smart routing",
    "  agoryx --mode team            Start autonomous team runtime",
    "",
    "Examples:",
    "  agoryx sessions list          List recent sessions",
    "  agoryx config explain         Show resolved paths and config",
    "",
    "Notes:",
    "  Config precedence: flags > env > config file > defaults",
    "  Default config: $XDG_CONFIG_HOME/agoryx/config.json",
    "  Default DB: $XDG_STATE_HOME/agoryx/agoryx.db",
    "",
    "Report bugs: https://github.com/nulfranchise/agoryx/issues",
  ].join("\n"));
};

const printChatUsage = (write: OutputWriter = console.log): void => {
  write([
    "Start an interactive chat session with AI agents.",
    "",
    "Usage:",
    "  agoryx chat [options]",
    "  agoryx [options]",
    "",
    "Options:",
    "  -h, --help                    Show this help message and exit",
    "  --agents <name,...>           Comma-separated agent list (default: codex,claude)",
    "  -m, --mode <mode>            Orchestration mode: manual, round-robin, auto, team",
    "                                (default: manual)",
    "  -c, --config <path>          Path to config file",
    "                                (default: $XDG_CONFIG_HOME/agoryx/config.json)",
    "  --db <path>                   Path to SQLite database",
    "  --adapter-mode <mode>         Adapter transport: stub, cli, persistent, agentic",
    "  --quiet-system                Hide system status messages during chat",
    "  --plain-ui                    Disable rich TUI (spinners, cursor control)",
    "  --no-color                    Disable color output (also: NO_COLOR env var)",
    "  --resume <room_id>            Resume a previous session by room ID",
    "  --room-name <name>            Set room display name (default: Agoryx Room)",
    "",
    "Examples:",
    "  agoryx                        Start chat in manual mode",
    "  agoryx -m auto                Smart routing — auto-selects best agent",
    "  agoryx --mode team            Autonomous team runtime with proposal gate",
    "  agoryx --resume abc123        Resume session abc123",
    "  agoryx --agents codex         Chat with Codex only",
    "  echo 'hello' | agoryx        Pipe input for non-interactive use",
  ].join("\n"));
};

const printSessionsUsage = (write: OutputWriter = console.log): void => {
  write([
    "List and export saved chat sessions.",
    "",
    "Usage:",
    "  agoryx sessions list [options]",
    "  agoryx sessions export <room_or_session_id> [options]",
    "",
    "Subcommands:",
    "  list         List recent sessions (tab-separated)",
    "  export       Export one session in markdown or json",
    "",
    "Examples:",
    "  agoryx sessions list",
    "  agoryx sessions list --limit 5",
    "  agoryx sessions export abc123 --format json --out ./export.json",
  ].join("\n"));
};

const printSessionsListUsage = (write: OutputWriter = console.log): void => {
  write([
    "List recent chat sessions.",
    "",
    "Usage:",
    "  agoryx sessions list [--limit <n>] [--db <path>] [--config <path>]",
    "",
    "Options:",
    "  -h, --help           Show this help message and exit",
    "  --limit <n>          Maximum number of sessions to show (default: 20)",
    "  --db <path>          Path to SQLite database",
    "  --config <path>      Path to config file",
  ].join("\n"));
};

const printSessionsExportUsage = (write: OutputWriter = console.log): void => {
  write([
    "Export a chat session to markdown or json.",
    "",
    "Usage:",
    "  agoryx sessions export <room_or_session_id> [options]",
    "",
    "Options:",
    "  -h, --help                Show this help message and exit",
    "  --format <markdown|json>  Output format (default: markdown)",
    "  --out <file>              Write to file instead of stdout",
    "  --db <path>               Path to SQLite database",
    "  --config <path>           Path to config file",
  ].join("\n"));
};

const printConfigUsage = (write: OutputWriter = console.log): void => {
  write([
    "Show resolved configuration paths and precedence.",
    "",
    "Usage:",
    "  agoryx config explain [--config <path>] [--db <path>]",
    "",
    "Options:",
    "  -h, --help           Show this help message and exit",
    "  --config <path>      Path to config file",
    "  --db <path>          Path to SQLite database",
  ].join("\n"));
};

const printCompletionUsage = (write: OutputWriter = console.log): void => {
  write([
    "Print shell completion script to stdout.",
    "",
    "Usage:",
    "  agoryx completion <bash|zsh|fish>",
    "",
    "Options:",
    "  -h, --help           Show this help message and exit",
    "",
    "Examples:",
    "  agoryx completion bash >> ~/.bashrc",
    "  agoryx completion zsh > ~/.zsh/completions/_agoryx",
    "  agoryx completion fish > ~/.config/fish/completions/agoryx.fish",
  ].join("\n"));
};

const printManPage = (write: OutputWriter = console.log): void => {
  write([
    "AGORYX(1)",
    "",
    "NAME",
    "  agoryx - local-first multi-agent CLI chat orchestrator",
    "",
    "SYNOPSIS",
    "  agoryx [chat] [chat-options]",
    "  agoryx sessions <list|export> [options]",
    "  agoryx config explain [--config <path>] [--db <path>]",
    "  agoryx completion <bash|zsh|fish>",
    "",
    "DESCRIPTION",
    "  Agoryx runs Codex and Claude in one shared local session with SQLite persistence.",
    "",
    "FILES",
    "  $XDG_CONFIG_HOME/agoryx/config.json",
    "  $XDG_STATE_HOME/agoryx/agoryx.db",
    "",
    "SEE ALSO",
    "  agoryx --help",
    "  agoryx chat --help",
    "  agoryx sessions --help",
  ].join("\n"));
};

const printChatHelp = (): void => {
  console.log(`
In-chat commands:
  /               list slash commands
  /help
  /mode <manual|round-robin|auto|team>
  /status
  /adapter <codex|claude> <stub|cli|persistent|agentic>
  @team <goal>                      start a team run (from any mode)
  /team start <goal> [--strict] [--no-checks]
  /team status
  /team log [limit]
  /team resume
  /team approve [run_id]
  /team interrupt [feedback]
  /team stop
  /pin <label>: <content>
  /unpin <pin_id>
  /pins [list]
  /summary
  /checkpoint
  /history [count]
  /memory [show]
  /memory decision <text>
  /memory note <text>
  /memory log [--source <source>] [--type <event_type>] [--since <iso>] [--limit <n>] [--json]
  /memory rebuild
  /memory render
  /worktree list [--json]
  /worktree create <agent> [--json]
  /worktree remove <agent> [--force] [--json]
  /worktree status [--json]
  /workspace show [--json]
  /workspace full [--json]
  /retry @codex
  /export [markdown|json] [--out <file>]
  Esc (TTY, team mode): interrupt active team step
  /quit

Slash tips:
  Press / on an empty prompt to open interactive command picker (TTY).
  Type / and press Tab to autocomplete commands.
  Enter / to print available slash commands.
`);
};

const printBanner = (
  roomId: string,
  sessionId: string,
  mode: OrchestrationMode,
  agents: string[],
  adapterConfig: ChatRuntimeConfig["adapterConfig"],
): void => {
  console.log(colorize(`Agoryx v${APP_VERSION}`, pc.bold));
  console.log(`${formatInfoLabel("Room:")} ${roomId}`);
  console.log(`${formatInfoLabel("Session:")} ${sessionId}`);
  console.log(`${formatInfoLabel("Mode:")} ${mode}`);
  console.log(`${formatInfoLabel("Agents:")} ${agents.join(", ")}`);
  for (const agent of agents) {
    console.log(
      `${formatInfoLabel("-")} ${formatAdapterName(agent)}: mode=${adapterConfig[agent]?.mode ?? "stub"}`,
    );
  }
  console.log(`${formatInfoLabel("Type /help for commands.")}\n`);
};

const normalizeDbPath = (dbPath: string): string => {
  const normalized = dbPath.trim();
  const lowered = normalized.toLowerCase();
  if (lowered === ":memory:" || lowered.startsWith("file::memory:")) {
    return normalized;
  }
  if (!lowered.startsWith("file:")) {
    return normalized;
  }

  // Preserve SQLite URI forms (for example file:relative.db?mode=memory) as-is.
  if (normalized.includes("?") || normalized.includes("#")) {
    return normalized;
  }

  // Convert absolute file URLs to filesystem paths so directory preparation works.
  if (!(normalized.startsWith("file:/") || normalized.startsWith("file://"))) {
    return normalized;
  }

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol === "file:") {
      return fileURLToPath(parsed);
    }
  } catch {
    // Keep the original value when it is not a valid file URI.
  }
  return normalized;
};

const resolveDbPathForPreparation = (dbPath: string): string | null => {
  const normalized = normalizeDbPath(dbPath);
  const lowered = normalized.toLowerCase();
  if (lowered === ":memory:" || lowered.startsWith("file::memory:")) {
    return null;
  }
  if (!lowered.startsWith("file:")) {
    return normalized;
  }

  const queryIndex = normalized.indexOf("?");
  if (queryIndex >= 0) {
    const hashIndex = normalized.indexOf("#", queryIndex + 1);
    const query = normalized.slice(queryIndex + 1, hashIndex >= 0 ? hashIndex : undefined);
    const mode = new URLSearchParams(query).get("mode")?.toLowerCase();
    if (mode === "memory") {
      return null;
    }
  }

  const withoutPrefix = normalized.slice("file:".length);
  const cutIndex = withoutPrefix.search(/[?#]/);
  const pathPart = cutIndex >= 0 ? withoutPrefix.slice(0, cutIndex) : withoutPrefix;
  if (!pathPart) {
    return null;
  }

  if (pathPart.startsWith("/") || pathPart.startsWith("//")) {
    try {
      const parsed = new URL(normalized);
      if (parsed.protocol === "file:") {
        const withoutQuery = new URL(parsed.toString());
        withoutQuery.search = "";
        withoutQuery.hash = "";
        return fileURLToPath(withoutQuery);
      }
    } catch {
      // Fall through to return path part as-is.
    }
    return pathPart;
  }

  try {
    return decodeURIComponent(pathPart);
  } catch {
    return pathPart;
  }
};

interface ParsedArgs {
  options: Record<string, string>;
  positionals: string[];
}

const ensureDbPathReady = (dbPath: string): void => {
  const fsPath = resolveDbPathForPreparation(dbPath);
  if (!fsPath) {
    return;
  }
  ensureParentDirectory(fsPath);
};

const parseCliArgs = (args: string[], specs: OptionSpec[]): ParsedArgs => {
  const options: Record<string, string> = {};
  const positionals: string[] = [];
  const byLong = new Map(specs.map((spec) => [spec.long, spec] as const));
  const byShort = new Map(
    specs
      .filter((spec): spec is OptionSpec & { short: string } => Boolean(spec.short))
      .map((spec) => [spec.short, spec] as const),
  );

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token) {
      continue;
    }

    if (token === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }

    if (token.startsWith("--")) {
      const withoutPrefix = token.slice(2);
      const equalIndex = withoutPrefix.indexOf("=");
      const key = equalIndex >= 0 ? withoutPrefix.slice(0, equalIndex) : withoutPrefix;
      const inlineValue = equalIndex >= 0 ? withoutPrefix.slice(equalIndex + 1) : undefined;
      const spec = byLong.get(key);
      if (!spec) {
        throw new CliUsageError(
          renderUnknownOptionMessage(`--${key}`, specs),
          undefined,
          "Run with --help to see available options.",
        );
      }

      if (spec.takesValue) {
        if (inlineValue != null) {
          options[spec.long] = inlineValue;
          continue;
        }

        const next = args[i + 1];
        if (next == null || (next !== "-" && next.startsWith("-"))) {
          throw new CliUsageError(
            `Option --${spec.long} requires a value.`,
            undefined,
            `Provide a value, for example: --${spec.long} <value>.`,
          );
        }
        options[spec.long] = next;
        i += 1;
        continue;
      }

      if (inlineValue != null) {
        throw new CliUsageError(
          `Option --${spec.long} does not take a value.`,
          undefined,
          `Remove the value and pass only --${spec.long}.`,
        );
      }
      options[spec.long] = "true";
      continue;
    }

    if (token.startsWith("-") && token !== "-") {
      const short = token.slice(1);
      if (short.length !== 1) {
        throw new CliUsageError(
          renderUnknownOptionMessage(token, specs),
          undefined,
          "Run with --help to see available options.",
        );
      }
      const spec = byShort.get(short);
      if (!spec) {
        throw new CliUsageError(
          renderUnknownOptionMessage(token, specs),
          undefined,
          "Run with --help to see available options.",
        );
      }
      if (spec.takesValue) {
        const next = args[i + 1];
        if (next == null || (next !== "-" && next.startsWith("-"))) {
          throw new CliUsageError(
            `Option -${short} requires a value.`,
            undefined,
            `Provide a value, for example: -${short} <value>.`,
          );
        }
        options[spec.long] = next;
        i += 1;
      } else {
        options[spec.long] = "true";
      }
      continue;
    }

    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
  }
  return { options, positionals };
};

const parseCliArgsOrThrow = (
  args: string[],
  specs: OptionSpec[],
  usage: (write?: OutputWriter) => void,
): ParsedArgs => {
  try {
    return parseCliArgs(args, specs);
  } catch (error) {
    if (error instanceof CliUsageError) {
      throw new CliUsageError(error.message, usage, error.hint);
    }
    throw error;
  }
};

const levenshteinDistance = (left: string, right: string): number => {
  const matrix = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let i = 0; i <= left.length; i += 1) {
    matrix[i][0] = i;
  }
  for (let j = 0; j <= right.length; j += 1) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[left.length][right.length];
};

const renderUnknownOptionMessage = (token: string, specs: OptionSpec[]): string => {
  const candidates = specs.flatMap((spec) => [
    `--${spec.long}`,
    ...(spec.short ? [`-${spec.short}`] : []),
  ]);
  let bestCandidate: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = levenshteinDistance(token, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestCandidate = candidate;
    }
  }

  if (bestCandidate && bestDistance <= 3) {
    return `Unknown option '${token}'. Did you mean '${bestCandidate}'?`;
  }
  return `Unknown option '${token}'.`;
};

const renderUnknownCommandMessage = (command: string): string => {
  let bestCandidate: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of ROOT_COMMANDS) {
    const distance = levenshteinDistance(command, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestCandidate = candidate;
    }
  }

  if (bestCandidate && bestDistance <= 3) {
    return `Unknown command '${command}'. Did you mean '${bestCandidate}'?`;
  }
  return `Unknown command '${command}'.`;
};

const renderBashCompletion = (): string => `# bash completion for agoryx
_agoryx_complete() {
  local cur prev words cword
  _init_completion || return

  local commands="chat sessions config completion man help"
  if [[ $cword -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "$commands --help --version" -- "$cur") )
    return
  fi

  case "\${words[1]}" in
    sessions)
      COMPREPLY=( $(compgen -W "list export --help" -- "$cur") )
      ;;
    config)
      COMPREPLY=( $(compgen -W "explain --help --config --db" -- "$cur") )
      ;;
    completion)
      COMPREPLY=( $(compgen -W "bash zsh fish --help" -- "$cur") )
      ;;
    chat|"")
      COMPREPLY=( $(compgen -W "--help --agents --mode --config --db --adapter-mode --quiet-system --plain-ui --no-color --resume --room-name" -- "$cur") )
      ;;
    *)
      COMPREPLY=()
      ;;
  esac
}
complete -F _agoryx_complete agoryx`;

const renderZshCompletion = (): string => `#compdef agoryx
_agoryx() {
  local -a commands
  commands=(
    'chat:Start chat'
    'sessions:Session management'
    'config:Configuration diagnostics'
    'completion:Shell completion'
    'man:Manual page'
    'help:Help'
  )

  _arguments -C \\
    '(-h --help)'{-h,--help}'[Show help]' \\
    '(-V --version)'{-V,--version}'[Show version]' \\
    '1:command:->command' \\
    '*::args:->args'

  case $state in
    command)
      _describe -t commands 'agoryx command' commands
      ;;
    args)
      case $words[2] in
        sessions)
          _values 'sessions subcommand' list export
          ;;
        completion)
          _values 'shell' bash zsh fish
          ;;
      esac
      ;;
  esac
}
_agoryx "$@"`;

const renderFishCompletion = (): string => `# fish completion for agoryx
complete -c agoryx -f -n '__fish_use_subcommand' -a "chat sessions config completion man help"
complete -c agoryx -l help -s h -d "Show help"
complete -c agoryx -l version -s V -d "Show version"
complete -c agoryx -n '__fish_seen_subcommand_from completion' -a "bash zsh fish"
complete -c agoryx -n '__fish_seen_subcommand_from sessions' -a "list export"
complete -c agoryx -n '__fish_seen_subcommand_from chat' -l agents -r
complete -c agoryx -n '__fish_seen_subcommand_from chat' -l mode -r
complete -c agoryx -n '__fish_seen_subcommand_from chat' -l db -r
complete -c agoryx -n '__fish_seen_subcommand_from chat' -l config -r
complete -c agoryx -n '__fish_seen_subcommand_from sessions' -l limit -r
complete -c agoryx -n '__fish_seen_subcommand_from sessions' -l format -r
complete -c agoryx -n '__fish_seen_subcommand_from sessions' -l out -r`;

const printCliUsageError = (error: CliUsageError): void => {
  console.error(formatUsageErrorLine(error.message));
  if (error.hint) {
    console.error(formatHintLine(error.hint));
  } else {
    console.error(formatHintLine("Use --help to see valid commands and options."));
  }
  if (error.usage) {
    console.error("");
    error.usage(console.error);
  }
};

main().catch((error) => {
  if (error instanceof CliUsageError) {
    printCliUsageError(error);
    process.exit(error.exitCode);
  }

  console.error(
    formatUsageErrorLine(error instanceof Error ? error.message : String(error)),
  );
  process.exit(1);
});
