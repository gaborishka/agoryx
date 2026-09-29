import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import {
  authorizeUrl,
  DYNAMIC_CLIENT,
  ISSUER,
  LoopbackCallback,
  OAuthError,
  pkce,
  readCallback,
  RESOURCE,
  revokeRefreshToken,
  verifyIdToken,
} from "../../internal/chatgpt/auth.js";
import { DISCOVERY, JWK, json, signJwt } from "./helpers.js";

const base = {
  endpoint: DISCOVERY.authorization_endpoint,
  hostId: "urn:uuid:11111111-2222-3333-4444-555555555555",
  redirectUri: "http://127.0.0.1:1455/auth/callback",
  state: "st",
  nonce: "no",
  challenge: "ch",
};

describe("pkce", () => {
  it("makes an S256 challenge of a long verifier", () => {
    const { verifier, challenge } = pkce();
    assert.ok(verifier.length >= 43 && verifier.length <= 128);
    assert.match(verifier, /^[A-Za-z0-9_-]+$/);
    assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
  });
});

describe("authorizeUrl", () => {
  it("registers Agoryx on a first sign-in", () => {
    const url = new URL(authorizeUrl({ ...base, clientId: null, idTokenHint: "ignored", loginHint: "ignored" }));
    assert.equal(url.origin + url.pathname, DISCOVERY.authorization_endpoint);
    const q = url.searchParams;
    assert.equal(q.get("client_id"), DYNAMIC_CLIENT);
    assert.equal(q.get("agent_name_hint"), "Agoryx");
    assert.equal(q.get("ext_agent_host_id"), base.hostId);
    assert.equal(q.get("id_token_hint"), null);
    assert.equal(q.get("login_hint"), null);
    assert.equal(q.get("prompt"), null);
    assert.equal(q.get("response_type"), "code");
    assert.equal(q.get("redirect_uri"), base.redirectUri);
    assert.equal(q.get("scope"), "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct");
    assert.equal(q.get("resource"), RESOURCE);
    assert.equal(q.get("code_challenge_method"), "S256");
    assert.equal(q.get("code_challenge"), "ch");
    assert.equal(q.get("state"), "st");
    assert.equal(q.get("nonce"), "no");
  });

  it("encodes spaces as %20, not +", () => {
    const href = authorizeUrl({ ...base, clientId: null });
    assert.ok(href.includes("scope=openid%20profile%20email"));
    assert.ok(!href.includes("+"));
  });

  it("signs in again with the issued client id and hints, without the name hint", () => {
    const q = new URL(authorizeUrl({ ...base, clientId: "oaiapp_x", idTokenHint: "idt", loginHint: "a@b.c", consent: true })).searchParams;
    assert.equal(q.get("client_id"), "oaiapp_x");
    assert.equal(q.get("agent_name_hint"), null);
    assert.equal(q.get("ext_agent_host_id"), base.hostId);
    assert.equal(q.get("id_token_hint"), "idt");
    assert.equal(q.get("login_hint"), "a@b.c");
    assert.equal(q.get("prompt"), "consent");
  });
});

describe("readCallback", () => {
  const at = (query: string, path = "/auth/callback") => new URL(`http://127.0.0.1:1455${path}?${query}`);

  it("takes the code, client id and scope of this attempt", () => {
    assert.deepEqual(readCallback(at("state=st&code=c1&client_id=oaiapp_x&scope=openid+email"), "st"), {
      kind: "code",
      code: "c1",
      clientId: "oaiapp_x",
      scope: "openid email",
    });
  });

  it("ignores another attempt's state, another path, and a callback with no code", () => {
    assert.equal(readCallback(at("state=other&code=c1"), "st").kind, "ignore");
    assert.equal(readCallback(at("state=st&code=c1", "/favicon.ico"), "st").kind, "ignore");
    assert.equal(readCallback(at("state=st"), "st").kind, "ignore");
    assert.equal(readCallback(at("code=c1"), "st").kind, "ignore");
  });

  it("reports a denial only when the state matches", () => {
    assert.deepEqual(readCallback(at("state=st&error=access_denied&error_description=no"), "st"), {
      kind: "denied",
      error: "access_denied",
      description: "no",
    });
    assert.equal(readCallback(at("state=forged&error=access_denied"), "st").kind, "ignore");
  });
});

describe("LoopbackCallback", () => {
  it("binds 127.0.0.1, not localhost, and waits for this attempt's code", async () => {
    const callback = await LoopbackCallback.listen(0);
    try {
      assert.match(callback.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
      const answer = callback.wait("st", 5_000);
      const stray = await fetch(`${callback.redirectUri}?state=forged&code=evil`);
      assert.equal(stray.status, 404);
      const good = await fetch(`${callback.redirectUri}?state=st&code=c1&client_id=oaiapp_x`);
      assert.equal(good.status, 200);
      assert.match(await good.text(), /connected to ChatGPT/);
      assert.deepEqual(await answer, { kind: "code", code: "c1", clientId: "oaiapp_x", scope: null });
    } finally {
      callback.close();
    }
  });

  it("falls back to another port when the preferred one is taken", async () => {
    const first = await LoopbackCallback.listen(0);
    const port = Number(new URL(first.redirectUri).port);
    const second = await LoopbackCallback.listen(port);
    try {
      assert.notEqual(new URL(second.redirectUri).port, String(port));
    } finally {
      first.close();
      second.close();
    }
  });

  it("rejects with the browser's denial", async () => {
    const callback = await LoopbackCallback.listen(0);
    try {
      const answer = assert.rejects(callback.wait("st", 5_000), (error: unknown) => error instanceof OAuthError && error.code === "access_denied");
      await fetch(`${callback.redirectUri}?state=st&error=access_denied`);
      await answer;
    } finally {
      callback.close();
    }
  });

  it("times out", async () => {
    const callback = await LoopbackCallback.listen(0);
    try {
      await assert.rejects(callback.wait("st", 20), (error: unknown) => error instanceof OAuthError && error.code === "timeout");
    } finally {
      callback.close();
    }
  });
});

describe("verifyIdToken", () => {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: ISSUER, sub: "user-1", aud: "oaiapp_x", exp: now + 3600, nonce: "no", email: "a@b.c" };
  const expected = { keys: [JWK], issuer: ISSUER, clientId: "oaiapp_x", nonce: "no" };
  const rejects = (token: string, pattern: RegExp, overrides: Partial<typeof expected> = {}) =>
    assert.throws(
      () => verifyIdToken(token, { ...expected, ...overrides }),
      (error: unknown) => error instanceof OAuthError && error.code === "invalid_id_token" && pattern.test(error.message),
    );

  it("accepts a token signed by a published key", () => {
    const verified = verifyIdToken(signJwt(claims), expected);
    assert.equal(verified.sub, "user-1");
    assert.equal(verified.email, "a@b.c");
  });

  it("accepts an audience list that names this client", () => {
    assert.equal(verifyIdToken(signJwt({ ...claims, aud: ["other", "oaiapp_x"] }), expected).sub, "user-1");
  });

  it("accepts ES256", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const head = Buffer.from(JSON.stringify({ alg: "ES256", kid: "e1" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: "e1" };
    assert.equal(verifyIdToken(`${head}.${body}.${sig}`, { ...expected, keys: [JWK, jwk] }).sub, "user-1");
  });

  it("rejects another key's signature, an unknown kid and a tampered payload", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    rejects(signJwt(claims, { key: privateKey }), /signature/);
    rejects(signJwt(claims, { kid: "nope" }), /no published key/);
    const [head, , sig] = signJwt(claims).split(".");
    const forged = Buffer.from(JSON.stringify({ ...claims, sub: "attacker" })).toString("base64url");
    rejects(`${head}.${forged}.${sig}`, /signature/);
  });

  it("rejects alg none", () => {
    const head = Buffer.from(JSON.stringify({ alg: "none", kid: "k1" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    rejects(`${head}.${body}.`, /signature/);
  });

  it("rejects the wrong issuer, audience, nonce, an expired token and no subject", () => {
    rejects(signJwt({ ...claims, iss: "https://evil.example" }), /issuer/);
    rejects(signJwt({ ...claims, aud: "oaiapp_other" }), /another client/);
    rejects(signJwt({ ...claims, nonce: "replayed" }), /nonce/);
    rejects(signJwt({ ...claims, exp: now - 120 }), /expired/);
    rejects(signJwt({ ...claims, sub: "" }), /subject/);
  });

  it("allows a minute of clock skew", () => {
    assert.equal(verifyIdToken(signJwt({ ...claims, exp: now - 30 }), expected).sub, "user-1");
  });

  it("rejects what is not a JWT", () => {
    rejects("not-a-jwt", /not a JWT/);
  });
});

describe("revokeRefreshToken", () => {
  const forms: URLSearchParams[] = [];
  const answering = (...statuses: Array<number | "network">) => {
    let call = 0;
    forms.length = 0;
    return (async (_url: string | URL | Request, init?: RequestInit) => {
      forms.push(new URLSearchParams(String(init?.body)));
      const status = statuses[Math.min(call++, statuses.length - 1)];
      if (status === "network") throw new TypeError("fetch failed");
      return status === 200 ? new Response(null, { status }) : json({ error: "x" }, status);
    }) as typeof fetch;
  };

  it("sends the refresh token with its hint and client id", async () => {
    assert.equal(await revokeRefreshToken(answering(200), DISCOVERY, "oaiapp_x", "rt", []), true);
    assert.equal(forms[0]?.get("token"), "rt");
    assert.equal(forms[0]?.get("token_type_hint"), "refresh_token");
    assert.equal(forms[0]?.get("client_id"), "oaiapp_x");
  });

  it("retries 5xx and network errors, not 4xx", async () => {
    assert.equal(await revokeRefreshToken(answering(503, "network", 200), DISCOVERY, "c", "rt", [0, 0, 0]), true);
    assert.equal(forms.length, 3);
    assert.equal(await revokeRefreshToken(answering(400), DISCOVERY, "c", "rt", [0, 0, 0]), false);
    assert.equal(forms.length, 1);
    assert.equal(await revokeRefreshToken(answering(500), DISCOVERY, "c", "rt", [0, 0]), false);
    assert.equal(forms.length, 3);
  });

  it("gives up without a revocation endpoint", async () => {
    const { revocation_endpoint: _, ...rest } = DISCOVERY;
    assert.equal(await revokeRefreshToken(answering(200), rest, "c", "rt", []), false);
    assert.equal(forms.length, 0);
  });
});
