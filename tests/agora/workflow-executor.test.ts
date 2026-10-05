import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { connect } from "node:net";
import { chmodSync, closeSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createWorkflowExecutor, isPublicProviderAddress, runWorkflowSandbox, WORKFLOW_PROCESS_PROBE, workflowCliArgs, workflowEnvironment, workflowSandboxProfile } from "../../internal/agora/workflow-executor.js";
import { createWorkflowProxy, permittedWorkflowRequest, safeWorkflowPayload, sanitizeWorkflowPayload } from "../../internal/agora/workflow-proxy.js";
import type { WorkflowExecutionInput } from "../../internal/agora/workflow-types.js";

const seatbelt = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
const input = (kind: "codex" | "claude" = "codex"): WorkflowExecutionInput => ({
  roomId: "room", runId: "run", phase: "prototypes", participant: { id: kind, label: kind, kind },
  prompt: "Build a prototype", budget: { timeoutMs: 5000, maxOutputChars: 8000, maxRounds: 1 }, signal: new AbortController().signal,
});
const temp = () => realpathSync(mkdtempSync(join(tmpdir(), "agora-isolation-test-")));

test("provider broker never accepts local, private, metadata, or reserved destinations", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "172.16.1.2", "192.168.1.2", "169.254.169.254", "100.64.1.2", "198.18.0.2", "0.0.0.0", "224.0.0.1", "::1", "::ffff:127.0.0.1", "192.0.2.1", "203.0.113.2"]) assert.equal(isPublicProviderAddress(address), false, address);
  assert.equal(isPublicProviderAddress("104.18.32.47"), true);
});

test("generation gateway rejects histories, saved item references, hosted tools, and unknown extensions", () => {
  const clean = { model: "test", input: [{ role: "user", content: "hello" }], tools: [{ type: "function", name: "local", parameters: {} }] };
  assert(safeWorkflowPayload(clean));
  for (const extra of [{ previous_response_id: "resp_peer" }, { conversation: "peer" }, { container: "peer" }, { future_account_tool: {} }]) assert.equal(safeWorkflowPayload({ ...clean, ...extra }), false);
  for (const item of [{ id: "msg_other_session" }, { type: "item_reference", id: "msg_other_session" }, { type: "additional_tools", role: "developer", tools: [{ type: "file_search", vector_store_ids: ["vs_peer"] }] }, { role: "user", content: [{ type: "input_file", file_id: "file_peer" }] }, { role: "user", content: [{ type: "input_image", image_url: "https://example.com/peer" }] }]) assert.equal(safeWorkflowPayload({ ...clean, input: [item] }), false);
  assert.equal(safeWorkflowPayload({ ...clean, tools: [{ type: "web_search" }] }), false);
  assert.equal(safeWorkflowPayload({ ...clean, tool_choice: { type: "file_search", vector_store_ids: ["vs_peer"] } }), false);
  for (const path of ["/backend-api/conversations", "/backend-api/codex/responses/resp_peer", "/backend-api/codex/models?conversation=peer", "/backend-api/codex/%2e%2e/conversations", "//evil.test/backend-api/codex/models"]) assert.equal(permittedWorkflowRequest("codex", "GET", "chatgpt.com", path), false, path);
  assert(permittedWorkflowRequest("codex", "POST", "chatgpt.com", "/backend-api/codex/responses"));
  assert(permittedWorkflowRequest("claude", "POST", "api.anthropic.com", "/v1/messages?beta=true"));
  const native = { model: "test", client_metadata: { trace: "private" }, input: [{ type: "additional_tools", id: "remote", role: "developer", tools: [{ type: "namespace", name: "functions", tools: [{ type: "function", name: "exec", parameters: {} }] }] }, { type: "message", id: "remote", role: "user", content: [{ type: "input_text", text: "hello" }], internal_chat_message_metadata_passthrough: { trace: "private" } }] };
  assert(safeWorkflowPayload(native));
  const normalized = sanitizeWorkflowPayload(native, "codex");
  assert.equal(normalized.input.length, 1); assert.equal(normalized.input[0].id, undefined); assert.equal(normalized.input[0].internal_chat_message_metadata_passthrough, undefined); assert.equal(normalized.client_metadata, undefined);
  assert.equal(normalized.tools[0].tools[0].type, "function"); assert.equal(normalized.store, false);
  native.input[0]!.tools![0]!.tools[0]!.type = "file_search";
  assert.equal(safeWorkflowPayload(native), false);
});

test("private environment and CLI arguments have no room integration, global hooks, or resume", () => {
  const env = workflowEnvironment("/private/task");
  for (const key of ["AGORYX_HOME", "AGORYX_URL", "AGORYX_AGENT_KEY", "NODE_OPTIONS", "BASH_ENV", "CLAUDECODE", "CODEX_THREAD_ID", "HTTP_PROXY"]) assert.equal(env[key], undefined);
  assert.equal(env.CODEX_HOME, "/private/task/codex");
  assert.equal(env.TMPPREFIX, "/private/task/tmp/zsh");
  for (const kind of ["codex", "claude"] as const) {
    const args = workflowCliArgs(input(kind), "/private/task/work", "fresh-id");
    assert(!args.includes("--resume") && !args.includes("resume"));
    assert(!args.includes("--continue"));
    assert(!args.includes("--add-dir"));
    if (kind === "codex") { assert(args.includes("--ephemeral")); assert(args.includes("--ignore-user-config")); }
    else { assert(args.includes("--safe-mode")); assert(args.includes("--strict-mcp-config")); assert(args.includes("--no-session-persistence")); }
  }
  const profile = workflowSandboxProfile({ directory: "/private/task", runtimePaths: [], proxyPort: 41000 });
  assert(profile.includes('(remote tcp "localhost:41000")'));
  assert(!profile.includes('(allow network*)'));
  assert(!profile.includes('(subpath "/dev")'));
  assert.throws(() => workflowSandboxProfile({ directory: "/private/task", runtimePaths: [], proxyPort: 0 }));
});

test("native login shells can create heredocs using only private temporary storage", { skip: !seatbelt }, async () => {
  const directory = temp(); mkdirSync(join(directory, "tmp"));
  try {
    for (const shell of ["/bin/sh", "/bin/bash", "/bin/zsh"]) {
      const name = shell.split("/").at(-1)!;
      const result = await runWorkflowSandbox({ binary: shell, args: ["-lc", `cat <<'END' > ${name}.txt\nPRIVATE_HEREDOC\nEND\ncat ${name}.txt`], directory, cwd: directory, env: workflowEnvironment(directory), stdin: "", timeoutMs: 3000, signal: new AbortController().signal, maxBytes: 10000 });
      assert.equal(result.stdout, "PRIVATE_HEREDOC\n", shell); assert.equal(result.stderr, "", shell);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("user-local Node and npm CLI payloads run without exposing the enclosing prefix or native homes", { skip: !seatbelt }, () => {
  const root = temp(), prefix = join(root, "local-node"), directory = join(root, "worker");
  const node = join(prefix, "bin", "node");
  const modules = join(prefix, "lib", "node_modules");
  const cli = join(modules, "@openai", "codex"), payload = join(modules, "@openai", "codex-darwin-arm64");
  const binary = join(cli, "bin", "codex.mjs"), companion = join(payload, "bin", "codex");
  const credential = join(root, ".codex", "auth.json"), sibling = join(prefix, "bin", "private.txt");
  const unrelated = join(modules, "unrelated", "secret.txt");
  for (const folder of [join(prefix, "bin"), join(cli, "bin"), join(payload, "bin"), join(root, ".codex"), join(modules, "unrelated"), directory]) mkdirSync(folder, { recursive: true });
  try {
    copyFileSync(realpathSync(process.execPath), node); chmodSync(node, 0o755);
    // Homebrew's Node launcher uses a sibling libnode; standalone Node builds do not.
    const libraries = join(dirname(realpathSync(process.execPath)), "..", "lib");
    for (const name of existsSync(libraries) ? readdirSync(libraries).filter(name => /^libnode.*\.dylib$/.test(name)) : []) {
      symlinkSync(realpathSync(join(libraries, name)), join(prefix, "lib", name));
    }
    for (const file of [credential, sibling, unrelated]) writeFileSync(file, "PRIVATE_HOST_DATA");
    writeFileSync(join(cli, "package.json"), JSON.stringify({ name: "@openai/codex", type: "module", optionalDependencies: { "@openai/codex-darwin-arm64": "1.0.0" } }));
    writeFileSync(join(payload, "package.json"), JSON.stringify({ name: "@openai/codex-darwin-arm64", exports: { ".": "./bin/codex" } }));
    writeFileSync(companion, '#!/bin/sh\nprintf "native-payload"\n'); chmodSync(companion, 0o755);
    writeFileSync(binary, `#!/usr/bin/env node
import fs from 'node:fs'; import {execFileSync} from 'node:child_process';
const denied = path => { try { fs.readFileSync(path); return false; } catch (e) { return ['EPERM','EACCES'].includes(e.code); } };
console.log(JSON.stringify({ node: process.execPath, package: JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).name,
payload: execFileSync(${JSON.stringify(companion)}, {encoding:'utf8'}), denied: ${JSON.stringify([credential, sibling, unrelated])}.map(denied) }));
`); chmodSync(binary, 0o755);
    const script = `import {runWorkflowSandbox, workflowEnvironment} from ${JSON.stringify(new URL("../../internal/agora/workflow-executor.ts", import.meta.url).href)};
const result = await runWorkflowSandbox({ binary: ${JSON.stringify(binary)}, args: [], directory: ${JSON.stringify(directory)}, cwd: ${JSON.stringify(directory)}, env: workflowEnvironment(${JSON.stringify(directory)}), stdin:'', timeoutMs:5000, signal:new AbortController().signal, maxBytes:10000 }); console.log(result.stdout);`;
    const result = spawnSync(node, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { node, package: "@openai/codex", payload: "native-payload", denied: [true, true, true] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("broker rejects room APIs and arbitrary hosts even through its allowed socket", async () => {
  const proxy = await createWorkflowProxy({kind:"codex",accessToken:"parent-secret"});
  try {
    for (const target of ["127.0.0.1:443", "localhost:7717", "chatgpt.com:7717", "evil.test:443", "chatgpt.com.evil.test:443"]) {
      const response = await new Promise<string>((resolve, reject) => {
        const socket = connect(proxy.port, "127.0.0.1", () => socket.end(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
        let output = ""; socket.on("data", (chunk) => { output += chunk; }); socket.on("end", () => resolve(output)); socket.on("error", reject);
      });
      assert(response.startsWith("HTTP/1.1 403"), target);
    }
  } finally { await proxy.close(); }
});

test("TLS gateway blocks cloud histories and reference-bearing generation from the actual sandbox", { skip: !seatbelt }, async () => {
  const directory = temp(), proxy = await createWorkflowProxy({ kind: "codex", accessToken: "PARENT_SECRET_NEVER_IN_WORKER" });
  const ca = join(directory, "ca.pem"); writeFileSync(ca, proxy.certificate);
  try {
    for (const args of [
      ["https://chatgpt.com/backend-api/conversations"],
      ["https://chatgpt.com/backend-api/codex/responses", "-H", "content-type: application/json", "--data", JSON.stringify({ model: "test", input: [{ id: "msg_peer" }] })],
    ]) {
      const result = await runWorkflowSandbox({ binary: "/usr/bin/curl", args: ["--silent", "--show-error", "--max-time", "5", "--cacert", ca, "--proxy", `http://127.0.0.1:${proxy.port}`, "--write-out", "\n%{http_code}", ...args], directory, cwd: directory, env: workflowEnvironment(directory), proxyPort: proxy.port, stdin: "", timeoutMs: 6000, signal: new AbortController().signal, maxBytes: 10000 });
      assert(result.stdout.endsWith("\n403")); assert(!result.stdout.includes("PARENT_SECRET_NEVER_IN_WORKER"));
    }
  } finally { await proxy.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("real kernel denies peer files, native histories, symlink escape, and host HTTP while own work runs", { skip: !seatbelt }, async () => {
  const root = temp();
  const directory = join(root, "participant-a"); mkdirSync(directory);
  const other = join(root, "participant-b"); mkdirSync(other);
  const secret = join(other, "native-history.jsonl"); writeFileSync(secret, "PEER_SECRET");
  const dataAlias = `/System/Volumes/Data${secret}`;
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.end("ROOM_SECRET"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const script = join(directory, "probe.mjs");
  writeFileSync(script, `import fs from 'node:fs';
    const denied = (f) => { try { f(); return false; } catch (e) { return e.code === 'EPERM' || e.code === 'EACCES'; } };
    fs.writeFileSync('own.txt','OWN_WORK');
    fs.symlinkSync(${JSON.stringify(secret)}, 'escape');
    const result={own:fs.readFileSync('own.txt','utf8'),read:denied(()=>fs.readFileSync(${JSON.stringify(secret)})),dataAlias:${existsSync(dataAlias) ? `denied(()=>fs.readFileSync(${JSON.stringify(dataAlias)}))` : "true"},list:denied(()=>fs.readdirSync(${JSON.stringify(other)})),write:denied(()=>fs.writeFileSync(${JSON.stringify(secret)},'overwrite')),symlink:denied(()=>fs.readFileSync('escape'))};
    try { await fetch('http://127.0.0.1:${port}/api/rooms', {signal:AbortSignal.timeout(1000)}); result.http=false; } catch {result.http=true;}
    console.log(JSON.stringify(result));`);
  try {
    const result = await runWorkflowSandbox({ binary: realpathSync(process.execPath), args: [script], directory, cwd: directory, env: workflowEnvironment(directory), stdin: "", timeoutMs: 5000, signal: new AbortController().signal, maxBytes: 10000 });
    assert.deepEqual(JSON.parse(result.stdout), { own: "OWN_WORK", read: true, dataAlias: true, list: true, write: true, symlink: true, http: true });
    assert.equal(requests, 0);
    assert.equal(readFileSync(secret, "utf8"), "PEER_SECRET");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});

test("direct numeric syscalls cannot read peer process arguments, environment, process info or task ports", { skip: !seatbelt }, async () => {
  const directory = temp(), marker = "WORKFLOW_PROCESS_TRACE_CANARY";
  const peer = spawn(process.execPath, ["-e", `setTimeout(() => {}, 10000); // ${marker}`], { env: { PRIVATE_WORKFLOW_ENV: marker }, stdio: "ignore" });
  const args = ["--disable=gems", "-e", WORKFLOW_PROCESS_PROBE, String(peer.pid), marker];
  try {
    const control = spawnSync("/usr/bin/ruby", args, { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    assert.equal(control.status, 0); assert.equal(JSON.parse(control.stdout).procargs2Leaked, true, "outside control must really see the canary");
    const result = await runWorkflowSandbox({ binary: "/usr/bin/ruby", args: [...args, "task"], directory, cwd: directory, env: workflowEnvironment(directory), stdin: "", timeoutMs: 5000, signal: new AbortController().signal, maxBytes: 10000 });
    const inside = JSON.parse(result.stdout);
    assert.equal(inside.procargs, -1); assert.equal(inside.procargs2, -1); assert.equal(inside.proc, -1);
    assert.equal(inside.procargsLeaked, false); assert.equal(inside.procargs2Leaked, false);
    assert.equal(inside.signal, "denied");
    assert.notEqual(inside.task_for_pid, 0); assert.notEqual(inside.task_name_for_pid, 0);
  } finally { peer.kill("SIGKILL"); rmSync(directory, { recursive: true, force: true }); }
});

test("workers may stop their own tools but cannot signal a separate workflow sandbox", { skip: !seatbelt }, async () => {
  const root = temp(), peer = join(root, "peer"), own = join(root, "own"); mkdirSync(peer); mkdirSync(own);
  const controller = new AbortController();
  const waiting = runWorkflowSandbox({ binary: realpathSync(process.execPath), args: ["-e", 'require("fs").writeFileSync("pid",String(process.pid));setTimeout(()=>{},10000);'], directory: peer, cwd: peer, env: workflowEnvironment(peer), stdin: "", timeoutMs: 12000, signal: controller.signal, maxBytes: 10000 }).catch((error) => error);
  try {
    for (let n = 0; n < 200 && !existsSync(join(peer, "pid")); n++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert(existsSync(join(peer, "pid")), "our sibling sandbox fixture must start");
    const peerPid = Number(readFileSync(join(peer, "pid"), "utf8"));
    const source = `const child=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:'ignore'});child.on('spawn',()=>{let own=false,peer;try{own=child.kill('SIGTERM')}catch{}try{process.kill(${peerPid},0);peer='allowed'}catch(e){peer=e.code}console.log(JSON.stringify({own,peer}));});`;
    const result = await runWorkflowSandbox({ binary: realpathSync(process.execPath), args: ["-e", source], directory: own, cwd: own, env: workflowEnvironment(own), stdin: "", timeoutMs: 3000, signal: new AbortController().signal, maxBytes: 10000 });
    assert.deepEqual(JSON.parse(result.stdout), { own: true, peer: "EPERM" });
    process.kill(peerPid, 0); // The trusted parent still sees its own live fixture.
  } finally { controller.abort(); await waiting; rmSync(root, { recursive: true, force: true }); }
});

test("hidden workers cannot open a different terminal even when the host user owns it", { skip: !seatbelt }, async () => {
  const directory = temp();
  // Create our own terminal rather than enumerating or touching an existing user's PTY.
  const peer = spawn("/usr/bin/ruby", ["--disable=gems", "-rpty", "-e", 'STDOUT.sync=true; PTY.open { |master,slave| puts slave.path; sleep 10 }'], { stdio: ["ignore", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin" } });
  try {
    const device = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Fixture terminal did not start")), 3000);
      let output = "";
      peer.stdout.on("data", (chunk) => {
        output += chunk;
        const match = output.match(/\/dev\/ttys\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
      peer.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    closeSync(openSync(device, constants.O_RDONLY | constants.O_NONBLOCK));
    const result = await runWorkflowSandbox({ binary: "/usr/bin/ruby", args: ["--disable=gems", "-e", 'begin; File.open(ARGV[0], File::RDONLY | File::NONBLOCK); puts "opened-peer-terminal"; rescue Errno::EPERM, Errno::EACCES; puts "terminal-denied"; end', device], directory, cwd: directory, env: workflowEnvironment(directory), stdin: "", timeoutMs: 3000, signal: new AbortController().signal, maxBytes: 10000 });
    assert.equal(result.stdout.trim(), "terminal-denied");
  } finally { peer.kill("SIGKILL"); rmSync(directory, { recursive: true, force: true }); }
});

test("tracked tools that create a separate session are stopped without signaling unrelated processes", { skip: !seatbelt }, async () => {
  const directory = temp(); let descendant: number | undefined;
  try {
    const result = await runWorkflowSandbox({ binary: "/bin/sh", args: ["-c", "/usr/bin/perl -MPOSIX -e 'POSIX::setsid(); sleep 10' </dev/null >/dev/null 2>&1 & echo $!; sleep .4"], directory, cwd: directory, env: workflowEnvironment(directory), stdin: "", timeoutMs: 5000, signal: new AbortController().signal, maxBytes: 10000 });
    descendant = Number(result.stdout.trim()); assert(descendant > 1);
    let state = "";
    for (let n = 0; n < 30; n++) {
      state = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(descendant)], { encoding: "utf8" }).stdout.trim();
      if (!state || state.startsWith("Z")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(!state || state.startsWith("Z"), `detached fixture still active: ${state}`);
  } finally { if (descendant) { try { process.kill(descendant, "SIGKILL"); } catch { /* gone */ } } rmSync(directory, { recursive: true, force: true }); }
});

test("whole-process boundary applies to subprocesses, preserves split UTF-8 and enforces timeout", { skip: !seatbelt }, async () => {
  const root = temp(); const directory = join(root, "child"); mkdirSync(directory);
  const secret = join(root, "secret"); writeFileSync(secret, "HIDDEN");
  try {
    const result = await runWorkflowSandbox({ binary: "/bin/sh", args: ["-c", 'if /bin/cat "$1" 2>/dev/null; then exit 9; fi; printf "\\320"; sleep .03; printf "\\237\\321\\200\\320\\270\\320\\262\\321\\226\\321\\202"', "probe", secret], directory, cwd: directory, env: workflowEnvironment(directory), stdin: "", timeoutMs: 5000, signal: new AbortController().signal, maxBytes: 10000 });
    assert.equal(result.stdout, "Привіт");
    await assert.rejects(runWorkflowSandbox({ binary: "/bin/sh", args: ["-c", "sleep 30"], directory, cwd: directory, env: workflowEnvironment(directory), stdin: "", timeoutMs: 30, signal: new AbortController().signal, maxBytes: 10000 }), (error: any) => error.code === "timeout");
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runWorkflowSandbox({ binary: "/bin/echo", args: ["bad"], directory, cwd: directory, env: workflowEnvironment(directory), stdin: "", timeoutMs: 5000, signal: controller.signal, maxBytes: 10000 }), (error: any) => error.code === "cancelled");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("timeout and cancellation settle even when reparented fixtures retain output pipes", { skip: !seatbelt }, async () => {
  for (const cancel of [false, true]) {
    const directory = temp(), controller = new AbortController();
    const script = '$|=1; select(undef,undef,undef,.04); if(fork()){exit(0)}; POSIX::setsid(); if(fork()){exit(0)}; open(my $f,">pid"); print $f "$$"; close($f); sleep 10;';
    const run = runWorkflowSandbox({ binary: "/usr/bin/perl", args: ["-MPOSIX", "-e", script], directory, cwd: directory, env: workflowEnvironment(directory), stdin: "", timeoutMs: cancel ? 5000 : 250, signal: controller.signal, maxBytes: 10000 });
    const abortTimer = cancel ? setTimeout(() => controller.abort(), 250) : undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await assert.rejects(Promise.race([run, new Promise<never>((_resolve, reject) => { watchdog = setTimeout(() => reject(new Error("Inherited pipes prevented bounded cancellation")), 2000); })]), (error: any) => error.code === (cancel ? "cancelled" : "timeout"));
    } finally {
      clearTimeout(watchdog); clearTimeout(abortTimer);
      if (existsSync(join(directory, "pid"))) {
        const pid = Number(readFileSync(join(directory, "pid"), "utf8"));
        if (Number.isInteger(pid) && pid > 1) { try { process.kill(pid, "SIGKILL"); } catch { /* fixture already stopped */ } }
      }
      await run.catch(() => {}); rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("sealing a finished namespace prevents a worker from swapping export paths", { skip: !seatbelt }, async () => {
  const root = temp(), directory = join(root, "work"), sealed = join(root, "sealed"); mkdirSync(directory);
  const script = join(directory, "race.mjs");
  writeFileSync(script, `import fs from 'node:fs'; fs.writeFileSync('ready','yes'); let n=0; const timer=setInterval(()=>{try{fs.symlinkSync('/etc/hosts','escape');fs.unlinkSync('escape');}catch(e){console.log(e.code);clearInterval(timer);}if(++n>100)clearInterval(timer)},10);`);
  try {
    const pending = runWorkflowSandbox({ binary: realpathSync(process.execPath), args: [script], directory, cwd: directory, env: workflowEnvironment(directory), stdin: "", timeoutMs: 5000, signal: new AbortController().signal, maxBytes: 10000 });
    for (let n = 0; n < 100 && !existsSync(join(directory, "ready")); n++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert(existsSync(join(directory, "ready")));
    renameSync(directory, sealed);
    assert.match((await pending).stdout, /EPERM|EACCES/);
    assert(!existsSync(join(sealed, "escape")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("executor starts fresh native homes per participant and exports only authored files", { skip: !seatbelt }, async () => {
  const root = temp();
  const auth = join(root, "auth"); mkdirSync(auth); writeFileSync(join(auth, "auth.json"), '{"tokens":{"access_token":"parent-secret","id_token":"fake","account_id":"test"}}');
  const bin = join(root, "fake-codex");
  writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(realpathSync(process.execPath))} -e 'const fs=require("fs"); let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{if(s.startsWith("ROOT_ESCAPE")){fs.rmSync("artifacts",{recursive:true});fs.symlinkSync(${JSON.stringify(auth)},"artifacts")}else if(s.startsWith("UNICODE")){fs.writeFileSync("artifacts/uk.txt","Ї".repeat(4000))}else{fs.writeFileSync("artifacts/prototype.js","console.log(42);\\n");}const text=JSON.stringify({cwd:process.cwd(),home:process.env.CODEX_HOME,agoryx:process.env.AGORYX_HOME??null,credential:fs.existsSync(process.env.CODEX_HOME+"/auth.json"),secretPresent:fs.readFileSync(process.env.CODEX_HOME+"/auth.json","utf8").includes("parent-secret")});console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text}}));console.log(JSON.stringify({type:"turn.completed"}));});'\n`);
  chmodSync(bin, 0o755);
  const run = createWorkflowExecutor({ env: { ...process.env, AGORYX_CODEX_BIN: bin, CODEX_HOME: auth, AGORYX_HOME: root } });
  try {
    const [first, second] = await Promise.all([run(input()), run(input())]);
    const metadata = (text: string) => JSON.parse(text.split("\n\nArtifact:")[0]!);
    const a = metadata(first.text), b = metadata(second.text);
    assert.notEqual(a.home, b.home); assert.notEqual(a.cwd, b.cwd);
    assert.equal(a.agoryx, null); assert.equal(a.credential, true); assert.equal(a.secretPresent, false);
    assert(first.text.includes("Artifact: prototype.js") && first.text.includes("console.log(42)"));
    assert(!first.text.includes('"test":"credential"'));
    assert(!existsSync(a.home) && !existsSync(b.home));
    const json = await run({ ...input(), phase: "review" });
    assert.doesNotThrow(() => JSON.parse(json.text));
    await assert.rejects(run({ ...input(), prompt: "ROOT_ESCAPE" }), (error: any) => error.code === "artifact_invalid");
    const unicode = await run({ ...input(), prompt: "UNICODE", budget: { ...input().budget, maxOutputChars: 6000 } });
    assert(unicode.text.includes("Ї".repeat(4000)));
    assert(unicode.text.length <= 6000);
    assert(Buffer.byteLength(unicode.text) > 6000, "UTF-8 bytes may exceed the decoded character budget");
    await assert.rejects(run({ ...input(), prompt: "UNICODE", budget: { ...input().budget, maxOutputChars: 4100 } }), (error: any) => error.code === "output_limit");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
