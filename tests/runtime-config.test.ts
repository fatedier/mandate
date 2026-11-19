import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { runtimeConfigLines } from "../src/server/config/runtime-config.js";
import { configFileProblems } from "../src/server/config/file-check.js";
import { tempDir } from "./helpers/temp.js";

// The background jobs' pacing, from config.json's `runtime`: today's values
// unless the file says otherwise, never below what keeps the server sound.

const load = (runtime?: unknown) => {
  const dir = tempDir("md-runtime-config-");
  if (runtime !== undefined) fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ runtime }));
  return loadConfig(dir).runtime;
};

const DEFAULTS = {
  pricingPassEveryMs: 5_000,
  scheduleTickMs: 5_000,
  scheduleBootStaggerMs: 5_000,
  dreamCheckEveryMs: 300_000,
  priceDataFirstMs: 600_000,
  priceDataEveryMs: 86_400_000,
  retentionEveryMs: 3_600_000,
  historyWordsMergeEveryMs: 10_000,
  memoryVectorsWarmMs: 20_000,
  checkpointEveryMs: 30_000,
  activitySlicesCheckEveryMs: 30_000,
  sseHeartbeatMs: 10_000
};

test("with no runtime section, every pace is today's", () => {
  expect(load()).toStrictEqual(DEFAULTS);
  expect(load({})).toStrictEqual(DEFAULTS);
});

test("a value the file gives is used; one it does not stays the default", () => {
  expect(load({ pricingPassEveryMs: 200, scheduleTickMs: 250, scheduleBootStaggerMs: 0 }))
    .toStrictEqual({ ...DEFAULTS, pricingPassEveryMs: 200, scheduleTickMs: 250, scheduleBootStaggerMs: 0 });
});

test("a value below its floor, past the longest a timer can wait, or not a whole number is refused", () => {
  // A timer given more than 2^31 - 1 ms fires at once, and an interval then
  // fires every millisecond.
  expect(configFileProblems({ runtime: { scheduleTickMs: 5, sseHeartbeatMs: -1, priceDataEveryMs: 2_592_000_000, pricingPassEveryMs: "fast", memoryVectorsWarmMs: 1.5 } })).toEqual([
    'runtime.pricingPassEveryMs: must be a whole number from 100 to 2147483647 (it is "fast")',
    "runtime.scheduleTickMs: must be a whole number from 100 to 2147483647 (it is 5)",
    "runtime.priceDataEveryMs: must be a whole number from 60000 to 2147483647 (it is 2592000000)",
    "runtime.memoryVectorsWarmMs: must be a whole number from 0 to 2147483647 (it is 1.5)",
    "runtime.sseHeartbeatMs: must be a whole number from 1000 to 2147483647 (it is -1)"
  ]);
  expect(configFileProblems({ runtime: "every second" })).toEqual(["runtime: must be an object (it is text)"]);
  // At the bounds, and null (a key left out), it loads.
  expect(load({ scheduleTickMs: 100, retentionEveryMs: 2_147_483_647, dreamCheckEveryMs: null }))
    .toStrictEqual({ ...DEFAULTS, scheduleTickMs: 100, retentionEveryMs: 2_147_483_647 });
});

test("the start log names each value the file changed", () => {
  expect(runtimeConfigLines(undefined)).toStrictEqual([]);
  expect(runtimeConfigLines({ pricingPassEveryMs: 200, priceDataEveryMs: 86_400_000 })).toStrictEqual([
    "[mandate] runtime: pricingPassEveryMs 200 ms (default 5000 ms)"
  ]);
});
