import {
  authorizeUrl,
  discover,
  exchangeCode,
  fetchJwks,
  LoopbackCallback,
  OAuthError,
  pkce,
  randomToken,
  refreshTokens,
  revokeRefreshToken,
  UNUSABLE_REFRESH,
  verifyIdToken,
  type TokenResponse,
} from "./auth.js";
import { activeAccount, hostId, readAccounts, saveAccount, withoutTokens, withRefreshLock, type ChatGptAccount } from "./credentials.js";

export class SignInAgainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInAgainError";
  }
}

const expiry = (tokens: TokenResponse, now: number): string | null =>
  typeof tokens.expires_in === "number" ? new Date(now + tokens.expires_in * 1000).toISOString() : null;

const earliestRefresh = (value: TokenResponse["earliest_refresh_at"]): string | null => {
  if (typeof value === "number") return new Date(value * 1000).toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return null;
};

const scopesOf = (tokens: TokenResponse, fallback: string | null): string[] =>
  (tokens.scope ?? fallback ?? "").split(/[\s+]+/).filter(Boolean).sort();

export interface SignInOptions {
  dir: string;
  fetchImpl?: typeof fetch;
  /** Opens the authorization URL in the system browser. */
  openBrowser: (url: string) => void;
  /** Told the URL to open by hand: without any id_token_hint, which stays out of terminals and logs. */
  showUrl: (url: string) => void;
  /** Register another ChatGPT account (or workspace) instead of signing in again with the active one. */
  newAccount?: boolean;
  /** Ask for consent again, to turn plan use on after it was declined. */
  consent?: boolean;
  port?: number;
  timeoutMs?: number;
}

export interface SignedIn {
  account: ChatGptAccount;
  /** A new registration: this account was not signed in here before. */
  registered: boolean;
}

/** Continue with ChatGPT: the whole browser round trip, ending in a validated, saved account. */
export const signIn = async (options: SignInOptions): Promise<SignedIn> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const host = hostId(options.dir);
  const previous = options.newAccount ? null : activeAccount(options.dir);
  const discovery = await discover(fetchImpl);
  const callback = await LoopbackCallback.listen(options.port);
  try {
    const state = randomToken();
    const nonce = randomToken();
    const { verifier, challenge } = pkce();
    const base = {
      endpoint: discovery.authorization_endpoint,
      clientId: previous?.clientId ?? null,
      hostId: host,
      redirectUri: callback.redirectUri,
      state,
      nonce,
      challenge,
      loginHint: previous?.email ?? null,
      consent: options.consent ?? false,
    };
    const answer = callback.wait(state, options.timeoutMs ?? 10 * 60_000);
    options.showUrl(authorizeUrl(base));
    options.openBrowser(authorizeUrl({ ...base, idTokenHint: previous?.idToken ?? null }));
    const returned = await answer;

    let clientId: string;
    if (previous) {
      if (returned.clientId && returned.clientId !== previous.clientId) {
        throw new OAuthError("client_mismatch", "the browser returned another client id than this account's registration");
      }
      clientId = previous.clientId;
    } else {
      if (!returned.clientId) throw new OAuthError("registration_incomplete", "OpenAI did not return a client id for the new registration");
      clientId = returned.clientId;
    }

    const now = Date.now();
    const tokens = await exchangeCode(fetchImpl, discovery, { clientId, code: returned.code, verifier, redirectUri: callback.redirectUri });
    if (!tokens.id_token) throw new OAuthError("invalid_id_token", "the token response carries no ID token");
    const claims = verifyIdToken(tokens.id_token, { keys: await fetchJwks(fetchImpl, discovery), issuer: discovery.issuer, clientId, nonce });
    if (previous && claims.sub !== previous.subject) {
      throw new OAuthError(
        "account_mismatch",
        `this is not the account registered as ${previous.clientId}${previous.email ? ` (${previous.email})` : ""}; use --new to add another account`,
      );
    }
    const account: ChatGptAccount = {
      clientId,
      issuer: claims.iss,
      subject: claims.sub,
      email: typeof claims.email === "string" ? claims.email : (previous?.email ?? null),
      name: typeof claims.name === "string" ? claims.name : (previous?.name ?? null),
      scopes: scopesOf(tokens, returned.scope),
      idToken: tokens.id_token,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      expiresAt: expiry(tokens, now),
      earliestRefreshAt: earliestRefresh(tokens.earliest_refresh_at),
      savedAt: new Date(now).toISOString(),
      ...(previous?.welcomedAt ? { welcomedAt: previous.welcomedAt } : {}),
    };
    saveAccount(options.dir, account);
    return { account, registered: !previous };
  } finally {
    callback.close();
  }
};

/** Renewed this long before the access token expires. */
const REFRESH_AHEAD_MS = 5 * 60_000;

const needsRefresh = (account: ChatGptAccount, now: number): boolean => {
  if (!account.expiresAt) return false;
  const expires = Date.parse(account.expiresAt);
  if (expires - now > REFRESH_AHEAD_MS) return false;
  // Not before OpenAI says so, while the token still works.
  if (account.earliestRefreshAt && now < Date.parse(account.earliestRefreshAt) && now < expires) return false;
  return true;
};

/** The active account with an access token good for the next request, refreshed first when it is about to expire. */
export const freshAccount = async (dir: string, fetchImpl: typeof fetch = fetch): Promise<ChatGptAccount> => {
  const current = activeAccount(dir);
  if (!current?.accessToken) throw new SignInAgainError("not signed in with ChatGPT: run `agoryx login chatgpt`");
  if (!needsRefresh(current, Date.now())) return current;
  return withRefreshLock(dir, async () => {
    // Another process may have refreshed while this one waited.
    const account = readAccounts(dir).accounts[current.clientId];
    if (!account?.accessToken) throw new SignInAgainError("signed out of ChatGPT meanwhile: run `agoryx login chatgpt`");
    const now = Date.now();
    if (!needsRefresh(account, now)) return account;
    if (!account.refreshToken) throw new SignInAgainError("the ChatGPT session cannot be renewed: run `agoryx login chatgpt`");
    let tokens: TokenResponse;
    try {
      tokens = await refreshTokens(fetchImpl, await discover(fetchImpl), account.clientId, account.refreshToken);
    } catch (error) {
      if (error instanceof OAuthError && UNUSABLE_REFRESH.has(error.code)) {
        saveAccount(dir, withoutTokens(account), { activate: false });
        throw new SignInAgainError(`the ChatGPT session ended (${error.code}): run \`agoryx login chatgpt\``);
      }
      throw error;
    }
    const renewed: ChatGptAccount = {
      ...account,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? account.refreshToken,
      expiresAt: expiry(tokens, now),
      earliestRefreshAt: earliestRefresh(tokens.earliest_refresh_at),
      scopes: tokens.scope ? scopesOf(tokens, null) : account.scopes,
      savedAt: new Date(now).toISOString(),
    };
    saveAccount(dir, renewed, { activate: false });
    return renewed;
  });
};

export interface SignedOut {
  account: ChatGptAccount;
  /** OpenAI confirmed the session ended; when false the human can still disconnect Agoryx in ChatGPT settings. */
  revoked: boolean;
}

/** Ends the active account's session and clears its tokens; its client id stays for the next sign-in. */
export const signOut = async (dir: string, fetchImpl: typeof fetch = fetch): Promise<SignedOut | null> => {
  const account = activeAccount(dir);
  if (!account) return null;
  let revoked = false;
  if (account.refreshToken) {
    try {
      revoked = await revokeRefreshToken(fetchImpl, await discover(fetchImpl), account.clientId, account.refreshToken);
    } catch {
      revoked = false;
    }
  }
  saveAccount(dir, withoutTokens(account), { activate: false });
  return { account, revoked };
};
