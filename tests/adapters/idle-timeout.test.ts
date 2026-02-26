import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import test from "node:test";
import { createIdleTimeoutController } from "../../internal/adapters/idle-timeout.js";

test("idle timeout fires when there is no activity", async () => {
  let fired = false;
  const controller = createIdleTimeoutController(40, () => {
    fired = true;
  });

  await wait(80);
  controller.clear();
  assert.equal(fired, true);
});

test("idle timeout resets after touch", async () => {
  let fired = false;
  const controller = createIdleTimeoutController(60, () => {
    fired = true;
  });

  await wait(40);
  controller.touch();
  await wait(40);
  assert.equal(fired, false);

  await wait(40);
  controller.clear();
  assert.equal(fired, true);
});

test("idle timeout clear prevents callback", async () => {
  let fired = false;
  const controller = createIdleTimeoutController(40, () => {
    fired = true;
  });

  controller.clear();
  await wait(80);
  assert.equal(fired, false);
});
