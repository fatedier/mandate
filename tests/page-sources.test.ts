import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { PageSourceManager } from "../src/server/modules/page/page-sources.js";
import { PageStore } from "../src/server/modules/page/page-store.js";
import { pageFileDigest } from "../src/server/modules/page/page-publisher.js";
import type { MonitorRunResult } from "../src/server/modules/agent/command-monitor-manager.js";
import type { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import type { SseEvent } from "../src/shared/api-contracts.js";

const START = Date.parse("2026-10-20T00:00:00.000Z");
const MIN = 60_000;

let env: StoresEnv | null = null;
let manager: PageSourceManager | null = null;
afterEach(() => { manager?.dispose(); manager = null; env?.cleanup(); env = null; });

type Script = (command: string, call: number) => Partial<MonitorRunResult> | Promise<Partial<MonitorRunResult>>;

/** A manager over a real store, a scripted runner and a hand-moved clock. */
function setup(script: Script = () => ({ stdout: "" })) {
  env = freshStoresEnv("md-page-sources-");
  const pageDir = path.join(env.dir, "agent", "page");
  fs.mkdirSync(pageDir, { recursive: true });
  let now = START;
  const runs: Array<{ command: string; cwd: string; timeoutMs: number }> = [];
  const events: SseEvent[] = [];
  const pages = new PageStore(env.store.db);
  manager = new PageSourceManager({
    db: env.store.db,
    store: pages,
    pageDir,
    defaultCwd: path.join(env.dir, "agent"),
    sse: { emit: (event: string, data: unknown) => { events.push({ event, data } as SseEvent); } } as unknown as AgentSseEmitter,
    runner: {
      run: async (command, options) => {
        runs.push({ command, cwd: options.cwd, timeoutMs: options.timeoutMs });
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false, ...(await script(command, runs.length)) };
      }
    },
    clock: { now: () => now, sleep: async (ms) => { now += ms; }, setInterval: () => 0, clearInterval: () => {} }
  });
  const writeFile = (sources: unknown) => fs.writeFileSync(path.join(pageDir, "sources.json"), typeof sources === "string" ? sources : JSON.stringify(sources));
  return { m: manager, pageDir, pages, runs, events, writeFile, advance: (ms: number) => { now += ms; } };
}

const source = (name: string, over: Record<string, unknown> = {}) => ({ name, run: `echo ${name}`, every: "5m", ...over });

test("applying sources.json adds, changes and removes sources, and keeps a paused one paused", async () => {
  const s = setup();
  s.writeFile([source("prom"), source("gh", { cwd: "/repo" }), source("old")]);
  expect(s.m.applyFile()).toEqual({ names: ["prom", "gh", "old"], error: null });
  expect(s.m.list().map((x) => [x.name, x.run, x.everyMs, x.cwd, x.paused])).toEqual([
    ["prom", "echo prom", 5 * MIN, null, false], ["gh", "echo gh", 5 * MIN, "/repo", false], ["old", "echo old", 5 * MIN, null, false]
  ]);
  expect(s.m.setPaused("gh", true)?.paused).toBe(true);
  expect(s.m.setPaused("prom", true)?.paused).toBe(true);
  const heard = s.events.length;
  s.writeFile([source("prom", { run: "echo prom2", every: "10m" }), source("gh", { cwd: "/repo" }), source("new", { every: "1h" })]);
  expect(s.m.applyFile()).toEqual({ names: ["prom", "gh", "new"], error: null });
  // Paused stays paused, whether its command changed or not.
  expect(s.m.list().map((x) => [x.name, x.run, x.everyMs, x.paused])).toEqual([
    ["prom", "echo prom2", 10 * MIN, true], ["gh", "echo gh", 5 * MIN, true], ["new", "echo new", 60 * MIN, false]
  ]);
  expect(s.m.data("old")).toBeNull();
  // The page hears the one taken away go.
  expect(s.events.slice(heard)).toContainEqual({ event: "agentPageSourceChanged", data: { name: "old", source: null, data: null } });
  // A removed file takes them all away.
  const before = s.events.length;
  fs.rmSync(path.join(s.pageDir, "sources.json"));
  expect(s.m.applyFile()).toEqual({ names: [], error: null });
  expect(s.m.list()).toEqual([]);
  expect(s.events.slice(before)).toStrictEqual(["prom", "gh", "new"].map((name) => ({ event: "agentPageSourceChanged", data: { name, source: null, data: null } })));
});

test("sources.json that does not parse leaves the running sources as they were", async () => {
  const s = setup();
  s.writeFile([source("prom")]);
  s.m.applyFile();
  const before = s.m.list();
  const refusals: Array<[unknown, RegExp]> = [
    ["[{ \"name\": ", /^sources\.json does not parse: /],
    [{ name: "prom" }, /^sources\.json must be a list of sources$/],
    [[source("prom"), source("prom")], /^a duplicate name, prom$/],
    [[source("has space")], /^source 1: name "has space" may use only letters, digits, - and _ \(at most 40\)$/],
    [[source("fast", { every: "30s" })], /^source 1 \(fast\): every must be from 1m to 24h$/],
    [[source("slow", { every: "2d" })], /^source 1 \(slow\): every must be from 1m to 24h$/],
    [[source("odd", { every: "often" })], /^source 1 \(odd\): every must be a duration such as 5m or 1h$/],
    [[{ name: "norun", every: "5m" }], /^source 1 \(norun\): run must be a shell command$/],
    [[source("cwd", { cwd: 3 })], /^source 1 \(cwd\): cwd must be a directory path$/],
    [[source("nul", { cwd: "repos\u0000x" })], /^source 1 \(nul\): cwd must be a directory path$/],
    [Array.from({ length: 21 }, (_, i) => source(`s${i}`)), /^at most 20 sources, not 21$/],
    [[source("threads")], /^source 1: threads is the name of a built-in source$/]
  ];
  for (const [file, reason] of refusals) {
    s.writeFile(file);
    const applied = s.m.applyFile();
    expect([applied.names, reason.test(applied.error ?? "") ? "ok" : applied.error]).toEqual([null, "ok"]);
    expect(s.m.list()).toEqual(before);
  }
});

test("a source runs on its interval, no more than four at once, and its JSON output is parsed", async () => {
  const gates: Array<() => void> = [];
  const s = setup((command) => new Promise((resolve) => {
    gates.push(() => resolve({ stdout: `{"from":"${command}"}\n` }));
  }));
  s.writeFile(Array.from({ length: 6 }, (_, i) => source(`s${i}`)));
  s.m.applyFile();
  const tick = s.m.runDue();
  await Promise.resolve();
  expect(s.runs.length).toBe(4);
  expect(s.runs[0]).toMatchObject({ timeoutMs: 60_000 });
  for (const open of gates.splice(0)) open();
  await tick;
  expect(s.m.data("s0")).toEqual({ name: "s0", value: { from: "echo s0" }, at: new Date(START).toISOString(), error: null });
  // The two left wait for the next tick; the four that ran wait their interval.
  const second = s.m.runDue();
  await Promise.resolve();
  expect(s.runs.map((r) => r.command).slice(4)).toStrictEqual(["echo s4", "echo s5"]);
  for (const open of gates.splice(0)) open();
  await second;
  await s.m.runDue();
  expect(s.runs.length).toBe(6);
  s.advance(5 * MIN);
  const third = s.m.runDue();
  await Promise.resolve();
  expect(s.runs.length).toBe(10);
  for (const open of gates.splice(0)) open();
  await third;
  // The runs' ends reach the page.
  expect(s.events.filter((e) => e.event === "agentPageSourceChanged" && (e.data as { data: { value: unknown } | null }).data?.value !== undefined).length).toBeGreaterThan(0);
});

// One run's output, as the source's data records it.
const singleRuns: { name: string; result: Partial<MonitorRunResult>; recorded: Record<string, unknown> }[] = [
  { name: "text output is kept as text", result: { stdout: "3 open PRs\n" }, recorded: { value: "3 open PRs", error: null } },
  { name: "an output that filled the capture is said to be more than it holds, not its size",
    result: { stdout: "x".repeat(262_144) }, recorded: { error: "output over 64 KB (more than 256 KB)" } },
  { name: "a run that outlives 60 seconds is recorded as timed out",
    result: { timedOut: true, exitCode: -1 }, recorded: { value: null, error: "timed out after 60s" } }
];

test.each(singleRuns)("$name", async ({ result, recorded }) => {
  const s = setup(() => result);
  s.writeFile([source("out")]);
  s.m.applyFile();
  await s.m.runDue();
  expect(s.m.data("out")).toMatchObject(recorded);
});

test("an output over 64 KB is an error and keeps the last value", async () => {
  let big = false;
  const s = setup(() => ({ stdout: big ? "é".repeat(32_769) : "[1,2]" }));
  s.writeFile([source("big")]);
  s.m.applyFile();
  await s.m.runDue();
  expect(s.m.data("big")).toMatchObject({ value: [1, 2], error: null });
  big = true;
  s.advance(5 * MIN);
  await s.m.runDue();
  expect(s.m.data("big")).toMatchObject({ value: [1, 2], error: "output over 64 KB (65538 bytes)" });
});

test("a failing run keeps the last value and records the error", async () => {
  let fail = false;
  const s = setup(() => (fail ? { exitCode: 1, stdout: "", stderr: "token expired\n" } : { stdout: "\"ok\"" }));
  s.writeFile([source("groups")]);
  s.m.applyFile();
  await s.m.runDue();
  fail = true;
  s.advance(5 * MIN);
  await s.m.runDue();
  expect(s.m.data("groups")).toMatchObject({ value: "ok", error: "exit 1: token expired" });
  expect(s.m.list()[0]).toMatchObject({ lastError: "exit 1: token expired", lastRunAt: new Date(START + 5 * MIN).toISOString() });
});

test("a result whose source changed while it ran is dropped", async () => {
  let open!: () => void;
  const s = setup(() => new Promise((resolve) => { open = () => resolve({ stdout: "\"old\"" }); }));
  s.writeFile([source("prom")]);
  s.m.applyFile();
  const tick = s.m.runDue();
  await Promise.resolve();
  s.writeFile([source("prom", { run: "echo new" })]);
  s.m.applyFile();
  open();
  await tick;
  expect(s.m.data("prom")).toMatchObject({ value: null, at: null });
});

test("a paused source does not run; resumed, it runs at the next tick", async () => {
  const s = setup(() => ({ stdout: "1" }));
  s.writeFile([source("prom")]);
  s.m.applyFile();
  s.m.setPaused("prom", true);
  await s.m.runDue();
  expect(s.runs).toStrictEqual([]);
  s.m.setPaused("prom", false);
  await s.m.runDue();
  expect(s.runs.length).toBe(1);
  expect(s.m.setPaused("missing", true)).toBeNull();
});

test("removing a source from the menu takes it out of sources.json", async () => {
  const s = setup();
  s.writeFile([source("prom"), source("gh")]);
  s.m.applyFile();
  // As the publisher keeps it once it applied the file.
  s.pages.setFileDigest("sources.json", pageFileDigest(fs.readFileSync(path.join(s.pageDir, "sources.json"), "utf8")));
  expect(s.m.remove("prom")).toBe(true);
  expect(s.events.at(-1)).toEqual({ event: "agentPageSourceChanged", data: { name: "prom", source: null, data: null } });
  expect(s.m.remove("prom")).toBe(false);
  const file = fs.readFileSync(path.join(s.pageDir, "sources.json"), "utf8");
  expect(JSON.parse(file)).toEqual([source("gh")]);
  expect(s.m.list().map((x) => x.name)).toEqual(["gh"]);
  // The publisher will not apply the file it just wrote again.
  expect(s.pages.fileDigest("sources.json")).toBe(pageFileDigest(file));
});

test("a cwd is resolved from Your agent's working directory; none runs there", async () => {
  const s = setup();
  s.writeFile([source("here"), source("sub", { cwd: "repos/app" }), source("abs", { cwd: "/srv/x" })]);
  s.m.applyFile();
  await s.m.runDue();
  const agentDir = path.join(env!.dir, "agent");
  expect(s.runs.map((r) => r.cwd)).toStrictEqual([agentDir, path.join(agentDir, "repos/app"), "/srv/x"]);
});

test("a removed name that comes back is a new source: a run of the old one is dropped", async () => {
  let open!: () => void;
  const s = setup(() => new Promise((resolve) => { open = () => resolve({ stdout: "\"old\"" }); }));
  s.writeFile([source("prom")]);
  s.m.applyFile();
  const tick = s.m.runDue();
  await Promise.resolve();
  s.writeFile([]);
  s.m.applyFile();
  s.writeFile([source("prom")]);
  s.m.applyFile();
  open();
  await tick;
  expect(s.m.data("prom")).toMatchObject({ value: null, at: null });
});

test("removing a source while sources.json holds edits not yet applied leaves them due", async () => {
  const s = setup();
  s.writeFile([source("prom"), source("gh")]);
  s.m.applyFile();
  s.pages.setFileDigest("sources.json", pageFileDigest(fs.readFileSync(path.join(s.pageDir, "sources.json"), "utf8")));
  // The writer is still at work: gh changed, ci added, nothing applied yet.
  s.writeFile([source("prom"), source("gh", { run: "echo gh2" }), source("ci")]);
  expect(s.m.remove("prom")).toBe(true);
  const file = fs.readFileSync(path.join(s.pageDir, "sources.json"), "utf8");
  expect(JSON.parse(file)).toEqual([source("gh", { run: "echo gh2" }), source("ci")]);
  // Still due: the writer's end applies it.
  expect(s.pages.fileDigest("sources.json")).not.toBe(pageFileDigest(file));
  expect(s.m.applyFile()).toEqual({ names: ["gh", "ci"], error: null });
  expect(s.m.list().map((x) => [x.name, x.run])).toEqual([["gh", "echo gh2"], ["ci", "echo ci"]]);
});

test("a command that cannot be started is a failed run: it waits its interval and leaves the slots to the rest", async () => {
  const s = setup((command) => {
    if (command.startsWith("echo bad")) throw new Error("spawn failed");
    return { stdout: "1" };
  });
  s.writeFile([source("bad1"), source("bad2"), source("bad3"), source("bad4"), source("good")]);
  s.m.applyFile();
  await s.m.runDue();
  expect(s.m.data("bad1")).toMatchObject({ value: null, error: "could not run: spawn failed" });
  expect(s.m.list()[0]).toMatchObject({ lastRunAt: new Date(START).toISOString() });
  await s.m.runDue();
  expect(s.m.data("good")).toMatchObject({ value: 1, error: null });
  // The failing ones wait their interval: none ran again.
  expect(s.runs.filter((r) => r.command.startsWith("echo bad")).length).toBe(4);
});

test("the running sources written as a file apply as the same sources", async () => {
  const s = setup();
  s.writeFile([source("prom", { every: "90s" }), source("gh", { cwd: "repo", every: "1.5h" }), source("day", { every: "24h" })]);
  s.m.applyFile();
  // A later sources.json that was refused leaves these running: the file is these.
  s.writeFile("[{");
  expect(s.m.applyFile().error).toContain("does not parse");
  const text = s.m.fileText();
  expect(JSON.parse(text)).toEqual([
    { name: "prom", run: "echo prom", every: "90s" },
    { name: "gh", run: "echo gh", every: "90m", cwd: "repo" },
    { name: "day", run: "echo day", every: "1d" }
  ]);
  expect(text.endsWith("\n")).toBe(true);
  const before = s.m.list();
  s.events.length = 0;
  s.writeFile(text);
  expect(s.m.applyFile()).toEqual({ names: ["prom", "gh", "day"], error: null });
  expect(s.m.list()).toEqual(before);
  expect(s.events).toStrictEqual([]);
});

test("a run that reads what the last one did sends the source's line without its value", async () => {
  let out: Partial<MonitorRunResult> = { stdout: "{\"n\":1}" };
  const s = setup(() => out);
  s.writeFile([source("count")]);
  s.m.applyFile();
  const sent = () => s.events.filter((e) => e.event === "agentPageSourceChanged").map((e) => e.data as { name: string; source: { lastRunAt: string | null } | null; data?: unknown });
  const run = async () => { s.events.length = 0; s.advance(5 * MIN); await s.m.runDue(); return sent(); };
  await s.m.runDue();
  expect(sent().at(-1)).toMatchObject({ name: "count", data: { value: { n: 1 }, error: null } });
  // The same value: the line (its run time) goes out, the value does not.
  const same = await run();
  expect(same).toHaveLength(1);
  expect(same[0]!.source?.lastRunAt).toBe(new Date(START + 5 * MIN).toISOString());
  expect("data" in same[0]!).toBe(false);
  // A new value goes out with it.
  out = { stdout: "{\"n\":2}" };
  expect((await run())[0]).toMatchObject({ data: { value: { n: 2 }, error: null } });
  // A failure is a change; the same failure again is not; its end is.
  out = { exitCode: 1, stderr: "down" };
  expect((await run())[0]).toMatchObject({ data: { value: { n: 2 }, error: "exit 1: down" } });
  expect("data" in (await run())[0]!).toBe(false);
  out = { stdout: "{\"n\":2}" };
  expect((await run())[0]).toMatchObject({ data: { value: { n: 2 }, error: null } });
});
