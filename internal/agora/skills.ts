import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { RoomAgent, RoomSkill, SkillCatalog, SkillInvocation } from "./types.js";

const MAX_SKILL = 256 * 1024;
type FoundSkill = Omit<RoomSkill, "id" | "agents">;

/** Only the descriptive frontmatter fields; no execution or interpretation of skill bodies. */
export function skillMetadata(text: string): Record<string, string> {
  const block = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  if (!block) return {};
  const result: Record<string, string> = {};
  const rows = block.split(/\r?\n/);
  for (let i = 0; i < rows.length; i++) {
    const match = /^(name|description|user-invocable):\s*(.*)$/.exec(rows[i]!);
    if (!match) continue;
    let value = match[2]!.trim();
    if (/^[>|][-+]?\s*$/.test(value)) {
      const lines: string[] = [];
      while (i + 1 < rows.length && /^(\s|$)/.test(rows[i + 1]!)) lines.push(rows[++i]!.trim());
      value = lines.join(" ");
    } else if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
    } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/''/g, "'");
    else value = value.replace(/\s+#.*$/, "").trim();
    result[match[1]!] = value;
  }
  return result;
}

const jsonFile = async (path: string): Promise<any> => {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
};

async function claudeSkills(cwd: string, env: NodeJS.ProcessEnv): Promise<FoundSkill[]> {
  const home = env.HOME || homedir();
  const config = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const scopes: string[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    scopes.unshift(dir);
    if (dirname(dir) === dir) break;
  }
  const roots = [{ path: join(config, "skills"), source: "Claude · personal" },
    ...scopes.map(dir => ({ path: join(dir, ".claude", "skills"), source: "Claude · project" }))];
  const enabled: Record<string, boolean> = {};
  for (const path of [join(config, "settings.json"), ...scopes.flatMap(dir => [join(dir, ".claude/settings.json"), join(dir, ".claude/settings.local.json")])]) {
    const settings = await jsonFile(path);
    if (settings.enabledPlugins && typeof settings.enabledPlugins === "object") Object.assign(enabled, settings.enabledPlugins);
  }
  const installed = await jsonFile(join(config, "plugins/installed_plugins.json"));
  for (const [name, entries] of Object.entries(installed.plugins ?? {})) {
    if (enabled[name] !== true || !Array.isArray(entries)) continue;
    const applicable = entries.filter(e => e && typeof e.installPath === "string" &&
      (e.scope === "user" || ((e.scope === "project" || e.scope === "local") && scopes.includes(e.projectPath))));
    const entry = applicable.find(e => e.scope === "local") ?? applicable.find(e => e.scope === "project") ?? applicable[0];
    if (entry) roots.push({ path: join(entry.installPath, "skills"), source: `Claude · ${name.split("@")[0]}` });
  }
  const found: FoundSkill[] = [];
  const seen = new Set<string>();
  let visited = 0;
  async function walk(path: string, source: string, depth: number): Promise<void> {
    if (depth > 5 || ++visited > 2000) return;
    let canonical: string;
    try { canonical = await realpath(path); } catch { return; }
    if (seen.has(canonical)) return;
    seen.add(canonical);
    const file = join(canonical, "SKILL.md");
    try {
      if ((await stat(file)).size <= MAX_SKILL) {
        const meta = skillMetadata(await readFile(file, "utf8"));
        if (meta["user-invocable"] !== "false") found.push({ name: meta.name || basename(canonical), description: meta.description || "Local skill", path: file, source });
      }
      return;
    } catch { /* A directory of skills, or an unreadable skill. */ }
    let entries;
    try { entries = await readdir(canonical, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink())) await walk(join(canonical, entry.name), source, depth + 1);
    }
  }
  for (const root of roots) await walk(root.path, root.source, 0);
  return found;
}

/** A catalog request only: no thread, model turn, or authentication flow is started. */
export function codexSkills(cwd: string, env: NodeJS.ProcessEnv): Promise<FoundSkill[]> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(env.AGORYX_CODEX_BIN || "codex", ["app-server"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let pending = "", bytes = 0, done = false;
    const finish = (error?: Error, result: FoundSkill[] = []) => {
      if (done) return;
      done = true; clearTimeout(timer); child.stdin.destroy(); child.kill();
      if (error) reject(error); else resolveResult(result);
    };
    const timer = setTimeout(() => finish(new Error("Codex skill catalog timed out")), 8000);
    const send = (message: object) => child.stdin.write(JSON.stringify(message) + "\n");
    child.on("error", error => finish(error));
    child.on("exit", () => finish(new Error("Codex skill catalog closed before replying")));
    child.stdin.on("error", error => finish(error));
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      bytes += Buffer.byteLength(data);
      if (bytes > 4 * 1024 * 1024) return finish(new Error("Codex skill catalog is too large"));
      pending += data;
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (!msg || typeof msg !== "object") continue;
        if (msg.id !== 1 && msg.id !== 2) continue;
        if (msg.error) return finish(new Error(String(msg.error.message || "Codex skill catalog failed")));
        if (msg.id === 1) {
          send({ method: "initialized", params: {} });
          send({ id: 2, method: "skills/list", params: { cwds: [cwd], forceReload: true } });
        } else {
          if (!Array.isArray(msg.result?.data)) return finish(new Error("Codex returned an invalid skill catalog"));
          const skills: FoundSkill[] = [];
          for (const group of msg.result.data) for (const s of Array.isArray(group?.skills) ? group.skills : []) {
            if (!s || s.enabled === false || typeof s.name !== "string" || typeof s.path !== "string" || !isAbsolute(s.path)) continue;
            skills.push({ name: s.name, description: typeof s.description === "string" ? s.description : "Local skill", path: s.path, source: `Codex · ${typeof s.scope === "string" ? s.scope : "local"}` });
          }
          finish(undefined, skills);
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "agoryx_skills", version: "1.0.0" }, capabilities: {} } });
  });
}

export async function roomSkills(cwd: string, agents: readonly RoomAgent[], env: NodeJS.ProcessEnv = process.env): Promise<SkillCatalog> {
  const skills = new Map<string, RoomSkill>();
  const warnings: string[] = [];
  await Promise.all([...new Set(agents.map(a => a.kind))].map(async kind => {
    try {
      const found = await (kind === "codex" ? codexSkills(cwd, env) : claudeSkills(cwd, env));
      for (const skill of found) {
        let path: string;
        try { path = await realpath(skill.path); if (!(await stat(path)).isFile()) continue; } catch { continue; }
        const id = createHash("sha256").update(`${path}\0${skill.name}`).digest("hex").slice(0, 24);
        const owners = agents.filter(a => a.kind === kind).map(a => a.id);
        const existing = skills.get(id);
        if (existing) { existing.agents.push(...owners); existing.source = "Shared local skill"; }
        else skills.set(id, { ...skill, path, id, agents: owners });
      }
    } catch (error) { warnings.push(`${kind}: ${error instanceof Error ? error.message : String(error)}`); }
  }));
  for (const skill of skills.values()) skill.agents = agents.filter(a => skill.agents.includes(a.id)).map(a => a.id);
  return { skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)), warnings };
}

/** Accept registry identities, never client-supplied paths, names or routing inferred from prose. */
export function resolveSkillInvocation(catalog: SkillCatalog, value: unknown): SkillInvocation {
  const input = value as { id?: unknown; targets?: unknown } | null;
  const skill = catalog.skills.find(s => s.id === input?.id);
  if (!skill) throw new Error("This skill is no longer available. Refresh the catalog and choose it again.");
  if (!Array.isArray(input?.targets) || !input.targets.length || input.targets.some(t => typeof t !== "string" || !skill.agents.includes(t))) {
    throw new Error("Choose participants who have this skill.");
  }
  return { id: skill.id, name: skill.name, path: skill.path, targets: [...new Set(input.targets as string[])] };
}
