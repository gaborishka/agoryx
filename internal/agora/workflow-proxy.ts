import { spawnSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { request as requestHttps } from "node:https";
import { isIP, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer } from "node:tls";
import type { AgentKind } from "./types.js";
import type { WorkflowAuthentication, WorkflowCredentials } from "./workflow-auth.js";

/** The child can reach one private CONNECT broker only. Hostnames and port are fixed,
 * and DNS is checked in the trusted parent before opening any connection. */
export const isPublicProviderAddress = (address: string): boolean => {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  return a !== 0 && a !== 10 && a !== 127 && a! < 224 &&
    !(a === 169 && b === 254) && !(a === 172 && b! >= 16 && b! <= 31) &&
    !(a === 192 && (b === 168 || b === 0 || (b === 2))) && !(a === 100 && b! >= 64 && b! <= 127) &&
    !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) && !(a === 203 && b === 0 && c === 113);
};

export interface WorkflowProxyOptions {
  kind: AgentKind;
  /** Credentials stay in the trusted parent and never reach worker files or environment. */
  accessToken: string;
  accountId?: string;
  authentication?: WorkflowAuthentication;
}

const HOSTS: Record<AgentKind, string[]> = { codex: ["chatgpt.com"], claude: ["api.anthropic.com"] };

/** Host-only filtering is insufficient: an account credential could read cloud histories.
 * Allow only generation and native model/routing metadata. Never conversation/session APIs. */
export const permittedWorkflowRequest = (kind: AgentKind, method: string, host: string, path: string): boolean => {
  if (!HOSTS[kind].includes(host) || !path.startsWith("/") || path.startsWith("//") || /[%\\]/.test(path)) return false;
  const url = new URL(path, `https://${host}`);
  if ([...url.searchParams].some(([key, value]) => !((key === "client_version" && /^[a-zA-Z0-9_.-]{1,80}$/.test(value)) || (key === "beta" && value === "true")))) return false;
  const pathname = url.pathname;
  if (kind === "claude") return method === "POST" && ["/v1/messages", "/v1/messages/count_tokens"].includes(pathname!) || method === "GET" && pathname === "/v1/models";
  return method === "POST" && ["/backend-api/codex/responses", "/backend-api/codex/responses/compact"].includes(pathname!) ||
    method === "GET" && ["/backend-api/codex/models", "/backend-api/wham/accounts/check", "/backend-api/codex/requirements"].includes(pathname!);
};

const record = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]): boolean => Object.keys(value).every((key) => allowed.includes(key));
const text = (value: unknown): value is string => typeof value === "string";
const textBlocks = (value: unknown): boolean => typeof value === "string" || (Array.isArray(value) && value.every((block) => record(block) && keys(block, ["type", "text", "annotations", "cache_control"]) && ["text", "input_text", "output_text", "summary_text"].includes(block.type) && text(block.text) && (!block.annotations || (Array.isArray(block.annotations) && block.annotations.length === 0))));
const localTools = (value: unknown, kind: AgentKind, depth = 0): boolean => depth <= 8 && (value === undefined || (Array.isArray(value) && value.every((tool) => {
  if (!record(tool)) return false;
  if (kind === "claude") return (tool.type === undefined || tool.type === "custom") && keys(tool, ["type", "name", "description", "input_schema", "cache_control", "defer_loading", "strict", "eager_input_streaming"]) && text(tool.name);
  if (tool.type === "namespace") return keys(tool, ["type", "name", "description", "tools"]) && text(tool.name) && Array.isArray(tool.tools) && localTools(tool.tools, kind, depth + 1);
  return ["function", "custom"].includes(tool.type) && keys(tool, ["type", "name", "description", "parameters", "strict", "format", "defer_loading"]) && text(tool.name);
})));
const codexInput = (value: unknown): boolean => typeof value === "string" || (Array.isArray(value) && value.every((rawItem) => {
  if (!record(rawItem)) return false;
  const item = { ...rawItem };
  delete item.internal_chat_message_metadata_passthrough;
  switch (item.type) {
    case undefined:
    case "message": return keys(item, ["type", "id", "role", "content", "status", "phase", "internal_chat_message_metadata_passthrough"]) && ["user", "assistant", "system", "developer"].includes(item.role) && textBlocks(item.content);
    case "additional_tools": return keys(item, ["type", "id", "role", "tools"]) && item.role === "developer" && Array.isArray(item.tools) && localTools(item.tools, "codex");
    case "function_call": return keys(item, ["type", "id", "name", "arguments", "call_id", "status", "namespace"]) && text(item.name) && text(item.arguments) && text(item.call_id);
    case "custom_tool_call": return keys(item, ["type", "id", "name", "input", "call_id", "status"]) && text(item.name) && text(item.input) && text(item.call_id);
    case "function_call_output":
    case "custom_tool_call_output": return keys(item, ["type", "id", "call_id", "output", "status"]) && text(item.call_id) && textBlocks(item.output);
    case "reasoning": return keys(item, ["type", "id", "summary", "content", "encrypted_content", "status"]) && textBlocks(item.summary) && (item.content === undefined || textBlocks(item.content)) && (item.encrypted_content === undefined || text(item.encrypted_content));
    default: return false; // Includes stored references and unknown configuration items.
  }
}));
const claudeContent = (value: unknown, depth = 0): boolean => {
  if (depth > 8) return false;
  if (text(value)) return true;
  if (!Array.isArray(value)) return false;
  return value.every((block) => {
    if (!record(block)) return false;
    switch (block.type) {
      case "text": return keys(block, ["type", "text", "cache_control"]) && text(block.text);
      case "tool_use": return keys(block, ["type", "id", "name", "input", "cache_control", "caller"]) && text(block.id) && text(block.name) && record(block.input) && (block.caller === undefined || (record(block.caller) && keys(block.caller, ["type"]) && block.caller.type === "direct"));
      case "tool_result": return keys(block, ["type", "tool_use_id", "content", "is_error", "cache_control"]) && text(block.tool_use_id) && (block.content === undefined || claudeContent(block.content, depth + 1));
      case "thinking": return keys(block, ["type", "thinking", "signature"]) && text(block.thinking) && text(block.signature);
      case "redacted_thinking": return keys(block, ["type", "data"]) && text(block.data);
      default: return false;
    }
  });
};

/** Positive schemas: unknown provider extensions fail closed rather than gaining stored-state
 * access. In particular a Responses ItemReference need not have a `type` discriminator. */
export const safeWorkflowPayload = (payload: unknown, kind: AgentKind = "codex"): boolean => {
  if (!record(payload) || !text(payload.model) || !localTools(payload.tools, kind)) return false;
  if (kind === "claude") {
    return keys(payload, ["model", "messages", "system", "tools", "tool_choice", "max_tokens", "stream", "temperature", "top_p", "top_k", "stop_sequences", "metadata", "thinking", "output_config", "service_tier", "context_management", "diagnostics"]) &&
      Array.isArray(payload.messages) && payload.messages.every((item: unknown) => record(item) && keys(item, ["role", "content", "output_config"]) && ["user", "assistant", "system"].includes(item.role) && (item.output_config === undefined || (record(item.output_config) && keys(item.output_config, ["effort", "format"]))) && claudeContent(item.content)) &&
      (payload.system === undefined || textBlocks(payload.system)) &&
      (payload.context_management === undefined || (record(payload.context_management) && keys(payload.context_management, ["edits"]) && Array.isArray(payload.context_management.edits) && payload.context_management.edits.every((edit: unknown) => record(edit) && keys(edit, ["type", "keep"]) && edit.type === "clear_thinking_20251015" && edit.keep === "all"))) &&
      (payload.diagnostics === undefined || (record(payload.diagnostics) && keys(payload.diagnostics, ["previous_message_id"]) && (payload.diagnostics.previous_message_id === null || text(payload.diagnostics.previous_message_id)))) &&
      (payload.tool_choice === undefined || (record(payload.tool_choice) && keys(payload.tool_choice, ["type", "name", "disable_parallel_tool_use"]) && ["auto", "any", "tool", "none"].includes(payload.tool_choice.type)));
  }
  return keys(payload, ["model", "instructions", "input", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "store", "stream", "include", "service_tier", "prompt_cache_key", "prompt_cache_retention", "metadata", "text", "max_output_tokens", "max_tool_calls", "truncation", "temperature", "top_p", "top_logprobs", "safety_identifier", "client_metadata"]) &&
    codexInput(payload.input) && (payload.instructions === undefined || text(payload.instructions)) &&
    (payload.include === undefined || (Array.isArray(payload.include) && payload.include.every((entry: unknown) => entry === "reasoning.encrypted_content"))) &&
    (payload.tool_choice === undefined || ["auto", "none", "required"].includes(payload.tool_choice) || (record(payload.tool_choice) && keys(payload.tool_choice, ["type", "name"]) && ["function", "custom"].includes(payload.tool_choice.type) && text(payload.tool_choice.name)));
};

export const sanitizeWorkflowPayload = (payload: Record<string, any>, kind: AgentKind): Record<string, any> => {
  if (!safeWorkflowPayload(payload, kind)) throw new Error("Unsupported hidden-phase generation payload");
  const result = structuredClone(payload);
  if (kind === "claude") { delete result.diagnostics; return result; }
  result.store = false;
  delete result.client_metadata;
  if (Array.isArray(result.input)) {
    const definitions = new Map<string, Record<string, any>>();
    const merge = (tools: Record<string, any>[]) => {
      for (const tool of tools) {
        const key = `${tool.type}:${tool.name}`, previous = definitions.get(key);
        if (previous?.type === "namespace" && tool.type === "namespace") {
          const members = new Map(previous.tools.map((member: Record<string, any>) => [`${member.type}:${member.name}`, member]));
          for (const member of tool.tools) members.set(`${member.type}:${member.name}`, member);
          definitions.set(key, { ...tool, tools: [...members.values()] });
        } else definitions.set(key, tool);
      }
    };
    merge(result.tools ?? []);
    result.input = result.input.filter((item: Record<string, any>) => {
      delete item.id; delete item.internal_chat_message_metadata_passthrough;
      if (item.type === "additional_tools") { merge(item.tools); return false; }
      return true;
    });
    if (definitions.size) result.tools = [...definitions.values()];
  }
  return result;
};

const certificate = (hosts: string[]): { key: string; cert: string; ca: string } => {
  const directory = mkdtempSync(join(tmpdir(), "agoryx-provider-ca-"));
  try {
    const key = join(directory, "key.pem"), cert = join(directory, "cert.pem"), caKey = join(directory, "ca.key"), ca = join(directory, "ca.pem"), csr = join(directory, "request.csr"), config = join(directory, "openssl.cnf"), rootConfig = join(directory, "root.cnf");
    writeFileSync(config, `[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=Agoryx private workflow gateway\n[root]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n[server]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${hosts.map((host) => `DNS:${host}`).join(",")}\n`, { mode: 0o600 });
    writeFileSync(rootConfig, '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=Agoryx workflow root CA\n[root]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n', { mode: 0o600 });
    for (const args of [
      ["req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "1", "-config", rootConfig, "-extensions", "root", "-keyout", caKey, "-out", ca],
      ["req", "-new", "-newkey", "rsa:2048", "-sha256", "-nodes", "-config", config, "-keyout", key, "-out", csr],
      ["x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-days", "1", "-sha256", "-extfile", config, "-extensions", "server", "-out", cert],
    ]) {
      const result = spawnSync("/usr/bin/openssl", args, { stdio: "pipe", timeout: 10000 });
      if (result.status !== 0) throw new Error("Could not create the private gateway certificate");
    }
    return { key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8"), ca: readFileSync(ca, "utf8") };
  } finally { rmSync(directory, { recursive: true, force: true }); }
};

export const createWorkflowProxy = async (options: WorkflowProxyOptions, transport: {
  resolveHost?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  request?: typeof requestHttps;
} = {}): Promise<{ port: number; certificate: string; authenticationFailed(): boolean; close(): Promise<void> }> => {
  const allowed = new Set(HOSTS[options.kind]);
  const credentials = certificate([...allowed]);
  let closed = false;
  let closing: Promise<void> | undefined;
  let authenticationFailed = false;
  const lifetime = new AbortController();
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy()); socket.setTimeout(120000, () => socket.destroy());
  };
  const deny = (response: ServerResponse, code = 403) => { response.writeHead(code, { "content-type": "application/json" }); response.end('{"error":{"message":"Blocked by hidden-phase provider isolation"}}'); };
  const handle = async (host: string, request: IncomingMessage, response: ServerResponse) => {
    if (closed) { response.destroy(); return; }
    if (!permittedWorkflowRequest(options.kind, request.method ?? "", host, request.url ?? "")) { deny(response); return; }
    let size = 0;
    const chunks: Buffer[] = [];
    try {
      for await (const raw of request) { const chunk = Buffer.from(raw); size += chunk.length; if (size > 4 * 1024 * 1024) { deny(response, 413); return; } chunks.push(chunk); }
      let body = Buffer.concat(chunks);
      if (request.method === "POST") {
        const payload = JSON.parse(body.toString("utf8"));
        // Generation cannot retrieve an old response, cloud conversation, stored file, or use
        // provider-side tools to reach account data. Native local tools remain available.
        if (!safeWorkflowPayload(payload, options.kind)) { deny(response); return; }
        body = Buffer.from(JSON.stringify(sanitizeWorkflowPayload(payload, options.kind)));
      }
      const addresses = await (transport.resolveHost ? transport.resolveHost(host) : lookup(host, { all: true, family: 4 }));
      // Closing destroys established sockets, but DNS may still be pending. Never
      // open an authenticated upstream after the execution has revoked this broker.
      if (closed || response.destroyed) { response.destroy(); return; }
      if (!addresses.length || addresses.some(({ address }) => !isPublicProviderAddress(address))) { deny(response); return; }
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined && (["accept", "content-type", "user-agent", "openai-beta", "anthropic-version", "anthropic-beta", "x-app", "originator", "version", "x-client-request-id"].includes(name) || name.startsWith("x-stainless-"))) headers[name] = value;
      }
      headers.host = host;
      if (request.method === "POST") headers["content-length"] = String(body.length);
      const forward = (credentials: WorkflowCredentials, retry: boolean) => {
        if (closed || response.destroyed) return;
        const authenticated = { ...headers, authorization: `Bearer ${credentials.accessToken}`, ...(options.kind === "codex" && credentials.accountId ? { "chatgpt-account-id": credentials.accountId } : {}) };
        const upstream = (transport.request ?? requestHttps)({ hostname: addresses[0]!.address, port: 443, method: request.method, path: request.url, headers: authenticated, servername: host }, (incoming) => {
          if (incoming.statusCode === 401 && options.authentication) {
            incoming.resume();
            void (retry ? options.authentication.recover(credentials.accessToken, lifetime.signal) : Promise.resolve(null)).then((refreshed) => {
              if (closed || response.destroyed) return;
              if (refreshed) forward(refreshed, false);
              else { options.authentication!.invalidate(credentials.accessToken); authenticationFailed = true; deny(response, 401); }
            }).catch(() => { if (!closed && !response.destroyed) { authenticationFailed = true; deny(response, 401); } });
            return;
          }
          const outgoing = { ...incoming.headers }; delete outgoing["set-cookie"]; delete outgoing["transfer-encoding"]; delete outgoing.connection;
          response.writeHead(incoming.statusCode ?? 502, outgoing); incoming.pipe(response);
        });
        upstream.on("socket", track); upstream.on("error", () => { if (!response.headersSent) deny(response, 502); else response.destroy(); });
        response.once("close", () => upstream.destroy());
        upstream.end(body);
      };
      const credentials = options.authentication ? options.authentication.current() : options;
      if (!credentials) { authenticationFailed = true; deny(response, 401); return; }
      forward(credentials, true);
    } catch { if (!response.headersSent) deny(response, 502); else response.destroy(); }
  };
  const server = createHttpServer((_request, response) => deny(response));
  server.on("connection", (client) => { track(client); if (sockets.size > 32) client.destroy(); });
  server.on("connect", (request, client, head) => {
    const match = /^([a-z0-9.-]+):443$/.exec(request.url ?? "");
    if (!match || !allowed.has(match[1]!)) { client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return; }
    const host = match[1]!;
    const http = createHttpServer((innerRequest, response) => { void handle(host, innerRequest, response); });
    // The native CLI falls back to its streaming HTTPS transport; no opaque websocket tunnel.
    http.on("upgrade", (_request, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"));
    http.on("clientError", (_error, socket) => socket.destroy());
    const tls = createTlsServer({ ...credentials, ALPNProtocols: ["http/1.1"] }, (socket) => { track(socket); if (socket.servername && socket.servername !== host) { socket.destroy(); return; } http.emit("connection", socket); });
    tls.on("tlsClientError", (_error, socket) => socket.destroy());
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) client.unshift(head);
    tls.emit("connection", client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error("Could not start the hidden-phase provider broker"); }
  return { port: address.port, certificate: credentials.ca, authenticationFailed: () => authenticationFailed, close: () => {
    closed = true;
    lifetime.abort();
    closing ??= new Promise<void>((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); });
    return closing;
  } };
};
