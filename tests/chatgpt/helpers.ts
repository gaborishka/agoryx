import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ISSUER, RESOURCE } from "../../internal/chatgpt/auth.js";

export const tempDir = (): string => join(mkdtempSync(join(tmpdir(), "agoryx-chatgpt-")), "chatgpt");

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const JWK = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };

export const signJwt = (claims: Record<string, unknown>, options: { kid?: string; key?: KeyObject } = {}): string => {
  const head = Buffer.from(JSON.stringify({ alg: "RS256", kid: options.kid ?? "k1", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign("sha256", Buffer.from(`${head}.${body}`), options.key ?? privateKey).toString("base64url");
  return `${head}.${body}.${signature}`;
};

export const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

export const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/api/accounts/authorize`,
  token_endpoint: `${ISSUER}/api/accounts/oauth/token`,
  jwks_uri: `${ISSUER}/.well-known/jwks.json`,
  revocation_endpoint: `${ISSUER}/api/accounts/oauth/revoke`,
};

export const ALL_SCOPES = "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke";

export interface FakeOptions {
  /** The client id OpenAI issues on a new registration. */
  issued?: string;
  /** The account that signs in in the browser. */
  sub?: string;
  email?: string;
  /** What the human grants. */
  scope?: string;
  /** The browser declines instead of consenting. */
  deny?: boolean;
  /** The client id the callback carries, when it should differ from the one the request used. */
  callbackClientId?: string | null;
  /** Error the refresh grant answers with. */
  refreshError?: string;
}

/** auth.openai.com as the docs describe it, and a browser that consents and follows the redirect for real. */
export const fakeOpenAI = (options: FakeOptions = {}) => {
  const issued = options.issued ?? "oaiapp_first";
  const pending: { nonce?: string; challenge?: string; redirect?: string; clientId?: string } = {};
  const state = {
    authorizeUrls: [] as URL[],
    tokenForms: [] as URLSearchParams[],
    revokeForms: [] as URLSearchParams[],
    refreshes: 0,
    tokenCounter: 0,
  };
  const tokens = (clientId: string, nonce: string | undefined, scope: string) => {
    state.tokenCounter += 1;
    return {
      access_token: `at-${state.tokenCounter}`,
      refresh_token: `rt-${state.tokenCounter}`,
      id_token: signJwt({
        iss: ISSUER,
        sub: options.sub ?? "user-1",
        aud: clientId,
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        nonce,
        email: options.email ?? "ivan@example.com",
      }),
      token_type: "Bearer",
      expires_in: 3600,
      scope,
    };
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === `${ISSUER}/.well-known/openid-configuration`) return json(DISCOVERY);
    if (url === DISCOVERY.jwks_uri) return json({ keys: [JWK] });
    if (url === DISCOVERY.revocation_endpoint) {
      state.revokeForms.push(new URLSearchParams(String(init?.body)));
      return new Response(null, { status: 200 });
    }
    if (url === DISCOVERY.token_endpoint) {
      const form = new URLSearchParams(String(init?.body));
      state.tokenForms.push(form);
      if (form.get("resource") !== RESOURCE) return json({ error: "invalid_target" }, 400);
      if (form.get("grant_type") === "refresh_token") {
        state.refreshes += 1;
        if (options.refreshError) return json({ error: options.refreshError }, 400);
        return json(tokens(form.get("client_id")!, undefined, options.scope ?? ALL_SCOPES));
      }
      const verifier = form.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (form.get("code") !== "code-1" || challenge !== pending.challenge || form.get("redirect_uri") !== pending.redirect) {
        return json({ error: "invalid_grant" }, 400);
      }
      if (form.get("client_id") !== pending.clientId) return json({ error: "invalid_client" }, 401);
      return json(tokens(pending.clientId!, pending.nonce, options.scope ?? ALL_SCOPES));
    }
    return json({ error: "not_found" }, 404);
  }) as typeof fetch;

  /** Opens the authorization URL: records it, consents (or not) and returns to the loopback callback. */
  const browser = (href: string): void => {
    const url = new URL(href);
    state.authorizeUrls.push(url);
    const requested = url.searchParams.get("client_id")!;
    pending.nonce = url.searchParams.get("nonce") ?? undefined;
    pending.challenge = url.searchParams.get("code_challenge") ?? undefined;
    pending.redirect = url.searchParams.get("redirect_uri") ?? undefined;
    pending.clientId = requested === "dynamic_agent_client" ? issued : requested;
    const back = new URL(pending.redirect!);
    back.searchParams.set("state", url.searchParams.get("state")!);
    if (options.deny) {
      back.searchParams.set("error", "access_denied");
    } else {
      back.searchParams.set("code", "code-1");
      back.searchParams.set("scope", (options.scope ?? ALL_SCOPES).replace(/ /g, "+"));
      const returned = options.callbackClientId === undefined ? (requested === "dynamic_agent_client" ? issued : null) : options.callbackClientId;
      if (returned) back.searchParams.set("client_id", returned);
    }
    // The browser's own request, over the real loopback.
    void fetch(back).catch(() => {});
  };

  return { fetchImpl, browser, state };
};
