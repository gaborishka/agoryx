#!/usr/bin/env node
// The production node_modules the packaged core runs with (Agoryx.app/Contents/Resources/agoryx):
// the root lockfile's dependencies without the dev ones, in desktop/.stage. Install scripts are skipped:
// the root package's `prepare` needs tsc, and better-sqlite3 ships its prebuilt Node-API binaries.
// The daemon loads them with the user's node; `agoryx doctor`'s sqlite check says if that fails.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(desktop, "..");
const stage = join(desktop, ".stage");

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const file of ["package.json", "package-lock.json"]) copyFileSync(join(root, file), join(stage, file));

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npm, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: stage, stdio: "inherit" });
if (result.status !== 0) {
  console.error("stage-core: npm ci failed");
  process.exit(result.status ?? 1);
}
// The npm tarball can leave node-pty's macOS helper non-executable. Fix that before
// signing, rather than relying on the terminal's runtime repair inside a read-only app.
for (const arch of ["darwin-arm64", "darwin-x64"]) {
  const helper = join(stage, "node_modules", "node-pty", "prebuilds", arch, "spawn-helper");
  if (existsSync(helper)) chmodSync(helper, 0o755);
}
console.log(`stage-core: production node_modules in ${join(stage, "node_modules")}`);
