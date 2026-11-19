import { expect, spyOn, test } from "bun:test";
import type { buildAgentRuntime } from "../src/server/runtime/agent-runtime.js";
import type { PostWakeInfo, WakeScheduler } from "../src/server/modules/agent/wake-loop.js";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { stub, toolContext } from "./helpers/typed.js";
import path from "node:path";
import { SkillRegistry } from "../src/server/modules/skills/skill-registry.js";
import { loadBuiltinSkills } from "../src/server/modules/skills/skill-loader.js";
import { testAgentRuntime } from "./helpers/agent-runtime.js";

// The runtime publishes Personal agent's page when the personal agent's turn ends, and
// only then: a manager's turn never touches it.

/** A page whose publisher is the test's; its subagent hooks do nothing. */
function pageOf(publisher: { afterAgentTurn: () => void }) {
  return { dir: "/nonexistent/page", publisher: { afterSubagent: () => false, writeStarted: () => {}, ...publisher } };
}

function postWakeHookOf(runtime: ReturnType<typeof buildAgentRuntime>) {
  const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
  return deps.postWakeHook!;
}

test("The personal agent's turn end publishes its page, however the turn ended; a manager's does not", async () => {
  const env = freshStoresEnv("md-page-runtime-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  try {
    let published = 0;
    runtime = testAgentRuntime(env, { page: pageOf({ afterAgentTurn: () => { published += 1; } }) });
    const personal = env.agentStore.getOrCreatePersonalThread();
    const manager = env.agentStore.createManagerThread("Docs overhaul");
    const hook = postWakeHookOf(runtime);
    for (const status of ["finished", "error", "canceled"] as const) {
      const wake = env.agentStore.createWake({ threadId: personal.id, reason: "user", triggerMessageId: null });
      env.agentStore.finishWake(wake.id, status);
      await hook(personal.id, stub<PostWakeInfo>({ wakeId: wake.id, status }));
    }
    expect(published).toBe(3);
    const wake = env.agentStore.createWake({ threadId: manager.id, reason: "user", triggerMessageId: null });
    env.agentStore.finishWake(wake.id, "finished");
    await hook(manager.id, stub<PostWakeInfo>({ wakeId: wake.id, status: "finished" }));
    expect(published).toBe(3);
  } finally {
    runtime?.dispose();
  }
});

test("a page that cannot be published never fails the personal agent's turn", async () => {
  const env = freshStoresEnv("md-page-runtime-throw-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    runtime = testAgentRuntime(env, { page: pageOf({ afterAgentTurn: () => { throw new Error("disk full"); } }) });
    const personal = env.agentStore.getOrCreatePersonalThread();
    const wake = env.agentStore.createWake({ threadId: personal.id, reason: "user", triggerMessageId: null });
    env.agentStore.finishWake(wake.id, "finished");
    await postWakeHookOf(runtime)(personal.id, stub<PostWakeInfo>({ wakeId: wake.id, status: "finished" }));
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain("[page] publishing after the personal agent's turn failed: disk full");
  } finally {
    warn.mockRestore();
    runtime?.dispose();
  }
});

test("The personal agent's skill tool reads its own skills and the canvas ones, not the pane skill; a manager's does not see agent-page", async () => {
  const env = freshStoresEnv("md-page-runtime-skills-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  try {
    const builtins = path.resolve(import.meta.dirname, "../src/server/modules/skills/builtins");
    runtime = testAgentRuntime(env, { skillRegistry: new SkillRegistry([await loadBuiltinSkills(builtins)]) });
    const skillOf = (scope: "personal" | "manager") => runtime!.scopes[scope].toolDefinitions.find((t) => t.name === "skill")!;
    const personal = env.agentStore.getOrCreatePersonalThread();
    const manager = env.agentStore.createManagerThread("Docs overhaul");
    expect(String(await skillOf("personal").handler({ name: "agent-page" }, toolContext({ threadId: personal.id })))).toContain("# The page");
    expect(String(await skillOf("personal").handler({ name: "canvas-artifact" }, toolContext({ threadId: personal.id })))).toContain("## Rules for every report");
    expect(await skillOf("personal").handler({ name: "tmux-pane" }, toolContext({ threadId: personal.id }))).toEqual({ error: "Unknown skill: tmux-pane" });
    expect(await skillOf("manager").handler({ name: "agent-page" }, toolContext({ threadId: manager.id }))).toEqual({ error: "Unknown skill: agent-page" });
  } finally {
    runtime?.dispose();
  }
});
