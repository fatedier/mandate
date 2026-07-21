import { expect, test } from "bun:test";
import {
  buildManagerInitialContext,
  buildManagerRuntimeContext,
  buildManagerSystemPrompt,
  _clearTemplateCache,
  type ManagerPromptInput
} from "../src/server/modules/agent/system-prompt.js";
import { withTempDataDir } from "./helpers/fixtures.js";

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
    expect(out).toMatch(/requires an exact `projectId`/);
    expect(out).toMatch(/kind=limit_reached/);
    expect(out).toMatch(/feature-level scheduling decision/);
    expect(out).not.toMatch(/\/tmp\/manager-dir/);
    expect(out).not.toMatch(/## Active projects/);
  } finally {
    restore();
  }
});

test("buildManagerSystemPrompt: gives canvas quality guidance", () => {
  const { restore } = freshDataDir();
  try {
    const out = buildManagerSystemPrompt();
    expect(out).toMatch(/Load the\s+`canvas-artifact` skill/);
    expect(out).toMatch(/shipped product surface/);
    expect(out).toMatch(/Linear, Vercel, Stripe/);
    expect(out).toMatch(/visual weight tracks hierarchy/);
    expect(out).toMatch(/fake controls/);
    expect(out).toMatch(/Namespace your own Canvas CSS classes with the `canvas-` prefix/);
    expect(out).toMatch(/bare Tailwind\s+utility names such as\s+`fixed`/);
  } finally {
    restore();
  }
});

test("buildManagerRuntimeContext: includes feature conversation digest", () => {
  const { restore } = freshDataDir();
  try {
    const out = buildManagerRuntimeContext({
      ...input,
      features: [{
        ...input.features[0]!,
        digest: {
          summary: "Feature chat now owns direct design discussion.",
          decisions: ["Open feature chat by default from the feature page."],
          openQuestions: ["How should overview stay informed?"],
          constraints: ["Do not force design discussion into task queue."],
          updatedAt: "2026-05-15T00:00:00.000Z"
        }
      }]
    });
    expect(out).toMatch(/context: Feature chat now owns direct design discussion/);
    expect(out).not.toMatch(/Decisions: Open feature chat by default/);
    expect(out).not.toMatch(/Open questions: How should overview stay informed/);
    expect(out).not.toMatch(/Constraints: Do not force design discussion into task queue/);
    expect(out).not.toMatch(/Next steps:/);
  } finally {
    restore();
  }
});

test("buildManagerRuntimeContext: limits feature detail to digest freshness and recent features", () => {
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
      digest: index === 0
        ? {
            summary: "Recently refreshed feature context.",
            decisions: [],
            openQuestions: ["Pick the API shape."],
            constraints: [],
            updatedAt: "2026-05-31T00:00:00.000Z"
          }
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

test("buildManagerRuntimeContext: includes injected database memory section", () => {
  const { restore } = freshDataDir();
  try {
    const out = buildManagerRuntimeContext({
      ...input,
      memorySection: "## Memory\n- (global/preference) Prefer concise status replies."
    });
    expect(out).toMatch(/Prefer concise status replies/);
  } finally {
    restore();
  }
});

test("buildManagerRuntimeContext: omits agent preferences", () => {
  const { restore } = freshDataDir();
  try {
    const out = buildManagerRuntimeContext(input);
    expect(out).not.toMatch(/## Agent preferences/);
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
