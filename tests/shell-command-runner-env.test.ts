import { expect, test } from "bun:test";
import * as path from "node:path";
import { testShellRunner } from "./helpers/shell-runner.js";
import { tempDir } from "./helpers/temp.js";
import { scheduleScratchDir, segment, threadNotesDir, threadResourcesDir } from "../src/server/platform/fs/resources.js";
import { newId } from "../src/server/platform/ids.js";

test("a per-call env reaches the command and nothing else", async () => {
  const home = tempDir("md-env-home-");
  const runner = testShellRunner(home);
  const a = await runner.run('printf %s "$MANDATE_DUE_AT"', { cwd: home, timeoutMs: 5000, env: { MANDATE_DUE_AT: "2026-11-05T09:00:00.000Z" } });
  expect(a.stdout).toBe("2026-11-05T09:00:00.000Z");
  const b = await runner.run('printf %s "${MANDATE_DUE_AT:-unset}"', { cwd: home, timeoutMs: 5000 });
  expect(b.stdout).toBe("unset");
});

test("a per-call env wins over the login environment", async () => {
  const home = tempDir("md-env-home-");
  const runner = testShellRunner(home);
  const run = await runner.run('printf "%s|%s" "$PATH" "$QUOTED"', { cwd: home, timeoutMs: 5000, env: { PATH: "/custom/bin:/usr/bin:/bin", QUOTED: "it's $HOME" } });
  expect(run.stdout).toBe("/custom/bin:/usr/bin:/bin|it's $HOME");
});

test("thread and schedule dirs sit under resources", () => {
  expect(threadResourcesDir("thr_a/b", "/d")).toBe(path.join("/d", "resources", "threads", segment("thr_a/b")));
  expect(threadNotesDir("thr_a/b", "/d")).toBe(path.join("/d", "resources", "threads", segment("thr_a/b"), "notes"));
  expect(scheduleScratchDir("sch_1", "/d")).toBe(path.join("/d", "resources", "schedules", "sch_1"));
});

test("schedule ids carry their prefix", () => {
  expect(newId("sch")).toMatch(/^sch_/);
});
