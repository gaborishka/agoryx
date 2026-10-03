import assert from "node:assert/strict";
import { test } from "node:test";
import { requestNonce } from "../../ui/src/lib/request-nonce.js";

test("table actions work on LAN HTTP where randomUUID is unavailable", () => {
  const nonce = requestNonce({ getRandomValues: bytes => { bytes.fill(0xab); return bytes; } });
  assert.match(nonce, /^[a-f0-9]{32}$/);
});

test("table actions use the secure-context UUID when available", () => {
  assert.equal(requestNonce({ randomUUID: () => "action-identity" }), "action-identity");
});

test("a browser without crypto can still identify distinct non-secret actions", () => {
  const nonces = Array.from({ length: 100 }, () => requestNonce({}));
  assert.equal(new Set(nonces).size, nonces.length);
  assert.ok(nonces.every(nonce => nonce.length <= 64));
});
