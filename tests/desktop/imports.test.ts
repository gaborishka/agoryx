import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import * as daemon from "../../internal/agora/daemon.js";
import * as daemonInfo from "../../internal/agora/daemoninfo.js";

/**
 * The desktop core is loaded by Electron's main process, whose Node ABI is not the user's node: nothing
 * it imports at runtime may reach a native module (better-sqlite3), the terminal UI (ink, react), or the
 * daemon and room modules that pull those in. Type-only imports are erased and do not count.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DESKTOP = join(ROOT, "internal", "desktop");
const FORBIDDEN_FILES = ["daemon.ts", "store.ts", "engine.ts", "service.ts"];
const FORBIDDEN_PACKAGES = ["better-sqlite3", "ink", "react"];

/** The runtime imports of one file: static imports and re-exports that are not type-only, and dynamic import(). */
const runtimeImports = (file: string): string[] => {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typeOnly =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (!clause.name &&
            clause.namedBindings !== undefined &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every((element) => element.isTypeOnly)));
      if (!typeOnly) found.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly =
        node.isTypeOnly ||
        (node.exportClause !== undefined &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.length > 0 &&
          node.exportClause.elements.every((element) => element.isTypeOnly));
      if (!typeOnly) found.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      found.push(argument && ts.isStringLiteralLike(argument) ? argument.text : "<computed import()>");
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (!node.isTypeOnly) found.push(ts.isStringLiteral(expression) ? expression.text : "<computed require>");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

/** Every file reachable from the desktop core at runtime, and every non-relative module it names. */
const walk = (): { files: Set<string>; modules: Map<string, string> } => {
  const files = new Set<string>();
  const modules = new Map<string, string>();
  const queue = readdirSync(DESKTOP)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(DESKTOP, name));
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of runtimeImports(file)) {
      if (!specifier.startsWith(".")) {
        modules.set(specifier, relative(ROOT, file));
        continue;
      }
      const target = resolve(dirname(file), specifier.replace(/\.js$/, ".ts"));
      assert.ok(existsSync(target), `${relative(ROOT, file)} imports ${specifier}, which is not a .ts file here`);
      queue.push(target);
    }
  }
  return { files, modules };
};

test("the desktop core reaches only node built-ins and dependency-free modules at runtime", () => {
  const { files, modules } = walk();
  const reached = [...files].map((file) => relative(ROOT, file)).sort();
  for (const file of reached) {
    assert.ok(!FORBIDDEN_FILES.some((name) => file.endsWith(`/${name}`)), `${file} is reachable from internal/desktop`);
  }
  for (const [specifier, from] of modules) {
    assert.ok(specifier.startsWith("node:"), `${from} imports "${specifier}": only node:* built-ins are allowed`);
    assert.ok(!FORBIDDEN_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`)), `${from} imports ${specifier}`);
  }
  // The walk did see the core and what it is allowed to use.
  for (const file of ["internal/desktop/index.ts", "internal/desktop/supervisor.ts", "internal/agora/daemoninfo.ts", "internal/agora/client.ts", "internal/agora/paths.ts"]) {
    assert.ok(reached.includes(file), `${file} should be reached`);
  }
  assert.ok(modules.has("node:child_process"));
});

test("the walk skips type-only imports and catches every runtime one", () => {
  // client.ts imports store.ts and types.ts for types only: not followed.
  assert.deepEqual(runtimeImports(join(ROOT, "internal", "agora", "client.ts")), []);
  const dir = mkdtempSync(join(tmpdir(), "agoryx-imports-"));
  try {
    const file = join(dir, "sample.ts");
    writeFileSync(
      file,
      [
        'import type { RoomStore } from "./store.js";',
        'import { type RoomEngine } from "./engine.js";',
        'export type { RoomState } from "./types.js";',
        'export { type RoomSummary } from "./service.js";',
        'import Database from "better-sqlite3";',
        'import { render, type Instance } from "ink";',
        'export { AgoraDaemon } from "./daemon.js";',
        'import "./side-effect.js";',
        'const later = () => import("react");',
      ].join("\n"),
    );
    assert.deepEqual(runtimeImports(file).sort(), ["./daemon.js", "./side-effect.js", "better-sqlite3", "ink", "react"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon.ts still exports readDaemonInfo and findDaemon (now from daemoninfo.ts)", () => {
  assert.equal(daemon.readDaemonInfo, daemonInfo.readDaemonInfo);
  assert.equal(daemon.findDaemon, daemonInfo.findDaemon);
});

const DIST_ENTRY = join(ROOT, "dist", "internal", "desktop", "index.js");

test("the built core, loaded as the app loads it, loads nothing but node built-ins and its own files", { skip: !existsSync(DIST_ENTRY) && "dist/ is not built" }, () => {
  // A fresh node records every module the import resolves (registerHooks: Node 22.15+).
  const script = [
    'import { registerHooks } from "node:module";',
    "const loaded = [];",
    "registerHooks({ resolve(specifier, context, next) { const result = next(specifier, context); loaded.push(result.url); return result; } });",
    `await import(${JSON.stringify(pathToFileURL(DIST_ENTRY).href)});`,
    "process.stdout.write(JSON.stringify(loaded));",
  ].join("\n");
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 30_000 });
  if (run.status !== 0 && /registerHooks/.test(run.stderr)) return;
  assert.equal(run.status, 0, run.stderr);
  const loaded = JSON.parse(run.stdout) as string[];
  const dist = pathToFileURL(join(ROOT, "dist", "internal")).href;
  const outside = loaded.filter((url) => !url.startsWith("node:") && !url.startsWith(`${dist}/`));
  assert.deepEqual(outside, []);
  const files = loaded.filter((url) => url.startsWith(dist)).map((url) => url.slice(dist.length + 1)).sort();
  assert.ok(!files.some((file) => /(^|\/)(daemon|store|engine|service)\.js$/.test(file)), files.join(", "));
  assert.ok(files.includes("desktop/supervisor.js") && files.includes("agora/daemoninfo.js"));
});
