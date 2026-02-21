#!/usr/bin/env node
import { constants, realpathSync } from "node:fs";
import { access } from "node:fs/promises";
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

try {
  await access(distEntry, constants.R_OK);
  await import(pathToFileURL(distEntry).href);
} catch {
  runSourceFallback();
}
