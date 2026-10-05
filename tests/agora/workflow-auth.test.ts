import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as requestHttps } from "node:https";
import { connect } from "node:net";
import { PassThrough } from "node:stream";
import { connect as connectTls } from "node:tls";
import { test } from "node:test";
import { createWorkflowAuthentication, nativeWorkflowAuthArgs, workflowAuthBlocked } from "../../internal/agora/workflow-auth.js";
import { createWorkflowProxy } from "../../internal/agora/workflow-proxy.js";

const gatewayRequest = async (proxy: Awaited<ReturnType<typeof createWorkflowProxy>>): Promise<string> => {
  const socket = connect(proxy.port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("connect", () => socket.write("CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\n"));
    socket.once("data", (chunk) => { assert(chunk.toString().startsWith("HTTP/1.1 200")); resolve(); });
  });
  return new Promise<string>((resolve, reject) => {
    const tls = connectTls({ socket, servername: "chatgpt.com", ca: proxy.certificate });
    let result = "";
    tls.on("error", reject); tls.setTimeout(3000, () => { tls.destroy(); reject(new Error("Gateway response timed out")); });
    tls.once("secureConnect", () => {
      const body = JSON.stringify({ model: "test", input: "hello" });
      tls.write(`POST /backend-api/codex/responses HTTP/1.1\r\nHost: chatgpt.com\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    });
    tls.on("data", (chunk) => { result += chunk; }); tls.on("end", () => resolve(result));
  });
};

test("same-account refresh is coalesced and a changed native token clears stale auth state", async () => {
  const key = randomUUID(); let token = "old", calls = 0, release!: () => void;
  const auth = createWorkflowAuthentication({ key, read: () => ({ accessToken: token }), refresh: async () => { calls++; await new Promise<void>((resolve) => { release = resolve; }); token = "new"; } });
  const first = auth.recover("old", new AbortController().signal), second = auth.recover("old", new AbortController().signal);
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(calls, 1); release();
  assert.deepEqual(await Promise.all([first, second]), [{ accessToken: "new" }, { accessToken: "new" }]);
  assert.deepEqual(await auth.recover("old", new AbortController().signal), { accessToken: "new" }); assert.equal(calls, 1);
  auth.invalidate("new"); assert.equal(auth.current(), null); token = "login-replaced"; assert.equal(auth.current()?.accessToken, token);
});

test("failed refresh and immutable environment tokens fail closed without a retry loop", async () => {
  for (const canRefresh of [false, true]) {
    const key = randomUUID(); let calls = 0;
    const auth = createWorkflowAuthentication({ key, canRefresh, read: () => ({ accessToken: "old" }), refresh: async () => { calls++; throw new Error("must never expose raw provider output"); } });
    assert.equal(await auth.recover("old", new AbortController().signal), null);
    assert.equal(await auth.recover("old", new AbortController().signal), null);
    assert.equal(calls, canRefresh ? 1 : 0); assert(workflowAuthBlocked(key, "old")); assert.equal(auth.current(), null);
  }
});

test("cancelling one refresh waiter preserves another; cancelling all stops the helper", async () => {
  let token = "old", release!: () => void, helperSignal: AbortSignal | undefined;
  const auth = createWorkflowAuthentication({ key: randomUUID(), read: () => ({ accessToken: token }), refresh: async (signal) => { helperSignal = signal; await new Promise<void>((resolve) => { release = resolve; signal.addEventListener("abort", () => resolve(), { once: true }); }); if (!signal.aborted) token = "new"; } });
  const first = new AbortController(), second = new AbortController();
  const one = auth.recover("old", first.signal), two = auth.recover("old", second.signal);
  await new Promise((resolve) => setImmediate(resolve)); first.abort(); assert.equal(await one, null); assert.equal(helperSignal?.aborted, false);
  release(); assert.equal((await two)?.accessToken, "new");
  token = "old-again"; const last = new AbortController(), pending = auth.recover(token, last.signal);
  await new Promise((resolve) => setImmediate(resolve)); last.abort(); assert.equal(await pending, null); assert.equal(helperSignal?.aborted, true); assert.notEqual(auth.current(), null);
});

test("native refresh arguments use a fixed tool-free Claude turn or only the Codex account server", () => {
  const claude = nativeWorkflowAuthArgs("claude");
  assert(claude.includes("--safe-mode")); assert.equal(claude[claude.indexOf("--tools") + 1], ""); assert(claude.includes("--no-session-persistence")); assert(claude.includes("--strict-mcp-config"));
  const codex = nativeWorkflowAuthArgs("codex"); assert.equal(codex[0], "app-server"); assert(!codex.includes("exec")); assert(codex.includes("hooks"));
});

test("generation gateway replays a 401 only once with refreshed parent credentials", async () => {
  for (const recovers of [true, false]) {
    let token = "old", refreshes = 0; const seen: string[] = [];
    const auth = createWorkflowAuthentication({ key: randomUUID(), read: () => ({ accessToken: token }), refresh: async () => { refreshes++; token = "new"; } });
    const fakeRequest = ((options: any, callback: (incoming: IncomingMessage) => void) => {
      const request = new PassThrough();
      request.once("finish", () => {
        seen.push(options.headers.authorization);
        const incoming = new PassThrough() as unknown as IncomingMessage;
        incoming.statusCode = recovers && seen.length === 2 ? 200 : 401;
        incoming.headers = { "content-type": "application/json" };
        callback(incoming); incoming.emit("data", Buffer.from("{}")); incoming.push(null);
      });
      return request as unknown as ClientRequest;
    }) as typeof requestHttps;
    const proxy = await createWorkflowProxy({ kind: "codex", accessToken: "never-used-fallback", authentication: auth }, { resolveHost: async () => [{ address: "104.18.32.47", family: 4 }], request: fakeRequest });
    try {
      const response = await gatewayRequest(proxy);
      assert(response.startsWith(`HTTP/1.1 ${recovers ? 200 : 401}`));
      assert.deepEqual(seen, ["Bearer old", "Bearer new"]); assert.equal(refreshes, 1); assert.equal(proxy.authenticationFailed(), !recovers);
      if (!recovers) assert.equal(auth.current(), null);
    } finally { await proxy.close(); }
  }
});

test("closing a gateway revokes pending DNS and its last native refresh waiter", async () => {
  for (const phase of ["dns", "refresh"] as const) {
    let entered!: () => void, release!: () => void, helperSignal: AbortSignal | undefined, sends = 0;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const auth = createWorkflowAuthentication({ key: randomUUID(), read: () => ({ accessToken: "old" }), refresh: async (signal) => {
      helperSignal = signal; entered();
      await new Promise<void>((resolve) => { signal.addEventListener("abort", () => resolve(), { once: true }); });
    } });
    const fakeRequest = ((_options: any, callback: (incoming: IncomingMessage) => void) => {
      const request = new PassThrough(); sends++;
      request.once("finish", () => {
        const incoming = new PassThrough() as unknown as IncomingMessage;
        incoming.statusCode = 401; incoming.headers = {}; callback(incoming); incoming.push(null);
      });
      return request as unknown as ClientRequest;
    }) as typeof requestHttps;
    const proxy = await createWorkflowProxy({ kind: "codex", accessToken: "fake", authentication: auth }, {
      resolveHost: async () => {
        if (phase === "dns") { entered(); await new Promise<void>((resolve) => { release = resolve; }); }
        return [{ address: "104.18.32.47", family: 4 }];
      }, request: fakeRequest,
    });
    const pending = gatewayRequest(proxy).catch(() => "closed");
    try {
      await started; await proxy.close(); release?.(); await pending;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(sends, phase === "dns" ? 0 : 1);
      if (phase === "refresh") assert.equal(helperSignal?.aborted, true);
      assert.equal(proxy.authenticationFailed(), false, "user cancellation is not an authentication failure");
    } finally { release?.(); await proxy.close(); }
  }
});
