interface NonceCrypto {
  randomUUID?: () => string;
  getRandomValues?: (bytes: Uint8Array) => Uint8Array;
}

/** Idempotency identity, including paired phones served over plain LAN HTTP. It is not a credential. */
export const requestNonce = (provider: NonceCrypto | undefined = globalThis.crypto): string => {
  if (typeof provider?.randomUUID === "function") return provider.randomUUID();
  if (typeof provider?.getRandomValues === "function") {
    return Array.from(provider.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
  }
  return `action-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
};
