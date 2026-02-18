import process from "node:process";
import readline from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { writeFileSync } from "node:fs";
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
import type { ChatRuntimeConfig } from "../../internal/config/default.js";
import { loadConfig, toRuntimeConfig } from "../../internal/config/index.js";
import { ChatEngine } from "../../internal/engine/chat.js";
import type { AdapterEvent } from "../../internal/adapters/adapter.js";
import type { OrchestrationMode } from "../../internal/events/types.js";
import { SessionService } from "../../internal/session/service.js";
import { SQLiteStore } from "../../internal/storage/sqlite.js";

const MODES: OrchestrationMode[] = ["manual", "round-robin", "auto", "team"];

interface RenderOptions {
  richUi: boolean;
  hideSystem: boolean;
  color: boolean;
}

const renderOptions: RenderOptions = {
  richUi: output.isTTY,
  hideSystem: false,
  color: output.isTTY && process.env.NO_COLOR !== "1",
};

let cursorHidden = false;
let escInterruptInFlight = false;

function isEnabledFlag(value?: string): boolean {
  if (!value) {
    return false;
  }
  return value === "true" || value === "1";
}

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
  }
  if (cursorHidden) {
    cliCursor.show(output);
    cursorHidden = false;
  }
}

async function main(): Promise<void> {
  const [, , command = "help", ...rest] = process.argv;
  switch (command) {
    case "help":
      printUsage();
      return;
    case "chat":
      await runChat(rest);
      return;
    case "sessions":
      runSessions(rest);
      return;
    default:
      printUsage();
      process.exit(1);
  }
}

const runChat = async (argv: string[]): Promise<void> => {
  const parsed = parseArgs(argv);
  const args = parsed.options;
  configureRenderOptions({
    richUi: output.isTTY && !isEnabledFlag(args["plain-ui"]),
    hideSystem: isEnabledFlag(args["quiet-system"]),
    color: output.isTTY && !isEnabledFlag(args["no-color"]) && process.env.NO_COLOR !== "1",
  });

  const cliAgents = args.agents
    ? args.agents
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
    : undefined;

  const loadedConfig = loadConfig(args.config);
  const runtimeConfig = toRuntimeConfig(loadedConfig, {
    roomName: args["room-name"] ?? "Agoryx Room",
    resumeRoomId: args.resume,
    agents: cliAgents,
  });

  const mode = normalizeMode(args.mode ?? runtimeConfig.mode);
  if (!mode) {
    throw new Error(`Invalid mode: ${args.mode ?? runtimeConfig.mode}`);
  }

  const config: ChatRuntimeConfig = {
    ...runtimeConfig,
    mode,
    roomConfig: {
      ...runtimeConfig.roomConfig,
      mode,
    },
    dbPath: args.db ?? runtimeConfig.dbPath,
  };

  config.agents = config.agents
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
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
  const session = new SessionService(store);
  const adapters = createAdapterRegistry();

  let engineRef: ChatEngine | null = null;
  const engine = new ChatEngine(session, adapters, config, {
    onAdapterEvent: (adapterName, event) => {
      renderAdapterEvent(
        adapterName,
        event,
        () => engineRef?.getState().room.config.mode ?? config.mode,
      );
    },
  });
  engineRef = engine;

  const initialized = engine.init();
  printBanner(
    initialized.room.id,
    initialized.sessionId,
    initialized.mode,
    config.agents,
    config.adapterConfig,
  );

  const rl = readline.createInterface({ input, output });
  const teardownEscHotkey = setupEscInterruptHotkey(engine);

  try {
    if (!input.isTTY) {
      for await (const rawLine of rl) {
        const shouldContinue = await processChatInputLine(rawLine, engine, config, store);
        if (!shouldContinue) {
          break;
        }
      }
      return;
    }

    while (true) {
      let rawLine: string;
      try {
        rawLine = await rl.question("> ");
      } catch (error) {
        if (isReadlineClosedError(error)) {
          break;
        }
        throw error;
      }

      const shouldContinue = await processChatInputLine(rawLine, engine, config, store);
      if (!shouldContinue) {
        break;
      }
    }
  } finally {
    teardownEscHotkey();
    rl.close();
    cleanupRenderState();
    await engine.shutdown();
    store.close();
  }
};

const processChatInputLine = async (
  rawLine: string,
  engine: ChatEngine,
  config: ChatRuntimeConfig,
  store: SQLiteStore,
): Promise<boolean> => {
  const line = rawLine.trim();
  if (!line) {
    return true;
  }

  if (line.startsWith("/")) {
    return handleCommand(line, engine, config, store);
  }

  const mode = engine.getState().room.config.mode;
  const teamStatusBefore = mode === "team" ? engine.teamStatus() : null;
  const activeRunBefore =
    teamStatusBefore?.run.status === "active" ? teamStatusBefore.run.id : null;
  if (mode === "team" && activeRunBefore) {
    const interrupted = await engine.interruptTeamRun(line, activeRunBefore);
    if (interrupted) {
      if (interrupted.interrupted) {
        console.log(`Team run interrupted: ${interrupted.run.id}. Feedback queued.`);
      } else {
        console.log(`Feedback queued for team run ${interrupted.run.id}.`);
      }
      return true;
    }
  }

  const results = await engine.processUserMessage(line);
  if (results.length === 0) {
    if (mode === "team") {
      const status = engine.teamStatus();
      if (status && !teamStatusBefore) {
        console.log(`Team run started: ${status.run.id}`);
      } else if (status?.run.status === "active") {
        console.log(`Feedback queued for team run ${status.run.id}.`);
      } else if (status?.run.status === "waiting_user_input") {
        console.log(`Team run ${status.run.id} is waiting for approval. Use /team approve.`);
      }
      return true;
    }

    console.log("No dispatch generated. In manual mode, mention an agent (e.g. @codex).");
    return true;
  }

  for (const result of results) {
    if (!result.success) {
      console.error(`[${result.adapter}] error: ${result.error ?? "unknown error"}`);
    }
  }

  return true;
};

const runSessions = (argv: string[]): void => {
  const parsed = parseArgs(argv);
  const options = parsed.options;
  const [subcommand, ...positionals] = parsed.positionals;
  const loadedConfig = loadConfig(options.config);
  const dbPath = options.db ?? loadedConfig.session.dbPath;
  const store = new SQLiteStore(dbPath);
  store.init();

  try {
    switch (subcommand) {
      case "list": {
        const parsedLimit = Number(options.limit ?? "20");
        const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 20;
        const sessions = store.listSessionRuns(limit);
        if (sessions.length === 0) {
          console.log("No sessions found.");
          return;
        }

        console.log("session_id\troom_id\troom_name\tcreated_at");
        for (const session of sessions) {
          console.log(
            `${session.id}\t${session.roomId}\t${session.roomName}\t${session.createdAt}`,
          );
        }
        return;
      }
      case "export": {
        const targetId = positionals[0];
        if (!targetId) {
          printSessionsUsage();
          process.exitCode = 1;
          return;
        }

        const format = options.format?.toLowerCase();
        if (format && format !== "markdown" && format !== "json") {
          throw new Error(`Unsupported export format: ${format}`);
        }

        const outputText = renderSessionExport(
          collectTargetExportData(store, targetId),
          format === "json" ? "json" : "markdown",
        );

        const outPath = options.out;
        if (outPath) {
          writeFileSync(outPath, outputText, "utf8");
          console.log(`Session export written to ${outPath}`);
          return;
        }

        console.log(outputText);
        return;
      }
      default:
        printSessionsUsage();
        process.exitCode = 1;
    }
  } finally {
    store.close();
  }
};

const handleCommand = async (
  line: string,
  engine: ChatEngine,
  config: ChatRuntimeConfig,
  store: SQLiteStore,
): Promise<boolean> => {
  const [command, ...rest] = line.split(/\s+/);
  switch (command) {
    case "/quit":
    case "/exit":
      return false;
    case "/help":
      printChatHelp();
      return true;
    case "/mode": {
      const target = normalizeMode(rest[0]);
      if (!target) {
        console.log("Usage: /mode <manual|round-robin|auto|team>");
        return true;
      }
      const promoted = target === "team" ? promoteCliAdaptersToAgentic(config) : [];
      engine.setMode(target);
      console.log(`Mode switched to: ${target}`);
      if (promoted.length > 0) {
        console.log(`Auto-switched adapters to agentic for team mode: ${promoted.join(", ")}`);
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
        console.log("Usage: /adapter <codex|claude> <stub|cli|persistent|agentic>");
        return true;
      }
      if (!config.adapterConfig[agent]) {
        console.log(`Unknown adapter: ${agent}`);
        return true;
      }
      config.adapterConfig[agent] = {
        ...config.adapterConfig[agent],
        mode,
      };
      console.log(`Adapter ${agent} switched to mode=${mode}`);
      return true;
    }
    case "/team": {
      return handleTeamCommand(rest, engine);
    }
    case "/pin": {
      const text = rest.join(" ").trim();
      if (!text) {
        console.log("Usage: /pin <label>: <content>");
        return true;
      }

      const [maybeLabel, ...contentParts] = text.split(":");
      const content = contentParts.join(":").trim();
      const label = content ? maybeLabel.trim() : `pin-${Date.now()}`;
      const resolvedContent = content || maybeLabel.trim();
      const id = engine.addPinnedContext(label, resolvedContent);
      console.log(`Pinned context created: ${id}`);
      return true;
    }
    case "/unpin": {
      const [pinId] = rest;
      if (!pinId) {
        console.log("Usage: /unpin <pin_id>");
        return true;
      }
      const removed = engine.removePinnedContext(pinId);
      console.log(removed ? `Removed pinned context ${pinId}` : `Pin ${pinId} not found`);
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
        console.log("No pinned context.");
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
        console.log("Not enough conversation history to create a checkpoint.");
      } else {
        console.log("Checkpoint created.");
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
        console.log("Usage: /retry @codex");
        return true;
      }
      const retry = await engine.retryFailed(target);
      if (!retry) {
        console.log(`No failed request found for ${target}.`);
      } else if (!retry.success) {
        console.error(
          `[${retry.adapter}] retry failed (${retry.failedRequestId} -> ${retry.requestId}): ${
            retry.error ?? "unknown error"
          }`,
        );
      } else {
        console.log(
          `[${retry.adapter}] retry succeeded (${retry.failedRequestId} -> ${retry.requestId})`,
        );
      }
      return true;
    }
    case "/export": {
      const parsed = parseExportCommandArgs(rest);
      if (!parsed) {
        console.log("Usage: /export [markdown|json] [--out <file>]");
        return true;
      }

      const state = engine.getState();
      const exportData = collectRoomExportData(store, state.room.id, state.sessionId);
      const outputText = renderSessionExport(exportData, parsed.format);
      if (parsed.outPath) {
        writeFileSync(parsed.outPath, outputText, "utf8");
        console.log(`Session export written to ${parsed.outPath}`);
      } else {
        console.log(outputText);
      }

      return true;
    }
    default:
      console.log(`Unknown command: ${command}. Use /help.`);
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
        console.log("Usage: /team start <goal> [--strict] [--no-checks]");
        return true;
      }

      try {
        const run = engine.startTeamRun(parsed.goal, {
          strict: parsed.strict,
          checksEnabled: parsed.checksEnabled,
        });
        console.log(`Team run started: ${run.id}`);
      } catch (error) {
        console.error(error instanceof Error ? error.message : "Failed to start team run.");
      }
      return true;
    }
    case "status": {
      const status = engine.teamStatus();
      if (!status) {
        console.log("No active team run.");
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
        console.log("No team run logs.");
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
        console.log("No resumable team run.");
      } else {
        console.log(`Team run resumed: ${run.id} (status=${run.status})`);
      }
      return true;
    }
    case "approve": {
      const run = engine.teamApprove(rest[0]);
      if (!run) {
        console.log("No waiting team run to approve.");
      } else {
        console.log(`Team run approved: ${run.id}`);
      }
      return true;
    }
    case "interrupt": {
      const feedback = rest.join(" ").trim();
      const result = await engine.interruptTeamRun(feedback || undefined);
      if (!result) {
        console.log("No active team run to interrupt.");
        return true;
      }
      if (result.interrupted) {
        if (result.feedbackQueued) {
          console.log(`Team run interrupted: ${result.run.id}. Feedback queued.`);
        } else {
          console.log(`Team run interrupted: ${result.run.id}.`);
        }
      } else if (result.feedbackQueued) {
        console.log(`Feedback queued for team run ${result.run.id}.`);
      } else {
        console.log(`No active team step to interrupt for run ${result.run.id}.`);
      }
      return true;
    }
    case "stop": {
      const run = engine.teamStop(rest[0]);
      if (!run) {
        console.log("No active team run to stop.");
      } else {
        console.log(`Team run stopped: ${run.id}`);
      }
      return true;
    }
    default:
      console.log(
        "Usage: /team <start|status|log|resume|approve|interrupt|stop> ...",
      );
      return true;
  }
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
      state.prefixPrinted = false;
      if (renderOptions.richUi) {
        if (shouldShowSystemLines()) {
          ensureCursorHidden();
          state.spinner = ora({
            stream: output,
            text: `${formatStatusLabel(adapterName)} generating...`,
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
      const text = sanitizeRenderedDelta(
        extractPayloadText(event.payload),
        state,
        resolveMode(),
      );
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
      state.prefixPrinted = false;
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
      state.prefixPrinted = false;
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
        text: `${formatStatusLabel(adapterName)} generating...`,
      });
    } else {
      state.spinner.stop();
    }
  }
  state.spinner = null;
};

const describeSessionBinding = (
  previousSessionId: string | null,
  currentSessionId: string,
): string => {
  if (!previousSessionId) {
    return "session ready";
  }
  if (previousSessionId === currentSessionId) {
    return "session resumed";
  }
  return "session switched";
};

const formatSessionId = (sessionId: string): string => {
  if (sessionId.length <= 16) {
    return sessionId;
  }
  return `${sessionId.slice(0, 8)}...${sessionId.slice(-6)}`;
};

const extractPayloadText = (payload: unknown): string => {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const text = (payload as { text?: string }).text;
  return typeof text === "string" ? text : "";
};

const sanitizeRenderedDelta = (
  text: string,
  state: AdapterRenderState,
  mode: OrchestrationMode,
): string => {
  if (!text) {
    return "";
  }

  const withoutReminders = stripSystemReminder(text, state);
  if (!withoutReminders) {
    return "";
  }

  return withoutReminders
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return true;
      }
      return !/^\d+→/.test(trimmed);
    })
    .filter((line) => {
      if (mode !== "team") {
        return true;
      }
      const trimmed = line.trim();
      if (!trimmed) {
        return true;
      }
      return !isTeamProcessChatterLine(trimmed);
    })
    .join("\n");
};

const stripSystemReminder = (
  text: string,
  state: AdapterRenderState,
): string => {
  let remaining = text;
  let outputText = "";

  while (remaining.length > 0) {
    if (state.insideSystemReminder) {
      const closeIndex = remaining.toLowerCase().indexOf("</system-reminder>");
      if (closeIndex === -1) {
        return outputText;
      }
      remaining = remaining.slice(closeIndex + "</system-reminder>".length);
      state.insideSystemReminder = false;
      continue;
    }

    const openIndex = remaining.toLowerCase().indexOf("<system-reminder>");
    if (openIndex === -1) {
      outputText += remaining;
      break;
    }

    outputText += remaining.slice(0, openIndex);
    const afterOpen = remaining.slice(openIndex + "<system-reminder>".length);
    const closeIndex = afterOpen.toLowerCase().indexOf("</system-reminder>");
    if (closeIndex === -1) {
      state.insideSystemReminder = true;
      break;
    }

    remaining = afterOpen.slice(closeIndex + "</system-reminder>".length);
  }

  return outputText;
};

const TEAM_PROCESS_CHATTER_PATTERNS = [
  /\b(i(?:'|’)m|i am|i(?:'|’)ll|i will)\b.*\b(read|scan|check|review|verify|grep|bootstrap|cross-check|inspect|prepare|gather|collect|re-?run|search)\b/i,
  /\b(i hit|quick bootstrap|first pass|next i(?:'|’)m|now i(?:'|’)m)\b/i,
  /\b(зараз|спершу|далі|потім|наступним кроком)\b.*\b(перевір|звір|прочита|скан|подив|підгот|запущ|зроблю)\b/i,
  /\bя\b.*\b(перевірю|прочитаю|запущу|зроблю швидкий)\b/i,
];

const isTeamProcessChatterLine = (line: string): boolean =>
  TEAM_PROCESS_CHATTER_PATTERNS.some((pattern) => pattern.test(line));

const normalizeMode = (value?: string): OrchestrationMode | null => {
  if (!value) {
    return null;
  }
  if ((MODES as string[]).includes(value)) {
    return value as OrchestrationMode;
  }
  return null;
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

const isReadlineClosedError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }
  const maybeError = error as { code?: string; message?: string };
  if (maybeError.code === "ERR_USE_AFTER_CLOSE") {
    return true;
  }
  return typeof maybeError.message === "string" && maybeError.message.includes("readline was closed");
};

const setupEscInterruptHotkey = (engine: ChatEngine): (() => void) => {
  if (!input.isTTY) {
    return () => {};
  }

  emitKeypressEvents(input);
  const ttyInput = input as NodeJS.ReadStream & {
    isRaw?: boolean;
    setRawMode?: (mode: boolean) => void;
  };
  const wasRaw = Boolean(ttyInput.isRaw);
  if (!wasRaw) {
    ttyInput.setRawMode?.(true);
  }

  const onKeypress = (
    _str: string,
    key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean },
  ): void => {
    if (key.name !== "escape" || key.ctrl || key.meta || key.shift) {
      return;
    }
    void triggerEscInterrupt(engine).catch((error: unknown) => {
      output.write(
        `\n${formatErrorText(`[team] Interrupt failed: ${error instanceof Error ? error.message : String(error)}`)}\n`,
      );
    });
  };
  input.on("keypress", onKeypress);

  return () => {
    input.off("keypress", onKeypress);
    if (!wasRaw) {
      ttyInput.setRawMode?.(false);
    }
  };
};

const triggerEscInterrupt = async (engine: ChatEngine): Promise<void> => {
  if (escInterruptInFlight) {
    return;
  }
  const status = engine.teamStatus();
  if (!status || status.run.status !== "active") {
    return;
  }

  escInterruptInFlight = true;
  try {
    const result = await engine.interruptTeamRun();
    if (!result) {
      return;
    }
    if (result.interrupted) {
      output.write(`\n[team] Interrupted run ${result.run.id}. Add correction and press Enter.\n`);
      return;
    }
    output.write(`\n[team] No active step to interrupt for run ${result.run.id}.\n`);
  } finally {
    escInterruptInFlight = false;
  }
};

const printUsage = (): void => {
  console.log(`
Usage:
  agoryx chat [--agents codex,claude] [--mode manual|round-robin|auto|team]
  agoryx sessions list [--limit 20] [--db ./agoryx.db]
  agoryx sessions export <room_or_session_id> [--format markdown|json] [--out file] [--db ./agoryx.db]

Options:
  --agents       Comma-separated list of agents (default: codex,claude)
  --mode         Orchestration mode (default: manual)
  --config       Path to agoryx.json config file (default: ./agoryx.json)
  --db           SQLite path (default: ./agoryx.db)
  --adapter-mode Global adapter mode: stub|cli|persistent|agentic (default: cli)
  --quiet-system Hide generating/done/session status lines
  --plain-ui     Disable rich TTY UI (spinner and live status rendering)
  --no-color     Disable colored output
  --resume       Resume existing room by id
  --room-name    Room title
`);
};

const printSessionsUsage = (): void => {
  console.log(`
Usage:
  agoryx sessions list [--limit 20] [--db ./agoryx.db]
  agoryx sessions export <room_or_session_id> [--format markdown|json] [--out file] [--db ./agoryx.db]
`);
};

const printChatHelp = (): void => {
  console.log(`
In-chat commands:
  /help
  /mode <manual|round-robin|auto|team>
  /status
  /adapter <codex|claude> <stub|cli|persistent|agentic>
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
  /retry @codex
  /export [markdown|json] [--out <file>]
  Esc (TTY, team mode): interrupt active team step
  /quit
`);
};

const printBanner = (
  roomId: string,
  sessionId: string,
  mode: OrchestrationMode,
  agents: string[],
  adapterConfig: ChatRuntimeConfig["adapterConfig"],
): void => {
  console.log(colorize("Agoryx v0.1-dev", pc.bold));
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

interface ParsedArgs {
  options: Record<string, string>;
  positionals: string[];
}

const parseArgs = (args: string[]): ParsedArgs => {
  const options: Record<string, string> = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token) {
      continue;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      options[key] = "true";
      continue;
    }
    options[key] = next;
    i += 1;
  }
  return { options, positionals };
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Fatal error");
  process.exit(1);
});
