import { expect, test } from "bun:test";
import {
  buildWorkerInitialContext,
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

test("buildWorkerRuntimeContext: renders a pane with its status", () => {
  _clearTemplateCache();
  const out = buildWorkerRuntimeContext({
    panes: [
      {
        paneId: "%1",
        command: "claude",
        cwd: "/repo",
        status: "working",
        summary: "Editing auth/login.ts"
      }
    ]
  });
  expect(out).toMatch(/%1.*working/);
});

test("buildWorkerRuntimeContext: empty panes section degrades gracefully", () => {
  _clearTemplateCache();
  const out = buildWorkerRuntimeContext({ panes: [] });
  expect(out).toMatch(/Active panes: 0/);
  expect(out).toMatch(/use list_panes/);
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
  const out = buildWorkerRuntimeContext({
    panes: [],
    tasksSection: "No open structured tasks.",
    memorySection: "## Memory\n- current memory"
  });
  expect(out).not.toMatch(/MyApp/);
  expect(out).not.toMatch(/auth_feat/);
  expect(out).not.toMatch(/Agent preferences/);
  expect(out).toMatch(/compact routing digest/);
  expect(out).toMatch(/## Turn liveness/);
  expect(out).toMatch(/do not end the turn by only describing\s+future work/);
  expect(out).toMatch(/Registering a\s+watch is an action/);
  expect(out).toMatch(/Only once a\s+`watch_window` wake actually fires should\s+you inspect the target immediately/);
  expect(out).toMatch(/Active panes: 0/);
  expect(out).toMatch(/No open structured tasks/);
  expect(out).toMatch(/current memory/);
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
    panes,
    tasksSection: "No open structured tasks."
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

test("injected memory lands in runtime context, and its tools stay in the system prompt", () => {
  // The memory a feature has right now changes between wakes; how to reach for
  // more does not. They belong to different segments and this pins which.
  const { restore } = withTempDataDir();
  try {
    _clearTemplateCache();
    const runtime = buildWorkerRuntimeContext({
      panes: [],
      memorySection: "## Memory\n- (feature/procedural) Prefer visible panes for shell commands."
    });
    expect(runtime).toMatch(/Prefer visible panes for shell commands/);

    const system = buildWorkerSystemPrompt();
    expect(system).toMatch(/memory_search/);
    expect(system).toMatch(/memory_remember/);
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

test("buildWorkerSystemPrompt: forbids progress-only task exits", () => {
  _clearTemplateCache();
  const out = buildWorkerSystemPrompt();
  expect(out).toMatch(/After a `watch_window` event wakes you, act on it immediately/);
  expect(out).toMatch(/inspect the\s+target with `read_pane`/);
  expect(out).toMatch(/Registering a watch is an action/);
  expect(out).toMatch(/Never end a turn by only describing future work/);
  expect(out).toMatch(/`active` or `waiting`/);
  expect(out).toMatch(/`task_complete`/);
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

test("buildWorkerSystemPrompt: gives canvas quality guidance", () => {
  _clearTemplateCache();
  const out = buildWorkerSystemPrompt();
  expect(out).toMatch(/load the `canvas-artifact` skill/);
  expect(out).toMatch(/shipped product surface/);
  expect(out).toMatch(/Linear, Vercel, Stripe/);
  expect(out).toMatch(/visual weight tracks hierarchy/);
  expect(out).toMatch(/fake controls/);
  expect(out).toMatch(/Namespace your own CSS classes/);
  expect(out).toMatch(/bare Tailwind\s+utility names such as\s+`fixed`/);
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
