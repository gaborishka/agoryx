#!/usr/bin/env node
import { constants, realpathSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { constants as osConstants } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const thisFile = realpathSync(fileURLToPath(import.meta.url));
const thisDir = dirname(thisFile);
const repoRoot = resolve(thisDir, "..");
const distEntry = resolve(repoRoot, "dist/cmd/agoryx/main.js");
const sourceEntry = resolve(repoRoot, "cmd/agoryx/main.ts");
const tsxLoader = resolve(repoRoot, "node_modules/tsx/dist/loader.mjs");

// Inside a room turn (the room sets AGORYX_AGENT), a shell that put this install ahead of the room's shim
// still gets the agent's tools: `agoryx say` there is the agent speaking, never the human.
if (process.env.AGORYX_AGENT && ["say", "table", "read", "diff"].includes(process.argv[2] ?? "")) {
  const agent = spawnSync(process.execPath, [resolve(repoRoot, "bin/agoryx-agent.mjs"), ...process.argv.slice(2)], {
    stdio: "inherit",
    env: process.env,
  });
  process.exit(agent.status ?? 1);
}

// The child is the real process: a SIGTERM or SIGHUP sent to this one (launchd stopping the service, `kill`)
// reaches it, so the daemon closes its rooms instead of being orphaned and then killed with the group.
// Ctrl-C needs no forwarding: the terminal sends SIGINT to both.
const runSourceFallback = () =>
  new Promise(() => {
    const fallback = spawn(
      process.execPath,
      ["--import", pathToFileURL(tsxLoader).href, sourceEntry, ...process.argv.slice(2)],
      {
        stdio: "inherit",
        env: process.env,
      },
    );
    for (const signal of ["SIGTERM", "SIGHUP"]) process.on(signal, () => fallback.kill(signal));
    process.on("SIGINT", () => {});
    fallback.on("error", (error) => {
      console.error(`[agoryx] Failed to start source mode: ${error.message}`);
      process.exit(1);
    });
    fallback.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1)));
  });

const shouldRunSource = async () => {
  try {
    const [distStats, sourceStats] = await Promise.all([
      stat(distEntry),
      stat(sourceEntry),
    ]);
    return sourceStats.mtimeMs > distStats.mtimeMs;
  } catch {
    return false;
  }
};

const isErrno = (error, code) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === code;

let distReadable = false;
try {
  await access(distEntry, constants.R_OK);
  distReadable = true;
} catch (error) {
  if (!isErrno(error, "ENOENT")) {
    throw error;
  }
}

if (!distReadable) {
  await runSourceFallback();
}

if (await shouldRunSource()) {
  await runSourceFallback();
}

try {
  await import(pathToFileURL(distEntry).href);
} catch (error) {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`[agoryx] Failed to load built entry '${distEntry}': ${detail}`);
  console.error("[agoryx] Falling back to source mode via tsx.");
  await runSourceFallback();
}
