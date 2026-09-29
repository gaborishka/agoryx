import { createHash, createPublicKey, randomBytes, verify, type JsonWebKey } from "node:crypto";
import { createServer, type Server } from "node:http";
import { PLAN_SCOPE } from "./credentials.js";

/**
 * Sign in with ChatGPT for an open-source app (https://developers.openai.com/siwc/token-sharing-open-source):
 * OAuth with PKCE against auth.openai.com, a loopback callback, and no client secret. The first sign-in
 * registers Agoryx with the account (client_id=dynamic_agent_client) and gets back its own client id.
 */

export const ISSUER = "https://auth.openai.com";
export const RESOURCE = "https://api.openai.com/v1";
export const DYNAMIC_CLIENT = "dynamic_agent_client";
/** The name OpenAI shows the human, the same on every install. */
export const AGENT_NAME = "Agoryx";
export const SCOPES = ["openid", "profile", "email", "offline_access", "resource.invoke", PLAN_SCOPE];
export const CALLBACK_PATH = "/auth/callback";
export const PREFERRED_PORT = 1455;

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  revocation_endpoint?: string;
}

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

export const discover = async (fetchImpl: typeof fetch): Promise<Discovery> => {
  const response = await fetchImpl(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`auth.openai.com discovery failed: HTTP ${response.status}`);
  const doc = (await response.json()) as Partial<Discovery>;
  for (const key of ["issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
    if (typeof doc[key] !== "string") throw new Error(`auth.openai.com discovery has no ${key}`);
  }
  return doc as Discovery;
};

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

export const pkce = (): { verifier: string; challenge: string } => {
  const verifier = randomToken(64);
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

export interface AuthorizeParams {
  endpoint: string;
  /** null: a first sign-in with this account, which registers Agoryx with it. */
  clientId: string | null;
  hostId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
  idTokenHint?: string | null;
  loginHint?: string | null;
  /** Ask for consent again: to turn plan use on after the human declined it. */
  consent?: boolean;
}

export const authorizeUrl = (params: AuthorizeParams): string => {
  const query: Array<[string, string]> = [["client_id", params.clientId ?? DYNAMIC_CLIENT]];
  if (!params.clientId) query.push(["agent_name_hint", AGENT_NAME]);
  query.push(["ext_agent_host_id", params.hostId]);
  if (params.clientId && params.idTokenHint) query.push(["id_token_hint", params.idTokenHint]);
  if (params.clientId && params.loginHint) query.push(["login_hint", params.loginHint]);
  if (params.consent) query.push(["prompt", "consent"]);
  query.push(
    ["response_type", "code"],
    ["redirect_uri", params.redirectUri],
    ["scope", SCOPES.join(" ")],
    ["resource", RESOURCE],
    ["state", params.state],
    ["nonce", params.nonce],
    ["code_challenge_method", "S256"],
    ["code_challenge", params.challenge],
  );
  return `${params.endpoint}?${query.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&")}`;
};

export type CallbackOutcome =
  | { kind: "ignore" }
  | { kind: "denied"; error: string; description: string | null }
  | { kind: "code"; code: string; clientId: string | null; scope: string | null };

/** Reads one request to the loopback callback; one whose state is not this attempt's is ignored, not trusted. */
export const readCallback = (url: URL, expectedState: string): CallbackOutcome => {
  if (url.pathname !== CALLBACK_PATH) return { kind: "ignore" };
  if (url.searchParams.get("state") !== expectedState) return { kind: "ignore" };
  const error = url.searchParams.get("error");
  if (error) return { kind: "denied", error, description: url.searchParams.get("error_description") };
  const code = url.searchParams.get("code");
  if (!code) return { kind: "ignore" };
  return { kind: "code", code, clientId: url.searchParams.get("client_id"), scope: url.searchParams.get("scope") };
};

const page = (title: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px system-ui;max-width:32em;margin:4em auto;padding:0 1em"><h1 style="font-size:1.3em">${title}</h1><p>${body}</p></body>`;

/** The loopback listener the browser returns to: 127.0.0.1, port 1455 when free, else any. */
export class LoopbackCallback {
  private constructor(
    private readonly server: Server,
    readonly redirectUri: string,
  ) {}

  static async listen(port: number = PREFERRED_PORT): Promise<LoopbackCallback> {
    const server = createServer();
    const bound = await new Promise<number>((resolve, reject) => {
      const tryPort = (candidate: number): void => {
        const onError = (error: NodeJS.ErrnoException): void => {
          if (error.code === "EADDRINUSE" && candidate !== 0) return tryPort(0);
          reject(error);
        };
        server.once("error", onError);
        server.listen(candidate, "127.0.0.1", () => {
          server.off("error", onError);
          resolve((server.address() as { port: number }).port);
        });
      };
      tryPort(port);
    });
    return new LoopbackCallback(server, `http://127.0.0.1:${bound}${CALLBACK_PATH}`);
  }

  /** Waits for this attempt's callback: its code, or a denial. */
  wait(state: string, timeoutMs: number): Promise<Extract<CallbackOutcome, { kind: "code" }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new OAuthError("timeout", "no answer from the browser in time")), timeoutMs);
      timer.unref();
      this.server.on("request", (request, response) => {
        const outcome = readCallback(new URL(request.url ?? "/", this.redirectUri), state);
        const send = (status: number, html: string): void => {
          response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
          response.end(html);
        };
        if (outcome.kind === "ignore") return send(404, page("Not this sign-in", "Agoryx is waiting for a different sign-in."));
        clearTimeout(timer);
        if (outcome.kind === "denied") {
          send(200, page("Agoryx was not connected", "You can close this tab. Nothing was saved."));
          return reject(new OAuthError(outcome.error, outcome.description ?? outcome.error));
        }
        send(200, page("Agoryx is connected to ChatGPT", "You can close this tab and go back to the terminal."));
        resolve(outcome);
      });
    });
  }

  close(): void {
    this.server.closeAllConnections();
    this.server.close();
  }
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  earliest_refresh_at?: number | string;
}

const postForm = async (fetchImpl: typeof fetch, url: string, form: Record<string, string>): Promise<Response> =>
  fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(20_000),
  });

const tokenCall = async (fetchImpl: typeof fetch, url: string, form: Record<string, string>): Promise<TokenResponse> => {
  const response = await postForm(fetchImpl, url, form);
  const body = (await response.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string; error_description?: string };
  if (!response.ok || typeof body.access_token !== "string") {
    const code = typeof body.error === "string" ? body.error : `http_${response.status}`;
    throw new OAuthError(code, body.error_description ?? code, response.status);
  }
  return body as TokenResponse;
};

export const exchangeCode = (
  fetchImpl: typeof fetch,
  discovery: Discovery,
  input: { clientId: string; code: string; verifier: string; redirectUri: string },
): Promise<TokenResponse> =>
  tokenCall(fetchImpl, discovery.token_endpoint, {
    grant_type: "authorization_code",
    client_id: input.clientId,
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: input.redirectUri,
    resource: RESOURCE,
  });

/** No scope: the grant stays as it is. */
export const refreshTokens = (fetchImpl: typeof fetch, discovery: Discovery, clientId: string, refreshToken: string): Promise<TokenResponse> =>
  tokenCall(fetchImpl, discovery.token_endpoint, {
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
    resource: RESOURCE,
  });

/** Refresh errors after which the refresh token is no use and the human signs in again. */
export const UNUSABLE_REFRESH = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

/** Ends the renewable session; true once OpenAI confirmed it (an empty 200, even for a token already dead). */
export const revokeRefreshToken = async (
  fetchImpl: typeof fetch,
  discovery: Discovery,
  clientId: string,
  refreshToken: string,
  delays: number[] = [500, 1500, 3000],
): Promise<boolean> => {
  if (!discovery.revocation_endpoint) return false;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await postForm(fetchImpl, discovery.revocation_endpoint, {
        token: refreshToken,
        token_type_hint: "refresh_token",
        client_id: clientId,
      });
      if (response.ok) return true;
      if (response.status < 500) return false;
    } catch {
      // network: retry below
    }
    if (attempt >= delays.length) return false;
    await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
  }
};

export interface IdClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  nonce?: string;
  email?: string;
  name?: string;
  [claim: string]: unknown;
}

const decodePart = <T>(part: string): T => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as T;

export const fetchJwks = async (fetchImpl: typeof fetch, discovery: Discovery): Promise<JsonWebKey[]> => {
  const response = await fetchImpl(discovery.jwks_uri, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`auth.openai.com keys: HTTP ${response.status}`);
  const keys = ((await response.json()) as { keys?: JsonWebKey[] }).keys;
  if (!Array.isArray(keys) || keys.length === 0) throw new Error("auth.openai.com published no keys");
  return keys;
};

const SKEW_S = 60;

/** Verifies the ID token's signature against OpenAI's keys and its issuer, audience, expiry and nonce. */
export const verifyIdToken = (
  idToken: string,
  expected: { keys: JsonWebKey[]; issuer: string; clientId: string; nonce: string; nowS?: number },
): IdClaims => {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new OAuthError("invalid_id_token", "the ID token is not a JWT");
  const [head, payload, signature] = parts as [string, string, string];
  const header = decodePart<{ alg?: string; kid?: string }>(head);
  const jwk = expected.keys.find((key) => (header.kid ? key.kid === header.kid : true));
  if (!jwk) throw new OAuthError("invalid_id_token", `no published key ${header.kid ?? ""}`.trim());
  const data = Buffer.from(`${head}.${payload}`);
  const sig = Buffer.from(signature, "base64url");
  const key = createPublicKey({ key: jwk, format: "jwk" });
  const ok =
    header.alg === "RS256"
      ? verify("sha256", data, key, sig)
      : header.alg === "ES256"
        ? verify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, sig)
        : false;
  if (!ok) throw new OAuthError("invalid_id_token", `the ID token's signature does not verify (${header.alg ?? "no alg"})`);
  const claims = decodePart<IdClaims>(payload);
  const now = expected.nowS ?? Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== expected.issuer) throw new OAuthError("invalid_id_token", `unexpected issuer ${claims.iss}`);
  if (!audiences.includes(expected.clientId)) throw new OAuthError("invalid_id_token", "the ID token is for another client");
  if (typeof claims.exp !== "number" || claims.exp + SKEW_S < now) throw new OAuthError("invalid_id_token", "the ID token has expired");
  if (claims.nonce !== expected.nonce) throw new OAuthError("invalid_id_token", "the ID token's nonce is not this attempt's");
  if (typeof claims.sub !== "string" || !claims.sub) throw new OAuthError("invalid_id_token", "the ID token names no subject");
  return claims;
};
