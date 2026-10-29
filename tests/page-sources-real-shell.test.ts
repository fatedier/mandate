import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { testShellRunner } from "./helpers/shell-runner.js";
import { PageSourceManager } from "../src/server/modules/page/page-sources.js";
import { PageStore } from "../src/server/modules/page/page-store.js";
import { monitorRunnerFrom } from "../src/server/modules/agent/command-monitor-manager.js";

let env: StoresEnv | null = null;
let manager: PageSourceManager | null = null;
afterEach(() => { manager?.dispose(); manager = null; env?.cleanup(); env = null; });

test("a real command's JSON reaches the page data", async () => {
  env = freshStoresEnv("md-page-sources-shell-");
  const agentDir = path.join(env.dir, "agent");
  const pageDir = path.join(agentDir, "page");
  fs.mkdirSync(pageDir, { recursive: true });
  fs.writeFileSync(path.join(pageDir, "sources.json"), JSON.stringify([{ name: "count", run: "printf '{\"n\":3}'", every: "5m" }, { name: "where", run: "pwd", every: "5m" }]));
  manager = new PageSourceManager({
    db: env.store.db,
    store: new PageStore(env.store.db),
    pageDir,
    defaultCwd: agentDir,
    sse: { emit: () => {} },
    runner: monitorRunnerFrom(testShellRunner(fs.mkdtempSync(path.join(env.dir, "shell-home-"))))
  });
  expect(manager.applyFile()).toEqual({ names: ["count", "where"], error: null });
  await manager.runDue();
  expect(manager.data("count")).toMatchObject({ value: { n: 3 }, error: null });
  expect(fs.realpathSync(String(manager.data("where")?.value))).toBe(fs.realpathSync(agentDir));
});
