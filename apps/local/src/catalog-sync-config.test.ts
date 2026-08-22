import { afterEach, expect, test } from "@effect/vitest";

import { resolveLocalToolsSyncTtlMs } from "./executor";

const ENV_NAME = "EXECUTOR_TOOLS_SYNC_TTL_MS";
const originalValue = process.env[ENV_NAME];

afterEach(() => {
  if (originalValue === undefined) {
    delete process.env[ENV_NAME];
  } else {
    process.env[ENV_NAME] = originalValue;
  }
});

test("local tool catalog sync TTL uses the SDK default when unset", () => {
  delete process.env[ENV_NAME];
  expect(resolveLocalToolsSyncTtlMs()).toBeUndefined();
});

test("local tool catalog time-based sync can be disabled", () => {
  process.env[ENV_NAME] = "off";
  expect(resolveLocalToolsSyncTtlMs()).toBeNull();
});

test("local tool catalog sync TTL accepts positive milliseconds", () => {
  process.env[ENV_NAME] = "3600000";
  expect(resolveLocalToolsSyncTtlMs()).toBe(3_600_000);
});

test.each(["0", "-1", "nope"])("local tool catalog sync TTL rejects %s", (value) => {
  process.env[ENV_NAME] = value;
  expect(() => resolveLocalToolsSyncTtlMs()).toThrow(/EXECUTOR_TOOLS_SYNC_TTL_MS/);
});
