import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  buildManagerInitialContext,
  buildWorkerInitialContext,
  buildManagerSystemPrompt,
  buildWorkerSystemPrompt,
  buildWorkerRuntimeContext,
  _clearTemplateCache
} from "../src/server/modules/agent/system-prompt.js";
import { withTempDataDir } from "./helpers/fixtures.js";

/**
 * Asserted per segment, because the segments are the product.
 *
 * feature-scope calls these three at three different lifecycles: the system
 * prompt is immutable and takes no input, initial context is built once per
 * thread, and runtime context is rebuilt on every wake. Nothing ever
 * concatenates them, and the split is what lets the stable part stay a cache
 * prefix.
 *
 * These tests used to assert against a joined string, which passes whichever
 * segment a line lands in. Moving the canvas guidance out of the immutable
 * prompt and into the per-wake context would have kept every one of them
 * green while making the prefix change on every turn.
 */

const project = {
  id: "p1",
  name: "MyApp",
  workingDir: "/repo",
  isGit: true,
  gitRemote: "github.com/me/app",
  tmuxSessionName: "md-myapp"
};

const feature = {
  id: "f1",
  name: "auth",
  tmuxWindowName: "auth_feat",
  mode: "shared-cwd",
  branch: null,
  baseRef: null,
  worktreePath: null
};

const baseInput = { project, feature, panes: [] };

test("buildWorkerInitialContext: substitutes project + feature fields", () => {
  _clearTemplateCache();
  const out = buildWorkerInitialContext(baseInput);
  expect(out).toMatch(/MyApp/);
  expect(out).toMatch(/auth_feat/);
  expect(out).toMatch(/shared-cwd/);
  expect(out).toMatch(/github\.com\/me\/app/);
});

test("no segment leaves an unsubstituted {{token}}", () => {
  // Checked on each rather than on a join, so a failure names the segment
  // whose template went unrendered.
  _clearTemplateCache();
  const segments = {
    system: buildWorkerSystemPrompt(),
    initial: buildWorkerInitialContext(baseInput),
    runtime: buildWorkerRuntimeContext({ panes: [] })
  };
  for (const [name, text] of Object.entries(segments)) {
    expect([name, text.match(/{{[^}]+}}/)]).toEqual([name, null]);
  }
});

test("buildWorkerInitialContext: includes injected agent preferences", () => {
  _clearTemplateCache();
  const out = buildWorkerInitialContext({
    ...baseInput,
    agentPreferences: "Prefer Claude for planning and Codex for implementation."
  });
  expect(out).toMatch(/## Agent preferences/);
  expect(out).toMatch(/Prefer Claude for planning and Codex for implementation/);
  expect(out).toMatch(/not hard rules/);
});

test("buildWorkerRuntimeContext: omits durable identity and preferences", () => {
  _clearTemplateCache();
  const out = buildWorkerRuntimeContext({ panes: [] });
  expect(out).not.toMatch(/MyApp/);
  expect(out).not.toMatch(/auth_feat/);
  expect(out).not.toMatch(/Agent preferences/);
  expect(out).toMatch(/compact routing digest/);
  expect(out).toMatch(/## Turn liveness/);
  expect(out).toMatch(/do not end the turn by only describing\s+future work/);
  expect(out).toMatch(/Registering a\s+monitor is an action/);
  expect(out).toMatch(/Only once a\s+monitor wake actually fires should\s+you inspect the target immediately/);
  expect(out).not.toContain("watch_window");
  expect(out).toMatch(/Active panes: 0/);
  expect(out).toMatch(/use list_panes/);
  expect(out).not.toMatch(/task queue/i);
});

test("buildWorkerRuntimeContext: caps pane details", () => {
  _clearTemplateCache();
  const panes = Array.from({ length: 10 }, (_, index) => ({
    paneId: `%${index + 1}`,
    name: `pane-${index + 1}`,
    description: "d".repeat(400),
    command: `run-${index + 1} ${"x".repeat(400)}`,
    cwd: `/repo/${"nested/".repeat(80)}${index + 1}`,
    status: "working",
    summary: `summary-${index + 1} ${"s".repeat(800)}`
  }));

  const out = buildWorkerRuntimeContext({
    panes
  });

  expect(out).toMatch(/pane-1/);
  expect(out).toMatch(/pane-4/);
  expect(out).not.toMatch(/pane-5/);
  expect(out).toMatch(/6 additional pane\(s\) omitted/);
  expect(out).toContain("…");
});

test("no segment carries a Memory section when none was injected", () => {
  const { restore } = withTempDataDir();
  try {
    _clearTemplateCache();
    expect(buildWorkerSystemPrompt().includes("## Memory")).toBe(false);
    expect(buildWorkerInitialContext(baseInput).includes("## Memory")).toBe(false);
    expect(buildWorkerRuntimeContext({ panes: [] }).includes("## Memory")).toBe(false);
  } finally {
    restore();
  }
});

test("memory lands in the initial contexts, never a runtime update, and its tools stay in the system prompt", () => {
  // Memory opens a window and does not change inside it; how to reach for
  // more never changes. They belong to different segments and this pins which.
  const { restore } = withTempDataDir();
  try {
    _clearTemplateCache();
    const memorySection = "## Memory\n\nUSER BRIEF";
    expect(buildWorkerInitialContext({ ...baseInput, memorySection })).toContain(memorySection);
    expect(buildManagerInitialContext({ managerDir: "/m", memorySection })).toContain(memorySection);
    expect(buildWorkerRuntimeContext({ panes: [] })).not.toMatch(/## Memory/);

    const system = buildWorkerSystemPrompt();
    expect(system).toMatch(/memory_search/);
    expect(system).toMatch(/memory_remember/);
    expect(system.replace(/\s+/g, " ")).toContain("Remember on your own judgement only what later conversations need and the project's files or their history do not show: no temporary state, ids, hashes or one-off task details.");
  } finally {
    restore();
  }
});

test("buildWorkerSystemPrompt: names the worker identity and the manager counterpart", () => {
  _clearTemplateCache();
  const out = buildWorkerSystemPrompt();
  expect(out).toMatch(/You are the worker for a Mandate feature thread/);
  expect(out).toMatch(/the manager/);
  expect(out).not.toMatch(/feature agent/i);
  expect(out).not.toMatch(/Overview agent/i);
});

test("buildWorkerSystemPrompt: mentions scoped chat history tools", () => {
  _clearTemplateCache();
  const out = buildWorkerSystemPrompt();
  expect(out).toMatch(/chat_history_search/);
  expect(out).toMatch(/current\s+project/);
  expect(out).toMatch(/historical provenance/);
});

test("buildWorkerSystemPrompt: forbids progress-only exits", () => {
  _clearTemplateCache();
  const out = buildWorkerSystemPrompt();
  expect(out).toMatch(/After a monitor event wakes you, act on it immediately/);
  expect(out).toMatch(/\(`read_pane` for a pane\)/);
  expect(out).toMatch(/Registering a monitor is an action/);
  expect(out).toContain("monitor, list_my_monitors, cancel_monitor");
  expect(out).toMatch(/register `monitor` with a `command` instead of scheduling wakes to check/);
  expect(out).not.toMatch(/watch_window|list_my_watches|cancel_watch/);
  expect(out).toMatch(/Never end a turn by only describing future work/);
  expect(out).toMatch(/while a step is\s+`in_progress`/);
  expect(out).toMatch(/mark it\s+`blocked` with a concrete reason/);
  expect(out).toMatch(/"next I will verify"/);
  expect(out).toMatch(/not a valid stopping point/);
});

test("buildWorkerSystemPrompt: includes Pane recovery guidance section", () => {
  _clearTemplateCache();
  const out = buildWorkerSystemPrompt();
  expect(out).toMatch(/## Pane recovery/);
  expect(out).toMatch(/Mandate restarted — pane recovery context/);
  expect(out).toMatch(/dev servers.*restore/);
});

test("buildWorkerSystemPrompt: points terminal work at the tmux-pane skill", () => {
  _clearTemplateCache();
  const out = buildWorkerSystemPrompt();
  expect(out).toMatch(/load the `tmux-pane` skill before choosing tools/);
  expect(out).toMatch(/Run project shell commands with `bash` by default/);
  expect(out).toMatch(/login shell environment/);
  expect(out).toMatch(/send_keys/);
  expect(out).toMatch(/interactive coding agents/);
  expect(out).not.toMatch(/Project shell commands should normally run in a visible feature pane/);
  expect(out).not.toMatch(/Use bash only for quick non-visible investigation/);
});

test("buildWorkerSystemPrompt: points reports at the canvas-artifact skill", () => {
  _clearTemplateCache();
  const out = buildWorkerSystemPrompt();
  expect(out).toMatch(/Load the `canvas-artifact` skill before writing a report/);
  expect(out).toMatch(/note of the step it belongs to/);
  expect(out).not.toMatch(/Linear, Vercel, Stripe/);
  expect(out).not.toMatch(/bare Tailwind\s+utility names/);
});

test("buildWorkerInitialContext: injects skills outside the immutable system prompt", () => {
  _clearTemplateCache();
  const system = buildWorkerSystemPrompt();
  const initial = buildWorkerInitialContext({
    ...baseInput,
    availableSkillsSection: "<available-skills>\n- tmux-pane: Terminal guidance\n</available-skills>"
  });
  const runtime = buildWorkerRuntimeContext({ panes: baseInput.panes });
  expect(system).not.toMatch(/<available-skills>/);
  expect(initial).toMatch(/MyApp/);
  expect(initial).toMatch(/auth_feat/);
  expect(initial).toMatch(/<available-skills>\s*-\s*tmux-pane: Terminal guidance\s*<\/available-skills>/);
  expect(runtime).not.toMatch(/<available-skills>/);
});

test("buildWorkerSystemPrompt: sends UI proposals to a design canvas", () => {
  _clearTemplateCache();
  expect(buildWorkerSystemPrompt()).toMatch(/`canvas_create` with kind "design"\.\s+Load the\s+`canvas-design` skill first/);
});

test("worker, manager and the tmux-pane skill send long commands to bash in the background, panes to what is interactive or keeps running", () => {
  const worker = readFileSync("src/server/modules/agent/prompts/worker.md", "utf8");
  expect(worker.replace(/\s+/g, " ")).toContain("A command that takes a while (a build, a test suite, waiting on CI) runs with `run_in_background`; you are woken when it ends. Use a feature pane via send_keys instead for interactive coding agents (codex, claude, aider), processes the user should see or that keep running (dev servers, watchers), and commands the user explicitly asks to watch or drive in the terminal.");
  const manager = readFileSync("src/server/modules/agent/prompts/manager.md", "utf8");
  expect(manager.replace(/\s+/g, " ")).toContain("If the work involves an interactive coding agent or a process the user should see or that keeps running, tell the worker to load the `tmux-pane` skill and use its feature pane; other shell commands, long ones included, run through the worker's `bash` tool.");
  const skill = readFileSync("src/server/modules/skills/builtins/tmux-pane/SKILL.md", "utf8");
  expect(skill).toContain("Load before opening coding CLIs, starting dev servers or watchers, or manipulating tmux panes.");
  expect(skill.replace(/\s+/g, " ")).toContain("A long one runs with bash's `run_in_background`, which wakes you when it ends.");
  expect(skill.replace(/\s+/g, " ")).toContain("runs through `bash` by default, long ones with `run_in_background`.");
  expect(skill.replace(/\s+/g, " ")).toContain("dev servers, watchers and other processes that keep running");
  expect(skill).not.toContain("long-running processes");
});

// The line, in every agent's system prompt (the subagents' are
// pinned whole in their own tests): one step instead of several for calls
// that wait on nothing.
const TOGETHER = "Make tool calls that do not depend on each other's results together, in one response; a call that needs another's result waits for it.";
const agentPrompts: [string, () => string][] = [
  ["Your agent", () => readFileSync("src/server/modules/global/prompts/global.md", "utf8")],
  ["a worker", buildWorkerSystemPrompt]
];
test.each(agentPrompts)("%s is asked to make independent tool calls together", (_name, prompt) => {
  expect(prompt().replace(/\s+/g, " ")).toContain(TOGETHER);
});

test("a manager reads it once, among the Dispatching rules, after the one on doing small tasks itself", () => {
  const prompt = buildManagerSystemPrompt();
  const dispatching = prompt.slice(prompt.indexOf("### Dispatching"), prompt.indexOf("### Reports"));
  expect(dispatching.replace(/\s+/g, " ")).toContain(`no dispatch needed. - ${TOGETHER}`);
  expect(prompt.replace(/\s+/g, " ").split(TOGETHER).length).toBe(2);
});
