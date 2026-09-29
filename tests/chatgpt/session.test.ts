import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { OAuthError } from "../../internal/chatgpt/auth.js";
import {
  activeAccount,
  hostId,
  planUsageOn,
  readAccounts,
  saveAccount,
  withRefreshLock,
  type ChatGptAccount,
} from "../../internal/chatgpt/credentials.js";
import { freshAccount, SignInAgainError, signIn, signOut } from "../../internal/chatgpt/session.js";
import { fakeOpenAI, tempDir, type FakeOptions } from "./helpers.js";

const run = async (dir: string, options: FakeOptions = {}, extra: { newAccount?: boolean; consent?: boolean } = {}) => {
  const fake = fakeOpenAI(options);
  const shown: string[] = [];
  const result = await signIn({
    dir,
    fetchImpl: fake.fetchImpl,
    port: 0,
    timeoutMs: 5_000,
    showUrl: (url) => shown.push(url),
    openBrowser: fake.browser,
    ...extra,
  });
  return { ...result, fake, shown };
};

const mode = (path: string): number => statSync(path).mode & 0o777;

describe("credentials", () => {
  it("makes the host id once and keeps it", () => {
    const dir = tempDir();
    const id = hostId(dir);
    assert.match(id, /^urn:uuid:[0-9a-f-]{36}$/);
    assert.equal(hostId(dir), id);
    assert.equal(mode(join(dir, "host.json")), 0o600);
    assert.equal(mode(dir), 0o700);
  });

  it("serializes refreshes behind one lock", async () => {
    const dir = tempDir();
    const order: string[] = [];
    const slow = (name: string) => async () => {
      order.push(`${name}:in`);
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push(`${name}:out`);
    };
    await Promise.all([withRefreshLock(dir, slow("a")), withRefreshLock(dir, slow("b"))]);
    assert.deepEqual(order, ["a:in", "a:out", "b:in", "b:out"]);
    assert.equal(existsSync(join(dir, "refresh.lock")), false);
  });
});

describe("signIn", () => {
  it("registers Agoryx on the first sign-in and saves a verified account, owner-only", async () => {
    const dir = tempDir();
    const { account, registered, fake, shown } = await run(dir);
    assert.equal(registered, true);
    assert.equal(account.clientId, "oaiapp_first");
    assert.equal(account.subject, "user-1");
    assert.equal(account.email, "ivan@example.com");
    assert.equal(account.accessToken, "at-1");
    assert.equal(account.refreshToken, "rt-1");
    assert.equal(planUsageOn(account), true);
    assert.ok(Date.parse(account.expiresAt!) > Date.now() + 50 * 60_000);

    const [request] = fake.state.authorizeUrls;
    assert.equal(request?.searchParams.get("client_id"), "dynamic_agent_client");
    assert.equal(request?.searchParams.get("agent_name_hint"), "Agoryx");
    assert.equal(request?.searchParams.get("ext_agent_host_id"), hostId(dir));
    assert.equal(shown.length, 1);

    const exchange = fake.state.tokenForms[0]!;
    assert.equal(exchange.get("grant_type"), "authorization_code");
    assert.equal(exchange.get("client_id"), "oaiapp_first");

    assert.deepEqual(activeAccount(dir), account);
    assert.equal(mode(join(dir, "accounts.json")), 0o600);
  });

  it("signs in again with the saved client id and hints, and keeps the welcome", async () => {
    const dir = tempDir();
    const first = await run(dir);
    saveAccount(dir, { ...first.account, welcomedAt: "2026-09-29T10:00:00.000Z" });
    const again = await run(dir, { issued: "oaiapp_should_not_be_used" });
    assert.equal(again.registered, false);
    assert.equal(again.account.clientId, "oaiapp_first");
    assert.equal(again.account.welcomedAt, "2026-09-29T10:00:00.000Z");

    const q = again.fake.state.authorizeUrls[0]!.searchParams;
    assert.equal(q.get("client_id"), "oaiapp_first");
    assert.equal(q.get("agent_name_hint"), null);
    assert.equal(q.get("id_token_hint"), first.account.idToken);
    assert.equal(q.get("login_hint"), "ivan@example.com");
    assert.equal(q.get("ext_agent_host_id"), hostId(dir));
    // The URL printed in the terminal never carries the ID token.
    assert.equal(new URL(again.shown[0]!).searchParams.get("id_token_hint"), null);
  });

  it("asks for consent again when told to", async () => {
    const dir = tempDir();
    await run(dir, { scope: "openid profile email offline_access resource.invoke" });
    assert.equal(planUsageOn(activeAccount(dir)!), false);
    const again = await run(dir, {}, { consent: true });
    assert.equal(again.fake.state.authorizeUrls[0]!.searchParams.get("prompt"), "consent");
    assert.equal(planUsageOn(again.account), true);
  });

  it("refuses another account on a sign-in again, and adds it with newAccount", async () => {
    const dir = tempDir();
    await run(dir);
    await assert.rejects(run(dir, { sub: "user-2" }), (error: unknown) => error instanceof OAuthError && error.code === "account_mismatch");
    assert.equal(activeAccount(dir)?.subject, "user-1");

    const added = await run(dir, { sub: "user-2", issued: "oaiapp_second", email: "work@example.com" }, { newAccount: true });
    assert.equal(added.registered, true);
    assert.equal(added.fake.state.authorizeUrls[0]!.searchParams.get("client_id"), "dynamic_agent_client");
    const saved = readAccounts(dir);
    assert.equal(saved.active, "oaiapp_second");
    assert.deepEqual(Object.keys(saved.accounts).sort(), ["oaiapp_first", "oaiapp_second"]);
  });

  it("refuses a callback that names another client", async () => {
    const dir = tempDir();
    await run(dir);
    await assert.rejects(run(dir, { callbackClientId: "oaiapp_other" }), (error: unknown) => error instanceof OAuthError && error.code === "client_mismatch");
  });

  it("fails a first sign-in whose callback carries no client id, saving nothing", async () => {
    const dir = tempDir();
    await assert.rejects(run(dir, { callbackClientId: null }), (error: unknown) => error instanceof OAuthError && error.code === "registration_incomplete");
    assert.equal(activeAccount(dir), null);
  });

  it("saves nothing when the human declines", async () => {
    const dir = tempDir();
    await assert.rejects(run(dir, { deny: true }), (error: unknown) => error instanceof OAuthError && error.code === "access_denied");
    assert.equal(activeAccount(dir), null);
  });
});

const account = (overrides: Partial<ChatGptAccount> = {}): ChatGptAccount => ({
  clientId: "oaiapp_first",
  issuer: "https://auth.openai.com",
  subject: "user-1",
  email: "ivan@example.com",
  name: null,
  scopes: ["chatgpt.tokens.use.direct", "openid"],
  idToken: "idt",
  accessToken: "at-old",
  refreshToken: "rt-old",
  expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  earliestRefreshAt: null,
  savedAt: new Date().toISOString(),
  ...overrides,
});

describe("freshAccount", () => {
  it("uses a token that is still good without refreshing", async () => {
    const dir = tempDir();
    saveAccount(dir, account());
    const fake = fakeOpenAI();
    assert.equal((await freshAccount(dir, fake.fetchImpl)).accessToken, "at-old");
    assert.equal(fake.state.refreshes, 0);
  });

  it("refreshes a token about to expire and saves the rotated refresh token", async () => {
    const dir = tempDir();
    saveAccount(dir, account({ expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    const fake = fakeOpenAI();
    const renewed = await freshAccount(dir, fake.fetchImpl);
    assert.equal(renewed.accessToken, "at-1");
    assert.equal(renewed.refreshToken, "rt-1");
    const form = fake.state.tokenForms[0]!;
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.equal(form.get("refresh_token"), "rt-old");
    assert.equal(form.get("client_id"), "oaiapp_first");
    assert.equal(form.get("scope"), null);
    assert.equal(activeAccount(dir)?.refreshToken, "rt-1");
  });

  it("refreshes once for two callers at the same time", async () => {
    const dir = tempDir();
    saveAccount(dir, account({ expiresAt: new Date(Date.now() - 1_000).toISOString() }));
    const fake = fakeOpenAI();
    const [a, b] = await Promise.all([freshAccount(dir, fake.fetchImpl), freshAccount(dir, fake.fetchImpl)]);
    assert.equal(fake.state.refreshes, 1);
    assert.equal(a.accessToken, "at-1");
    assert.equal(b.accessToken, "at-1");
  });

  it("waits for earliest_refresh_at while the token still works", async () => {
    const dir = tempDir();
    saveAccount(
      dir,
      account({ expiresAt: new Date(Date.now() + 60_000).toISOString(), earliestRefreshAt: new Date(Date.now() + 30_000).toISOString() }),
    );
    const fake = fakeOpenAI();
    assert.equal((await freshAccount(dir, fake.fetchImpl)).accessToken, "at-old");
    assert.equal(fake.state.refreshes, 0);
  });

  it("clears the tokens and asks to sign in again when the refresh token is dead", async () => {
    const dir = tempDir();
    saveAccount(dir, account({ expiresAt: new Date(Date.now() - 1_000).toISOString() }));
    const fake = fakeOpenAI({ refreshError: "refresh_token_reused" });
    await assert.rejects(freshAccount(dir, fake.fetchImpl), SignInAgainError);
    const kept = activeAccount(dir)!;
    assert.equal(kept.clientId, "oaiapp_first");
    assert.equal(kept.accessToken, null);
    assert.equal(kept.refreshToken, null);
    assert.equal(kept.idToken, null);
  });

  it("keeps the tokens on an error that is not about the refresh token", async () => {
    const dir = tempDir();
    saveAccount(dir, account({ expiresAt: new Date(Date.now() - 1_000).toISOString() }));
    await assert.rejects(freshAccount(dir, fakeOpenAI({ refreshError: "temporarily_unavailable" }).fetchImpl), OAuthError);
    assert.equal(activeAccount(dir)?.refreshToken, "rt-old");
  });

  it("asks to sign in when nobody is", async () => {
    await assert.rejects(freshAccount(tempDir(), fakeOpenAI().fetchImpl), SignInAgainError);
  });
});

describe("signOut", () => {
  it("revokes the refresh token and keeps the client id for the next sign-in", async () => {
    const dir = tempDir();
    saveAccount(dir, account());
    const fake = fakeOpenAI();
    const out = await signOut(dir, fake.fetchImpl);
    assert.equal(out?.revoked, true);
    const form = fake.state.revokeForms[0]!;
    assert.equal(form.get("token"), "rt-old");
    assert.equal(form.get("token_type_hint"), "refresh_token");
    const kept = activeAccount(dir)!;
    assert.equal(kept.clientId, "oaiapp_first");
    assert.equal(kept.accessToken, null);
    assert.equal(kept.refreshToken, null);
  });

  it("returns null when nobody is signed in", async () => {
    assert.equal(await signOut(tempDir(), fakeOpenAI().fetchImpl), null);
  });
});
