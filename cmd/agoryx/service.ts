import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findDaemon } from "../../internal/agora/daemoninfo.js";
import { agoraHome } from "../../internal/agora/paths.js";
import { installRoot } from "../../internal/desktop/doctor.js";
import {
  installService,
  launchdContext,
  runByService,
  serviceStatus,
  uninstallService,
  type LaunchdContext,
  type ServiceStatus,
} from "../../internal/desktop/launchd.js";
import { CliUsageError, parseCliArgsOrThrow, type OutputWriter } from "./cli-args.js";

/**
 * `agoryx service install | uninstall | status`: the daemon as a macOS LaunchAgent, for the current
 * AGORYX_HOME. It starts at login and after a crash, without the app or a terminal; `agoryx down` stops it
 * until the next login (or `agoryx up -d`).
 */

export const printServiceUsage = (write: OutputWriter = console.log): void => {
  write([
    "Run the daemon at login as a launchd service (macOS), for the current AGORYX_HOME.",
    "",
    "Usage:",
    "  agoryx service install     Write the LaunchAgent and load it (starts the daemon unless one is running)",
    "  agoryx service uninstall   Unload it (stops the daemon it runs) and remove it",
    "  agoryx service status [--json]",
    "",
    "Options:",
    "  --json       Print the status as JSON",
    "  -h, --help   Show this help message and exit",
    "",
    "The service runs `node <install>/bin/agoryx.js up --login-env` with the node that runs this command:",
    "at login, and again after a crash. `agoryx down` stops it until the next login or `agoryx up -d`.",
    "The plist holds PATH, SHELL and AGORYX_HOME only; the daemon reads keys from your login shell at start.",
    "Its output goes to <AGORYX_HOME>/daemon.log. Run install again after moving the install or upgrading node.",
  ].join("\n"));
};

export interface ServiceCommandDeps {
  env?: NodeJS.ProcessEnv;
  /** For tests: where launchd lives and how it is asked. */
  launchd?: Partial<LaunchdContext>;
  root?: string;
  node?: string;
  platform?: NodeJS.Platform;
  write?: OutputWriter;
  /** How long install waits for the daemon to answer; default 20s. */
  waitMs?: number;
}

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** One line on what the service is doing, and the daemon of its home. */
const describe = async (status: ServiceStatus, env: NodeJS.ProcessEnv): Promise<string[]> => {
  const lines = [`service  ${status.label}`, `plist    ${status.plistPath}${status.installed ? "" : " (not installed)"}`];
  if (status.program) lines.push(`runs     ${status.program.join(" ")}`);
  for (const file of status.missing) lines.push(`missing  ${file} — run \`agoryx service install\` again`);
  if (status.installed && !status.loaded) lines.push("launchd  not loaded — run `agoryx service install` (or log out and in)");
  if (status.loaded) {
    const exit = status.lastExitCode && status.lastExitCode !== "(never exited)" ? `, last exit code ${status.lastExitCode}` : "";
    lines.push(`launchd  ${status.state ?? "loaded"}${status.pid ? ` (pid ${status.pid})` : ""}${exit}`);
  }
  const daemon = await findDaemon(env);
  if (!daemon) lines.push(`daemon   not running (home ${agoraHome(env)})`);
  else if (await runByService(status, daemon.pid)) lines.push(`daemon   ${daemon.url} (pid ${daemon.pid}, run by the service)`);
  else lines.push(`daemon   ${daemon.url} (pid ${daemon.pid}, started outside the service)`);
  return lines;
};

export const runServiceCommand = async (argv: string[], deps: ServiceCommandDeps = {}): Promise<number> => {
  const write = deps.write ?? console.log;
  const parsed = parseCliArgsOrThrow(
    argv,
    [
      { long: "help", short: "h", takesValue: false },
      { long: "json", takesValue: false },
    ],
    printServiceUsage,
  );
  const [action, extra] = parsed.positionals;
  if (parsed.options.help || !action) {
    printServiceUsage(write);
    return parsed.options.help ? 0 : 1;
  }
  if (extra !== undefined) throw new CliUsageError(`Unexpected argument: ${extra}`, printServiceUsage, "Run `agoryx service --help`.");
  if (!["install", "uninstall", "status"].includes(action)) {
    throw new CliUsageError(`Unknown service action: ${action}`, printServiceUsage, "Use install, uninstall or status.");
  }
  if ((deps.platform ?? process.platform) !== "darwin") {
    console.error("agoryx service needs macOS (launchd). Elsewhere, run `agoryx up` under your own service manager.");
    return 1;
  }
  const env = deps.env ?? process.env;
  const ctx = launchdContext(env, deps.launchd);

  if (action === "status") {
    const status = await serviceStatus(ctx);
    if (parsed.options.json) {
      const daemon = await findDaemon(env);
      write(JSON.stringify({ ...status, home: agoraHome(env), daemon: daemon ? { url: daemon.url, pid: daemon.pid, byService: await runByService(status, daemon.pid) } : null }, null, 2));
    } else {
      for (const line of await describe(status, env)) write(line);
    }
    return 0;
  }

  if (action === "uninstall") {
    const result = await uninstallService(ctx);
    if (!result.removed && !result.unloaded) write(`no service ${ctx.label} was installed`);
    else write(`removed the service ${ctx.label}${result.unloaded ? " (launchd stopped its daemon, if it was running)" : ""}`);
    return 0;
  }

  const root = deps.root ?? installRoot() ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const node = deps.node ?? process.execPath;
  const result = await installService({ ctx, root, node });
  if (!result.written && !result.reloaded) write(`the service ${ctx.label} is installed and loaded; nothing changed`);
  else write(`${result.reloaded ? "reinstalled" : "installed"} the service ${ctx.label}: ${result.status.plistPath}`);
  if (result.reloaded) write("launchd stopped the daemon the old service ran; the new one starts it again");
  write(`runs ${result.status.program?.join(" ") ?? ""}`);
  const deadline = Date.now() + (deps.waitMs ?? 20_000);
  while (Date.now() < deadline) {
    const info = await findDaemon(env);
    if (info) {
      const status = await serviceStatus(ctx);
      if (await runByService(status, info.pid)) write(`daemon running at ${info.url} (pid ${info.pid})`);
      else write(`a daemon started outside the service is running (pid ${info.pid}, ${info.url}): the service takes over at the next login, or after \`agoryx down && agoryx up -d\``);
      return 0;
    }
    await sleep(250);
  }
  write(`the daemon has not answered yet; see ${agoraHome(env)}/daemon.log and \`agoryx service status\``);
  return 1;
};
