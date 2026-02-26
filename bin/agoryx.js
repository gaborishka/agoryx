#!/usr/bin/env node
import { constants, realpathSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const thisFile = realpathSync(fileURLToPath(import.meta.url));
const thisDir = dirname(thisFile);
const repoRoot = resolve(thisDir, "..");
const distEntry = resolve(repoRoot, "dist/cmd/agoryx/main.js");
const sourceEntry = resolve(repoRoot, "cmd/agoryx/main.ts");
const tsxLoader = resolve(repoRoot, "node_modules/tsx/dist/loader.mjs");

const runSourceFallback = () => {
  const fallback = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(tsxLoader).href, sourceEntry, ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: process.env,
    },
  );
  process.exit(fallback.status ?? 1);
};

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
  runSourceFallback();
}

if (await shouldRunSource()) {
  runSourceFallback();
}

try {
  await import(pathToFileURL(distEntry).href);
} catch (error) {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`[agoryx] Failed to load built entry '${distEntry}': ${detail}`);
  console.error("[agoryx] Falling back to source mode via tsx.");
  runSourceFallback();
}
