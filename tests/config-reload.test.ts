import { expect, test } from "bun:test";
import { reloadOrKeep } from "../src/server/app/config-reload.js";
import { DEFAULT_CONFIG } from "../src/server/config/defaults.js";
import { ConfigFileError } from "../src/server/config/file-check.js";

// A reload while running (a Settings save, the daily Kilo model refresh)
// never takes a file the server would refuse: it keeps the config it runs.

test("an invalid file is not taken: nothing comes back, and why is said once", () => {
  const said: unknown[] = [];
  const bad = ConfigFileError.invalid("/d/config.json", ['port: must be a whole number from 0 to 65535 (it is "4777")']);
  expect(reloadOrKeep(() => { throw bad; }, (error) => said.push(error))).toBeNull();
  expect(said).toEqual([bad]);
});

test("a file the server can use is the new config; any other failure is not swallowed", () => {
  const said: unknown[] = [];
  expect(reloadOrKeep(() => DEFAULT_CONFIG, (error) => said.push(error))).toBe(DEFAULT_CONFIG);
  expect(() => reloadOrKeep(() => { throw new Error("disk gone"); }, (error) => said.push(error))).toThrow("disk gone");
  expect(said).toEqual([]);
});
