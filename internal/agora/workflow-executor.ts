import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentKind } from "./types.js";
import { createWorkflowProxy } from "./workflow-proxy.js";
import { trackWorkflowProcesses } from "./workflow-processes.js";
import { createWorkflowAuthentication, refreshNativeWorkflowAuth, workflowAuthBlocked, workflowAuthKey } from "./workflow-auth.js";
export { isPublicProviderAddress } from "./workflow-proxy.js";
import type { WorkflowExecutionInput, WorkflowExecutor } from "./workflow-types.js";

/** This is a whole-process boundary, including every native CLI tool and subprocess.
 * A different cwd, read-only native sandbox, or instruction to keep secrets is not isolation.
 * Only macOS Seatbelt is supported until another OS has a tested equivalent. */
export interface WorkflowIsolationCapability {
  available: boolean;
  backend: "seatbelt" | "unavailable";
  reason?: string;
  providers: Record<AgentKind, { available: boolean; reason?: string }>;
}

export type WorkflowIsolationErrorCode = "unsupported_platform" | "auth_missing" | "timeout" | "provider_exit" | "sandbox_unavailable" | "cancelled" | "output_limit" | "incomplete_output" | "artifact_invalid" | "network_unavailable";
export class WorkflowIsolationError extends Error {
  constructor(readonly code: WorkflowIsolationErrorCode, message: string) { super(message); this.name = "WorkflowIsolationError"; }
}

const SEATBELT = "/usr/bin/sandbox-exec";
const SYSTEM_READ_ROOTS = ["/System", "/usr/bin", "/usr/lib", "/usr/share", "/opt/homebrew/bin", "/usr/local/bin", "/bin", "/sbin", "/etc", "/private/etc", "/private/var/select"];
// A /dev subtree grant would expose peer PTY input. Only inert devices and this
// process's inherited descriptors are needed by non-interactive native CLIs.
const SAFE_READ_DEVICES = ["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom", "/dev/stdin", "/dev/stdout", "/dev/stderr"];

/** The trusted parent creates its own PTY; no existing host terminal is inspected. */
const DEVICE_BOUNDARY_PROBE = `require 'pty'; require 'open3'
PTY.open do |master, slave|
  probe = 'begin; File.open(ARGV[0], File::RDONLY | File::NONBLOCK); exit 1; rescue Errno::EPERM, Errno::EACCES; puts "device-boundary-ok"; end'
  output, status = Open3.capture2e(ARGV[0], '-p', ARGV[1], '/usr/bin/ruby', '--disable=gems', '-e', probe, slave.path)
  print output; exit(status.exitstatus || 1)
end`;

/** A direct numeric syscall probe, not `ps`: ps can be denied while procargs2 still leaks. */
export const WORKFLOW_PROCESS_PROBE = `require 'fiddle'; require 'json'
target = Integer(ARGV[0]); marker = ARGV[1]
sysctl = Fiddle::Function.new(Fiddle::Handle::DEFAULT['sysctl'], [Fiddle::TYPE_VOIDP,Fiddle::TYPE_INT,Fiddle::TYPE_VOIDP,Fiddle::TYPE_VOIDP,Fiddle::TYPE_VOIDP,Fiddle::TYPE_SIZE_T], Fiddle::TYPE_INT)
result = {}
begin; Process.kill(0, target); result['signal'] = 'allowed'; rescue Errno::EPERM, Errno::EACCES; result['signal'] = 'denied'; end
[["procargs", [1,38,target]], ["procargs2", [1,49,target]], ["proc", [1,14,1,target]]].each do |name,mib|
  data = "\\0" * 1048576; size = [data.bytesize].pack('J')
  code = sysctl.call(mib.pack('i!*'), mib.length, data, size, nil, 0)
  result[name] = code; result[name + "Leaked"] = data.include?(marker)
end
if ARGV[2] == 'task'
  self_port = Fiddle::Pointer.new(Fiddle::Handle::DEFAULT['mach_task_self_'])[0,4].unpack1('I')
  ['task_for_pid','task_name_for_pid'].each do |name|
    fn = Fiddle::Function.new(Fiddle::Handle::DEFAULT[name], [Fiddle::TYPE_INT,Fiddle::TYPE_INT,Fiddle::TYPE_VOIDP], Fiddle::TYPE_INT)
    port = [0].pack('I'); result[name] = fn.call(self_port,target,port)
  end
end
puts JSON.generate(result)`;

const executable = (name: string, env: NodeJS.ProcessEnv): string | null => {
  const candidates = name.includes("/") ? [resolve(name)] : (env.PATH ?? "/usr/bin:/bin").split(delimiter).map((dir) => join(dir, name));
  for (const file of candidates) {
    try { if (lstatSync(realpathSync(file)).isFile()) return realpathSync(file); } catch { /* next */ }
  }
  return null;
};

const binary = (kind: AgentKind, env: NodeJS.ProcessEnv) => executable(env[kind === "codex" ? "AGORYX_CODEX_BIN" : "AGORYX_CLAUDE_BIN"] || kind, env);

/** JSON string syntax is also valid for SBPL string literals. No caller-supplied profile fragments. */
const literal = (path: string) => `(literal ${JSON.stringify(path)})`;
const subtree = (path: string) => `(subpath ${JSON.stringify(path)})`;

export interface WorkflowSandboxSpec {
  directory: string;
  /** Trusted executable/runtime roots only, never a room workspace or native home. */
  runtimePaths: string[];
  proxyPort?: number;
}

export const workflowSandboxProfile = (spec: WorkflowSandboxSpec): string => {
  if (spec.proxyPort !== undefined && (!Number.isInteger(spec.proxyPort) || spec.proxyPort < 1 || spec.proxyPort > 65535)) throw new Error("Invalid private provider broker port");
  const ancestors = new Set<string>();
  for (const path of [spec.directory, ...spec.runtimePaths]) {
    for (let parent = dirname(path); parent !== "/"; parent = dirname(parent)) ancestors.add(parent);
  }
  return [
    "(version 1)", "(deny default)",
    // These newer operation families need explicit denies: on macOS 26 a default-deny
    // profile alone still allowed numeric kern.procargs2 reads of another process's argv/env.
    "(deny sysctl-read)", "(deny process-info*)", "(allow process-info* (target same-sandbox))",
    "(deny mach-task-name)", "(deny nvram*)", "(deny iokit-get-properties)",
    "(allow process-exec)", "(allow process-fork)",
    '(allow sysctl-read (sysctl-name-regex #"^hw\\.") (sysctl-name-regex #"^machdep\\.cpu\\.") (sysctl-name "kern.osrelease") (sysctl-name "kern.ostype") (sysctl-name "kern.hostname") (sysctl-name "kern.domainname") (sysctl-name "kern.osversion") (sysctl-name "kern.version") (sysctl-name "kern.boottime") (sysctl-name "kern.argmax") (sysctl-name "kern.maxfiles") (sysctl-name "kern.maxfilesperproc"))',
    "(allow signal (target same-sandbox))",
    `(allow file-read* ${literal("/")} ${SYSTEM_READ_ROOTS.map(subtree).join(" ")} ${SAFE_READ_DEVICES.map(literal).join(" ")} ${subtree("/dev/fd")} ${spec.runtimePaths.map(subtree).join(" ")} ${subtree(spec.directory)})`,
    `(allow file-read-metadata ${[...ancestors].map(literal).join(" ")})`,
    `(allow file-write* ${subtree(spec.directory)} ${literal("/dev/null")} ${literal("/dev/tty")})`,
    // DNS and certificate verification are system brokers. No general Mach access, Keychain,
    // AppleEvents, browser automation, or arbitrary local socket access is granted.
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.opendirectoryd.membership") (global-name "com.apple.bsd.dirhelper") (global-name "com.apple.trustd.agent") (global-name "com.apple.trustd") (global-name "com.apple.networkd") (global-name "com.apple.SystemConfiguration.configd") (global-name "com.apple.SystemConfiguration.DNSConfiguration"))',
    ...(spec.proxyPort ? [`(allow network-outbound (remote tcp "localhost:${spec.proxyPort}"))`] : []),
  ].join("\n");
};

/** Read installed package payloads, never the enclosing npm prefix or the user's home. */
const cliPackagePaths = (bin: string): string[] => {
  const paths = new Set<string>();
  const include = (manifestPath: string): void => {
    const manifest = realpathSync(manifestPath), root = dirname(manifest);
    if (paths.has(root) || paths.size >= 100) return;
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { dependencies?: Record<string, unknown>; optionalDependencies?: Record<string, unknown> };
    paths.add(root);
    const require = createRequire(manifest);
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      if (!/^(?:@[a-z0-9][a-z0-9_.-]*\/)?[a-z0-9][a-z0-9_.-]*$/i.test(name)) continue;
      // Use Node's own lookup locations, but grant only an installed dependency's package directory.
      // This also works when the package's exports intentionally hide package.json.
      for (const modules of require.resolve.paths(name) ?? []) {
        const dependency = join(modules, name, "package.json");
        if (!existsSync(dependency)) continue;
        try { include(dependency); } catch { /* absent or malformed optional package remains inaccessible */ }
        break;
      }
    }
  };
  for (let root = dirname(bin); root !== dirname(root); root = dirname(root)) {
    const manifest = join(root, "package.json");
    if (!existsSync(manifest)) continue;
    try {
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
      if (pkg.name === "@openai/codex" || pkg.name === "@anthropic-ai/claude-code") include(manifest);
    } catch { /* standalone executables need no package grant */ }
    break;
  }
  return [...paths];
};

const runtimePaths = (bin: string): string[] => {
  const node = realpathSync(process.execPath);
  const paths = [bin, node];
  // Some Node distributions use a sibling shared library. Grant those files, not lib/ or bin/.
  const nodeLibraries = join(dirname(node), "..", "lib");
  for (const name of existsSync(nodeLibraries) ? readdirSync(nodeLibraries).filter(name => /^libnode.*\.dylib$/.test(name)) : []) {
    const library = resolve(nodeLibraries, name);
    paths.push(library, realpathSync(library));
  }
  paths.push(...cliPackagePaths(bin));
  const companion = join(dirname(bin), "codex-code-mode-host");
  if (existsSync(companion)) paths.push(realpathSync(companion));
  // Homebrew dynamic libraries are immutable runtime inputs, not model/session state.
  for (const root of ["/opt/homebrew/Cellar", "/opt/homebrew/lib", "/opt/homebrew/opt", "/usr/local/Cellar", "/usr/local/lib", "/usr/local/opt"]) {
    if (existsSync(root)) paths.push(realpathSync(root));
  }
  for (const config of ["/opt/homebrew/etc/openssl@3/openssl.cnf", "/usr/local/etc/openssl@3/openssl.cnf"]) if (existsSync(config)) paths.push(realpathSync(config));
  return [...new Set(paths)];
};

const authFile = (env: NodeJS.ProcessEnv, kind: AgentKind): string => kind === "codex"
  ? join(env.CODEX_HOME || join(env.HOME || homedir(), ".codex"), "auth.json")
  : join(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"), ".credentials.json");

const claudeToken = (env: NodeJS.ProcessEnv): string | null => {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return env.CLAUDE_CODE_OAUTH_TOKEN;
  let value: string | undefined;
  try { value = readFileSync(authFile(env, "claude"), "utf8"); } catch { /* macOS uses Keychain */ }
  if (!value && platform() === "darwin") {
    const result = spawnSync("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8", timeout: 5000, maxBuffer: 128 * 1024 });
    if (result.status === 0) value = result.stdout;
  }
  try {
    const parsed = JSON.parse(value ?? "null");
    const token: unknown = parsed?.claudeAiOauth?.accessToken;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch { return null; }
};

const codexCredentials = (env: NodeJS.ProcessEnv): { accessToken: string; accountId?: string; childAuth: string } => {
  try {
    const value = JSON.parse(readFileSync(authFile(env, "codex"), "utf8"));
    if (typeof value.tokens?.access_token !== "string" || !value.tokens.access_token) throw new Error("Missing subscription token");
    const accountId = typeof value.tokens.account_id === "string" ? value.tokens.account_id : undefined;
    let claims: Record<string, unknown> = {};
    try { claims = JSON.parse(Buffer.from(value.tokens.id_token.split(".")[1], "base64url").toString("utf8")); } catch { /* minimal dummy claims below */ }
    const auth = claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
    const token = [Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url"), Buffer.from(JSON.stringify({ sub: "isolated-workflow", exp: Math.floor(Date.now() / 1000) + 86400, "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: auth?.chatgpt_plan_type ?? "plus", chatgpt_user_id: "isolated-workflow" } })).toString("base64url"), "isolated"].join(".");
    return { accessToken: value.tokens.access_token, accountId, childAuth: JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: token, access_token: token, refresh_token: "isolated-no-refresh-token", account_id: accountId }, last_refresh: new Date().toISOString() }) };
  } catch { throw new WorkflowIsolationError("auth_missing", "Codex subscription credentials are unavailable"); }
};

const reconnectInstruction = (kind: AgentKind, env: NodeJS.ProcessEnv): string => kind === "claude" && env.CLAUDE_CODE_OAUTH_TOKEN
  ? "Update CLAUDE_CODE_OAUTH_TOKEN in the daemon environment."
  : `Run ${kind === "claude" ? "claude auth login" : "codex login"} to reconnect.`;

export const workflowIsolationCapability = async (env: NodeJS.ProcessEnv = process.env): Promise<WorkflowIsolationCapability> => {
  const providers = Object.fromEntries((["codex", "claude"] as const).map((kind) => {
    let token: string | null = null;
    try { token = kind === "codex" ? codexCredentials(env).accessToken : claudeToken(env); } catch { /* unavailable */ }
    const blocked = token !== null && workflowAuthBlocked(workflowAuthKey(kind, env), token);
    const available = binary(kind, env) !== null && token !== null && !blocked;
    return [kind, { available, ...(available ? {} : { reason: `${blocked ? `${kind} sign-in expired.` : `${kind} needs its local CLI and subscription sign-in.`} ${reconnectInstruction(kind, env)}` }) }];
  })) as WorkflowIsolationCapability["providers"];
  if (platform() !== "darwin" || !existsSync(SEATBELT)) return { available: false, backend: "unavailable", reason: "Hidden phases need the tested macOS Seatbelt isolation backend; this platform is not supported yet", providers };
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "agoryx-boundary-check-")));
  try {
    const canary = join(directory, "private.txt");
    writeFileSync(canary, "private");
    const child = join(directory, "allowed");
    mkdirSync(child);
    const profile = workflowSandboxProfile({ directory: child, runtimePaths: [] });
    const dataAlias = `/System/Volumes/Data${canary}`;
    const result = spawnSync(SEATBELT, ["-p", profile, "/bin/sh", "-c", 'for file do test ! -r "$file" || exit 1; done; echo boundary-ok', "probe", canary, ...(existsSync(dataAlias) ? [dataAlias] : [])], { cwd: child, encoding: "utf8", timeout: 5000 });
    if (result.status !== 0 || result.stdout.trim() !== "boundary-ok") return { available: false, backend: "unavailable", reason: "The operating-system isolation probe failed; hidden work is disabled", providers };
    const device = spawnSync("/usr/bin/ruby", ["--disable=gems", "-e", DEVICE_BOUNDARY_PROBE, SEATBELT, profile], { cwd: child, encoding: "utf8", timeout: 3000, env: { PATH: "/usr/bin:/bin" } });
    if (device.status !== 0 || device.stdout.trim() !== "device-boundary-ok") return { available: false, backend: "unavailable", reason: "Terminal-device privacy enforcement failed; hidden work is disabled", providers };
    const marker = `hidden-probe-${randomUUID()}`;
    const peer = spawn(process.execPath, ["-e", `setTimeout(() => {}, 10000); // ${marker}`], { env: {}, stdio: "ignore" });
    peer.on("error", () => { /* checked below; never an unhandled child error */ });
    try {
      const args = ["--disable=gems", "-e", WORKFLOW_PROCESS_PROBE, String(peer.pid), marker];
      const control = spawnSync("/usr/bin/ruby", args, { encoding: "utf8", timeout: 3000, env: { PATH: "/usr/bin:/bin" } });
      const probe = spawnSync(SEATBELT, ["-p", profile, "/usr/bin/ruby", ...args, "task"], { cwd: child, encoding: "utf8", timeout: 3000, env: workflowEnvironment(child) });
      const outside = JSON.parse(control.stdout || "null"), inside = JSON.parse(probe.stdout || "null");
      if (control.status !== 0 || !outside?.procargs2Leaked || probe.status !== 0 || inside?.procargs !== -1 || inside?.procargs2 !== -1 || inside?.proc !== -1 || inside?.signal !== "denied" || !inside?.task_for_pid || !inside?.task_name_for_pid) return { available: false, backend: "unavailable", reason: "Cross-process privacy enforcement failed; hidden work is disabled", providers };
    } catch {
      return { available: false, backend: "unavailable", reason: "The process-privacy isolation probe could not run; hidden work is disabled", providers };
    } finally { peer.kill("SIGKILL"); }
    const available = Object.values(providers).some((provider) => provider.available);
    return { available, backend: "seatbelt", ...(available ? {} : { reason: "Sign in to a supported local CLI to run hidden phases" }), providers };
  } finally { rmSync(directory, { recursive: true, force: true }); }
};

/** A small allowlist prevents inherited AGORYX URLs/keys, proxy variables, preload hooks,
 * native-session IDs and application integrations from crossing the boundary. */
export const workflowEnvironment = (directory: string, token?: string): NodeJS.ProcessEnv => ({
  HOME: join(directory, "home"), CODEX_HOME: join(directory, "codex"), CLAUDE_CONFIG_DIR: join(directory, "claude"),
  XDG_CONFIG_HOME: join(directory, "config"), XDG_CACHE_HOME: join(directory, "cache"), XDG_STATE_HOME: join(directory, "state"),
  TMPDIR: join(directory, "tmp"), TMPPREFIX: join(directory, "tmp", "zsh"), CLAUDE_CODE_TMPDIR: join(directory, "tmp"), BUN_TMPDIR: join(directory, "tmp"), SSL_CERT_FILE: "/etc/ssl/cert.pem", PATH: [dirname(realpathSync(process.execPath)), "/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin", "/usr/local/bin"].join(delimiter),
  LANG: "en_US.UTF-8", TERM: "dumb", NO_COLOR: "1", DISABLE_AUTOUPDATER: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}),
});

export const workflowCliArgs = (input: WorkflowExecutionInput, cwd: string, sessionId: string): string[] => {
  if (input.participant.kind === "claude") return [
    "--print", "--output-format", "stream-json", "--verbose", "--safe-mode", "--no-chrome",
    "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--disable-slash-commands", "--no-session-persistence", "--session-id", sessionId,
    "--permission-mode", "acceptEdits", "--permission-prompts", "none",
    "--settings", '{"disableAllHooks":true,"permissions":{"allow":["Bash(*)","Read","Write","Edit","Glob","Grep"],"deny":["WebFetch","WebSearch","Agent"]}}',
    ...(input.participant.model ? ["--model", input.participant.model] : []),
    ...(input.participant.effort ? ["--effort", input.participant.effort] : []),
  ];
  return [
    "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--color", "never",
    "-C", cwd,
    // The outer Seatbelt boundary cannot be disabled or escaped by this native setting.
    // Avoid nesting a second sandbox, which cannot initialize from inside Seatbelt.
    "-s", "danger-full-access", "-c", 'approval_policy="never"', "-c", 'shell_environment_policy.inherit="all"',
    "-c", 'web_search="disabled"', "-c", "mcp_servers={}", "-c", "project_doc_max_bytes=0",
    ...["enable_request_compression", "apps", "plugins", "hooks", "memories", "multi_agent", "browser_use", "browser_use_external", "computer_use", "image_generation", "in_app_browser", "skill_search"].flatMap((feature) => ["--disable", feature]),
    ...(input.participant.model ? ["-m", input.participant.model] : []),
    ...(input.participant.effort ? ["-c", `model_reasoning_effort=${JSON.stringify(input.participant.effort)}`] : []), "-",
  ];
};

interface IsolatedProcessInput {
  binary: string;
  args: string[];
  directory: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  proxyPort?: number;
  stdin: string;
  timeoutMs: number;
  signal: AbortSignal;
  maxBytes: number;
}

/** Exported for a hostile-process test using the exact production enforcement path. */
export const runWorkflowSandbox = async (input: IsolatedProcessInput): Promise<{ stdout: string; stderr: string }> => {
  if (platform() !== "darwin" || !existsSync(SEATBELT)) throw new WorkflowIsolationError("unsupported_platform", "System-enforced hidden phases are unavailable on this platform");
  if (input.signal.aborted) throw new WorkflowIsolationError("cancelled", "Workflow execution cancelled");
  const profile = workflowSandboxProfile({ directory: input.directory, runtimePaths: runtimePaths(input.binary), proxyPort: input.proxyPort });
  return new Promise((resolveResult, reject) => {
    const child = spawn(SEATBELT, ["-p", profile, input.binary, ...input.args], { cwd: input.cwd, env: input.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    const processes = child.pid ? trackWorkflowProcesses(child.pid) : undefined;
    let stdout = "", stderr = "", failure: Error | undefined, settled = false;
    const stdoutDecoder = new StringDecoder("utf8"), stderrDecoder = new StringDecoder("utf8");
    let bytes = 0;
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); input.signal.removeEventListener("abort", abort);
      stdout += stdoutDecoder.end(); stderr += stderrDecoder.end();
      processes?.kill(); processes?.dispose();
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
      if (failure) reject(failure);
      else if (code !== 0) reject(new WorkflowIsolationError("provider_exit", `Isolated agent exited with code ${code}`));
      else resolveResult({ stdout, stderr });
    };
    const stop = (error: Error) => {
      if (settled) return;
      failure ??= error;
      // Kill the process group. A deliberately daemonized descendant may leave that group,
      // but retains Seatbelt and loses its gateway and namespace at cleanup.
      processes?.kill();
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
      // A reparented descendant can retain these pipes after the root exits. Do not
      // wait for its close event: cancellation must reach the executor's finally,
      // which revokes the provider gateway and removes the private namespace.
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      settle(null);
    };
    const abort = () => stop(new WorkflowIsolationError("cancelled", "Workflow execution cancelled"));
    const timer = setTimeout(() => stop(new WorkflowIsolationError("timeout", "Workflow execution exceeded its equal time budget")), input.timeoutMs);
    input.signal.addEventListener("abort", abort, { once: true });
    const capture = (chunk: Buffer, which: "stdout" | "stderr") => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > input.maxBytes) { stop(new WorkflowIsolationError("output_limit", "Workflow execution exceeded its bounded process-output budget")); return; }
      if (which === "stdout") stdout += stdoutDecoder.write(chunk); else stderr += stderrDecoder.write(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => capture(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => capture(chunk, "stderr"));
    child.on("error", (error) => { failure ??= error; });
    child.stdin.on("error", () => { /* process may fail before reading */ });
    child.on("close", settle);
    child.stdin.end(input.stdin);
  });
};

const finalText = (kind: AgentKind, stdout: string): string => {
  let text = "", completed = false;
  for (const line of stdout.split("\n")) {
    let item: Record<string, any>;
    try { item = JSON.parse(line); } catch { continue; }
    if (kind === "codex") {
      if (item.type === "item.completed" && item.item?.type === "agent_message") text = item.item.text ?? "";
      if (item.type === "turn.completed") completed = true;
      if (item.type === "turn.failed") throw new WorkflowIsolationError("provider_exit", "The isolated Codex turn failed");
    } else if (item.type === "result") {
      if (item.is_error) throw new WorkflowIsolationError("provider_exit", "The isolated Claude turn failed");
      text = typeof item.result === "string" ? item.result : ""; completed = true;
    }
  }
  if (!completed || !text.trim()) throw new WorkflowIsolationError("incomplete_output", "Isolated agent returned no complete artifact");
  return text;
};

/** Only explicitly authored regular UTF-8 files in artifacts/ leave the boundary. No native homes,
 * credentials, tool logs, symlinks, executable output or surrounding workspace is exported. */
const artifactText = (root: string, remaining: number): string => {
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new WorkflowIsolationError("artifact_invalid", "The artifact root must be a real directory");
  let output = "", count = 0, directories = 0;
  const visit = (directory: string, prefix: string, depth = 0) => {
    if (++directories > 32 || depth > 8) throw new WorkflowIsolationError("artifact_invalid", "Artifact directories exceeded the export limit");
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(directory, entry.name), name = `${prefix}${entry.name}`;
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new WorkflowIsolationError("artifact_invalid", "Artifact export refused a symlink");
      if (stat.isDirectory()) { visit(file, `${name}/`, depth + 1); continue; }
      if (!stat.isFile() || stat.nlink > 1) throw new WorkflowIsolationError("artifact_invalid", "Artifact export requires standalone regular files");
      // Files are sized in UTF-8 bytes; the shared budget is measured in decoded characters.
      if (++count > 16 || stat.size > 256 * 1024 || stat.size > remaining * 4) throw new WorkflowIsolationError("output_limit", "Artifact export exceeded its bounded text-file budget");
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      let buffer: Buffer;
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) throw new WorkflowIsolationError("artifact_invalid", "Artifact changed during export");
        buffer = readFileSync(fd);
      } finally { closeSync(fd); }
      const content = buffer.toString("utf8");
      if (buffer.includes(0) || !Buffer.from(content).equals(buffer)) throw new WorkflowIsolationError("artifact_invalid", "Artifact export only supports UTF-8 text files");
      const fence = "`".repeat(Math.max(3, ...[...content.matchAll(/`+/g)].map((match) => match[0].length + 1)));
      output += `\n\nArtifact: ${name}\n${fence}\n${content}\n${fence}`;
      if (output.length > remaining) throw new WorkflowIsolationError("output_limit", "Artifact export exceeded the equal output budget");
    }
  };
  visit(root, "");
  return output;
};

export const createWorkflowExecutor = (options: { env?: NodeJS.ProcessEnv } = {}): WorkflowExecutor => async (input) => {
  const sourceEnv = options.env ?? process.env;
  const capability = await workflowIsolationCapability(sourceEnv);
  if (!capability.available || !capability.providers[input.participant.kind].available) throw new WorkflowIsolationError(capability.backend === "unavailable" ? "sandbox_unavailable" : "auth_missing", capability.backend === "unavailable" ? capability.reason ?? "Hidden-phase isolation unavailable" : capability.providers[input.participant.kind].reason ?? "Subscription authentication unavailable");
  const bin = binary(input.participant.kind, sourceEnv)!;
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "agoryx-hidden-")));
  let sealed: string | undefined;
  let proxy: Awaited<ReturnType<typeof createWorkflowProxy>> | undefined;
  try {
    const codex = input.participant.kind === "codex" ? codexCredentials(sourceEnv) : undefined;
    const token = input.participant.kind === "claude" ? claudeToken(sourceEnv) : codex?.accessToken;
    if (!token) throw new WorkflowIsolationError("auth_missing", "Subscription credentials are unavailable");
    const kind = input.participant.kind;
    const authentication = createWorkflowAuthentication({
      key: workflowAuthKey(kind, sourceEnv),
      read: () => {
        try {
          if (kind === "codex") return codexCredentials(sourceEnv);
          const current = claudeToken(sourceEnv);
          return current ? { accessToken: current } : null;
        } catch { return null; }
      },
      canRefresh: kind !== "claude" || !sourceEnv.CLAUDE_CODE_OAUTH_TOKEN,
      refresh: (signal) => refreshNativeWorkflowAuth(kind, bin, sourceEnv, signal),
    });
    try { proxy = await createWorkflowProxy({ kind, accessToken: token, accountId: codex?.accountId, authentication }); }
    catch { throw new WorkflowIsolationError("network_unavailable", "The private provider broker could not start"); }
    const env = workflowEnvironment(directory, input.participant.kind === "claude" ? "sk-ant-oat01-isolated-workflow-placeholder" : undefined);
    for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"]) env[key] = `http://127.0.0.1:${proxy.port}`;
    for (const path of [env.HOME, env.CODEX_HOME, env.CLAUDE_CONFIG_DIR, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME, env.TMPDIR]) mkdirSync(path!, { mode: 0o700 });
    if (codex) writeFileSync(join(env.CODEX_HOME!, "auth.json"), codex.childAuth, { mode: 0o600 });
    const cert = join(directory, "provider-ca.pem"); writeFileSync(cert, proxy.certificate, { mode: 0o600 });
    env.SSL_CERT_FILE = cert; env.CODEX_CA_CERTIFICATE = cert; env.NODE_EXTRA_CA_CERTS = cert;
    const cwd = join(directory, "work"); mkdirSync(cwd, { mode: 0o700 });
    const artifacts = join(cwd, "artifacts"); mkdirSync(artifacts, { mode: 0o700 });
    const prompt = `${input.prompt}\n\nExecution environment: a fresh system-isolated workspace. Only the task above and files you create here are available. No other agents' files, messages, native sessions, or host APIs are accessible. If the task requests a prototype or implementation, you may write self-contained UTF-8 files under artifacts/; they will be exported with your final answer. Keep structured JSON answers as requested by the task and do not write artifact files for JSON-only review steps. You may run local commands to verify your work. External network access is restricted to the model provider. The final answer and any exported file content share a ${input.budget.maxOutputChars}-character budget.`;
    let result: { stdout: string; stderr: string };
    try { result = await runWorkflowSandbox({ binary: bin, args: workflowCliArgs(input, cwd, randomUUID()), directory, cwd, env, proxyPort: proxy.port, stdin: prompt, timeoutMs: input.budget.timeoutMs, signal: input.signal, maxBytes: Math.max(1024 * 1024, input.budget.maxOutputChars * 32) }); }
    catch (error) {
      if (proxy.authenticationFailed()) throw new WorkflowIsolationError("auth_missing", `${kind} authentication expired. ${reconnectInstruction(kind, sourceEnv)}`);
      throw error;
    }
    const text = finalText(input.participant.kind, result.stdout);
    if (text.length > input.budget.maxOutputChars) throw new WorkflowIsolationError("output_limit", "Artifact exceeded the equal output budget");
    const authoring = ["creation", "repair", "answers", "prototypes", "implementation", "synthesis", "steelman", "steelman_repair"].includes(input.phase);
    // Seal the namespace before the trusted parent reads any files. Even a detached descendant
    // retains permission only for the original path, never this unpredictable export path.
    sealed = realpathSync(mkdtempSync(join(tmpdir(), "agoryx-sealed-")));
    renameSync(directory, sealed);
    return { text: text + (authoring ? artifactText(join(sealed, "work", "artifacts"), input.budget.maxOutputChars - text.length) : "") };
  } finally { await proxy?.close(); rmSync(directory, { recursive: true, force: true }); if (sealed) rmSync(sealed, { recursive: true, force: true }); }
};
