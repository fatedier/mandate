import { expect, test } from "bun:test";
import {
  buildManagerInitialContext,
  buildManagerRuntimeContext,
  buildManagerSystemPrompt,
  _clearTemplateCache,
  type ManagerPromptInput
} from "../src/server/modules/agent/system-prompt.js";
import { withTempDataDir } from "./helpers/fixtures.js";
import { emptyPlan, type PlanStepDto } from "../src/shared/api/plans.js";

function freshDataDir() {
  const env = withTempDataDir();
  _clearTemplateCache();
  return env;
}

const input: ManagerPromptInput = {
  projects: [
    {
      id: "p1",
      name: "alpha",
      workingDir: "/repos/alpha",
      isGit: true,
      gitRemote: "git@x:alpha.git",
      featureCount: 2
    }
  ],
  features: [
    {
      id: "f1",
      projectId: "p1",
      projectName: "alpha",
      name: "login",
      mode: "new-branch-new-worktree",
      branch: "feat/login",
      baseRef: "main",
      workingDir: "/repos/alpha/.wt/login",
      primaryPaneStatus: "working"
    }
  ]
};

test("buildManagerRuntimeContext: includes active projects and features", () => {
  const { restore } = freshDataDir();
  try {
    const out = buildManagerRuntimeContext(input);
    expect(out).toMatch(/Active projects: 1/);
    expect(out).toMatch(/Active features: 1/);
    expect(out).toMatch(/alpha/);
    expect(out).toMatch(/login/);
    expect(out).toMatch(/working/);
    expect(out).not.toMatch(/\/tmp\/manager-dir/);
  } finally {
    restore();
  }
});

test("buildManagerInitialContext: includes sandbox and preferences", () => {
  const { restore } = freshDataDir();
  try {
    const out = buildManagerInitialContext({
      managerDir: "/tmp/manager-dir",
      agentPreferences: "Prefer Claude for planning and Codex for implementation."
    });
    expect(out).toMatch(/\/tmp\/manager-dir/);
    expect(out).toMatch(/## Agent preferences/);
    expect(out).toMatch(/Prefer Claude for planning and Codex for implementation/);
    expect(out).not.toMatch(/## Active projects/);
  } finally {
    restore();
  }
});

test("buildManagerSystemPrompt: keeps stable operating instructions", () => {
  const { restore } = freshDataDir();
  try {
    const out = buildManagerSystemPrompt();
    expect(out).toMatch(/You are the \*\*Manager\*\* for Mandate/);
    expect(out).toMatch(/per-feature workers/);
    expect(out).not.toMatch(/Overview Agent/);
    expect(out).not.toMatch(/feature agent/i);
    expect(out).toMatch(/Operating principles/);
    expect(out).toMatch(/Keep replies concise by default/);
    expect(out).toMatch(/Avoid surfacing machine-only identifiers/);
    expect(out).toMatch(/not the IDs/);
    expect(out).toMatch(/load the\s+`tmux-pane`\s+skill/);
    expect(out).toMatch(/interactive coding agent/);
    expect(out).not.toMatch(/visible feature pane/);
    expect(out).toMatch(/chat_history_search/);
    // memory_read's call names its target.
    expect(out).toContain('`memory_read({ target: "project", project })`');
    expect(out).toContain("`chat_history_search` searches a project's chats with its exact `projectId`, and every project's task records without one");
    expect(out).toMatch(/To find what earlier workers did, use `chat_history_search`: it searches task\s+records\./);
    expect(out).toMatch(/\[Worker report\]/);
    // What stopped means, and what the manager can do about
    // it: its own message wakes the worker (before, it was told to nudge a
    // worker that nothing of its could wake).
    expect(out).toMatch(/`stopped` — its turn was stopped because the same call kept failing the\s+same way/);
    expect(out).toMatch(/it waits for a message from you or the user/);
    expect(out).toMatch(/your message wakes it/);
    expect(out).toMatch(/do not send the same\s+thing again/);
    expect(out).not.toMatch(/step budget/);
    expect(out).toContain("Monitor: `monitor`");
    expect(out).toContain("`list_my_monitors`, `cancel_monitor`");
    expect(out).not.toMatch(/watch_window|list_my_watches|cancel_watch/);
    expect(out).not.toMatch(/\/tmp\/manager-dir/);
    expect(out).not.toMatch(/## Active projects/);
  } finally {
    restore();
  }
});

test("buildManagerSystemPrompt: points reports at the canvas-artifact skill", () => {
  const { restore } = freshDataDir();
  try {
    const out = buildManagerSystemPrompt();
    expect(out).toMatch(/Load the `canvas-artifact` skill before writing a report/);
    expect(out).not.toMatch(/Linear, Vercel, Stripe/);
    expect(out).not.toMatch(/shipped product surface/);
    expect(out).not.toMatch(/bare Tailwind\s+utility names/);
  } finally {
    restore();
  }
});

test("buildManagerRuntimeContext: a feature's index line carries its plan's state and conclusion", () => {
  const { restore } = freshDataDir();
  try {
    const step = (id: number, status: PlanStepDto["status"]): PlanStepDto => ({
      id, title: `step ${id}`, status, note: "n", createdAt: "2026-05-14T00:00:00.000Z", startedAt: null,
      blockedAt: status === "blocked" ? "2026-05-15T00:00:00.000Z" : null,
      completedAt: status === "done" ? "2026-05-15T00:00:00.000Z" : null, updatedAt: "2026-05-15T00:00:00.000Z"
    });
    const out = buildManagerRuntimeContext({
      ...input,
      features: [{
        ...input.features[0]!,
        plan: { ...emptyPlan("f1"), conclusion: "Waiting on upstream", steps: [step(1, "done"), step(2, "blocked")], updatedAt: "2026-05-15T00:00:00.000Z" },
        failure: null,
        running: false
      }]
    });
    expect(out).toContain("; plan: Blocked · 1/2 · Waiting on upstream");
    expect(out).not.toContain("; context:");
    // A failed wake, and a question in the plan, each lead the line under their own name.
    for (const [failure, openQuestions, label] of [[{ at: "2026-05-15T00:00:00.000Z", kind: "error" }, [], "Failed"], [null, ["Split the plugin PR?"], "Waiting for an answer"]] as const) {
      const flagged = buildManagerRuntimeContext({
        ...input,
        features: [{
          ...input.features[0]!,
          plan: { ...emptyPlan("f1"), conclusion: "Waiting on upstream", openQuestions: [...openQuestions], steps: [step(1, "done"), step(2, "blocked")], updatedAt: "2026-05-15T00:00:00.000Z" },
          failure,
          running: false
        }]
      });
      expect(flagged).toContain(`; plan: ${label} · 1/2 · Waiting on upstream`);
    }
  } finally {
    restore();
  }
});

test("buildManagerRuntimeContext: limits feature detail to plan freshness and recent features", () => {
  const { restore } = freshDataDir();
  try {
    const features = Array.from({ length: 14 }, (_, index) => ({
      id: `f${index}`,
      projectId: "p1",
      projectName: "alpha",
      name: `feature-${index}`,
      mode: "new-branch-new-worktree",
      branch: `feat/${index}`,
      baseRef: "main",
      workingDir: `/repos/alpha/.wt/${index}`,
      primaryPaneStatus: "unknown",
      updatedAt: `2026-05-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      plan: index === 0
        ? { ...emptyPlan(`f${index}`), conclusion: "Recently refreshed plan.", updatedAt: "2026-05-31T00:00:00.000Z" }
        : null
    }));

    const out = buildManagerRuntimeContext({
      ...input,
      features
    });

    expect(out).toMatch(/Active features: 14/);
    expect(out).not.toMatch(/Features needing overview attention/);
    expect(out).toMatch(/feature-0/);
    expect(out).toMatch(/feature-13/);
    expect(out).not.toContain("feature-1 (id f1)");
    expect(out).toMatch(/2 additional feature\(s\) omitted/);
  } finally {
    restore();
  }
});

test("buildManagerRuntimeContext: empty memorySection when no database memory is injected", () => {
  const { restore } = freshDataDir();
  try {
    const out = buildManagerRuntimeContext(input);
    expect(out).not.toMatch(/## Memory/);
    expect(out).not.toMatch(/\{\{memorySection\}\}/);
  } finally {
    restore();
  }
});

test("buildManagerRuntimeContext: handles zero projects", () => {
  const { restore } = freshDataDir();
  try {
    const out = buildManagerRuntimeContext({ ...input, projects: [], features: [] });
    expect(out).toMatch(/No active projects/);
    expect(out).toMatch(/No active features/);
  } finally {
    restore();
  }
});

test("buildManagerInitialContext: injects skills outside the immutable system prompt", () => {
  const system = buildManagerSystemPrompt();
  const out = buildManagerInitialContext({
    managerDir: "/tmp/manager-dir",
    availableSkillsSection: "<available-skills>\n- foo: bar\n</available-skills>"
  });
  expect(system).not.toMatch(/<available-skills>/);
  expect(out).toMatch(/<available-skills>\s*-\s*foo: bar\s*<\/available-skills>/);
});

test("buildManagerSystemPrompt: reporting preferences are saved for every thread without being asked to", () => {
  const { restore } = freshDataDir();
  try {
    const out = buildManagerSystemPrompt().replace(/\s+/g, " ");
    // A preference given in one thread holds in all of them.
    expect(out).toContain("When the user says how they want things done — worker reports, reviews, what to ask before acting — save it with `memory_remember`");
    expect(out).toContain("`scope: \"user\"` unless it is about one project. Every thread follows it.");
    // The agent also remembers on its own judgement, narrowly.
    expect(out).toContain("Remember on your own judgement only what later conversations need and the project's files and their history do not show.");
  } finally {
    restore();
  }
});

test("buildManagerSystemPrompt: sends UI proposals to a design canvas", () => {
  const { restore } = freshDataDir();
  try {
    expect(buildManagerSystemPrompt()).toMatch(/`canvas_create` with kind "design"\.\s+Load the\s+`canvas-design` skill first/);
  } finally {
    restore();
  }
});
