import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { doctorVerdict, formatDoctor, installRoot, runDoctor } from "../../internal/desktop/doctor.js";
import { CliUsageError, parseCliArgsOrThrow, type OutputWriter } from "./cli-args.js";

/**
 * `agoryx doctor`: whether this machine has what rooms need (node, the install, better-sqlite3, the
 * agents' CLIs and logins, git, the state folder) and what to run where it does not. The same checks the
 * desktop app shows on its first screen. Its output names versions and paths, never an environment
 * value or an account.
 */

export const printDoctorUsage = (write: OutputWriter = console.log): void => {
  write([
    "Check what Agoryx needs on this machine, and say how to fix what is missing.",
    "",
    "Usage:",
    "  agoryx doctor [--probe] [--json]",
    "",
    "Options:",
    "  --probe      Also send each logged-in agent one short prompt (a real request each)",
    "  --json       Print { verdict, checks } as JSON",
    "  -h, --help   Show this help message and exit",
    "",
    "Checks: Node.js (22+), this install and its build, better-sqlite3 under that node, Claude Code and",
    "Codex (found, logged in), at least one usable agent, git, the state folder (AGORYX_HOME), the daemon,",
    "and on macOS the login service (`agoryx service`).",
    "Exits 1 when something is missing that Agoryx cannot run without.",
  ].join("\n"));
};

export const runDoctorCommand = async (argv: string[]): Promise<number> => {
  const parsed = parseCliArgsOrThrow(
    argv,
    [
      { long: "help", short: "h", takesValue: false },
      { long: "probe", takesValue: false },
      { long: "json", takesValue: false },
    ],
    printDoctorUsage,
  );
  if (parsed.options.help) {
    printDoctorUsage();
    return 0;
  }
  if (parsed.positionals.length > 0) {
    throw new CliUsageError(`Unexpected argument: ${parsed.positionals[0]}`, printDoctorUsage, "Run `agoryx doctor --help`.");
  }
  const root = installRoot() ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const checks = await runDoctor({ env: process.env, root, probe: Boolean(parsed.options.probe) });
  const verdict = doctorVerdict(checks);
  if (parsed.options.json) {
    console.log(JSON.stringify({ verdict, checks }, null, 2));
  } else {
    const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
    for (const line of formatDoctor(checks, { color })) console.log(line);
  }
  return verdict === "fail" ? 1 : 0;
};
