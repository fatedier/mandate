import { afterEach, expect, test } from "bun:test";
import type { WaitKind } from "../src/shared/thread-dot.js";
import { answersMetadata } from "../src/shared/questions.js";
import { freshStoresEnv, seedFeature, seedProject, type StoresEnv } from "./helpers/fixtures.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import { stopOfTarget } from "../src/server/modules/global/thread-signals.js";

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

function setup() {
  env = freshStoresEnv("md-thread-signals-");
  const workStore = new WorkItemStore(env.store.db);
  const busy = new Set<string>();
  const watching = new Map<string, WaitKind>();
  const thread = env.agentStore.createManagerThread("Search timeout");
  const projectId = seedProject(env.projects, { name: "m", workingDir: "/tmp/m", tmuxSessionName: "m" });
  const featureId = seedFeature(env.features, projectId, { name: "login", ownerThreadId: thread.id });
  const workerThread = env.agentStore.getOrCreateThread("worker", featureId);
  const planStore = new PlanStore(env.store.db);
  const deps = {
    agentStore: env.agentStore, featuresStore: env.features, workStore, planStore,
    isBusy: (id: string) => busy.has(id), waitKind: (id: string) => watching.get(id) ?? null
  };
  return { env, workStore, planStore, busy, watching, thread, featureId, workerThread, deps };
}

test("a manager thread has not stopped while it, or a worker it owns, is busy or watching", () => {
  const s = setup();
  s.busy.add(s.thread.id);
  expect(stopOfTarget(s.deps, s.thread.id)).toBeNull();
  s.busy.clear();
  s.busy.add(s.workerThread.id);
  expect(stopOfTarget(s.deps, s.thread.id)).toBeNull();
  s.busy.clear();
  s.watching.set(s.workerThread.id, "pane");
  expect(stopOfTarget(s.deps, s.thread.id)).toBeNull();
  s.watching.clear();
  s.watching.set(s.thread.id, "command");
  expect(stopOfTarget(s.deps, s.thread.id)).toBeNull();
  // Its manager's alarm is no wait: a manager has no plan that says it is still at work.
  s.watching.set(s.thread.id, "alarm");
  expect(stopOfTarget(s.deps, s.thread.id)).toBe("stopped");
  s.watching.clear();
  expect(stopOfTarget(s.deps, s.thread.id)).toBe("stopped");
});

test("stopped, it reads the workers' questions and its own last turn", () => {
  const s = setup();
  // A worker's finished plan is its manager's: the thread has simply stopped.
  s.planStore.update(s.featureId, { steps: [{ title: "Wire", status: "done", note: "ok" }] });
  expect(stopOfTarget(s.deps, s.thread.id)).toBe("stopped");
  // A worker's question nobody took up: with the whole thread at rest, it needs the user.
  s.planStore.update(s.featureId, { openQuestions: ["Keep the old flag as an alias?"] });
  expect(stopOfTarget(s.deps, s.thread.id)).toBe("needs_you");
  s.planStore.update(s.featureId, { openQuestions: [] });
  expect(stopOfTarget(s.deps, s.thread.id)).toBe("stopped");
  s.planStore.update(s.featureId, { openQuestions: ["Keep the old flag as an alias?"] });
  const wake = s.env.agentStore.createWake({ threadId: s.thread.id, reason: "user", triggerMessageId: null });
  s.env.agentStore.finishWake(wake.id, "error", "provider overloaded");
  expect(stopOfTarget(s.deps, s.thread.id)).toBe("failed");
});

// What the thread's own manager asked the user: whoever waits on the thread is
// told it needs them once it has stopped, and not before.
test("a thread whose manager asked the user has stopped needing them; still at work, it has not stopped", () => {
  const s = setup();
  s.env.agentStore.appendMessage({
    threadId: s.thread.id, role: "tool", source: "self",
    content: { type: "tool_result", toolCallId: "c1", toolName: "ask_user", result: { asked: true, questionId: "q_1", question: "Push the branch?", options: [] } }
  });
  expect(stopOfTarget(s.deps, s.thread.id)).toBe("needs_you");
  s.busy.add(s.thread.id);
  expect(stopOfTarget(s.deps, s.thread.id)).toBeNull();
  s.busy.clear();
  // Answered: it has simply stopped.
  s.env.agentStore.appendMessage({ threadId: s.thread.id, role: "user", source: "user", content: { type: "text", text: "Push it.", metadata: answersMetadata([{ id: "q_1", question: "Push the branch?" }]) } });
  expect(stopOfTarget(s.deps, s.thread.id)).toBe("stopped");
});

test("a worker's own chat is judged by that worker alone", () => {
  const s = setup();
  s.busy.add(s.thread.id);
  expect(stopOfTarget(s.deps, s.workerThread.id)).toBe("stopped");
  s.busy.add(s.workerThread.id);
  expect(stopOfTarget(s.deps, s.workerThread.id)).toBeNull();
  s.busy.delete(s.workerThread.id);
  s.planStore.update(s.featureId, { openQuestions: ["Keep the old flag as an alias?"] });
  expect(stopOfTarget(s.deps, s.workerThread.id)).toBe("needs_you");
  // Still in its turn, it has not stopped, question or not.
  s.busy.add(s.workerThread.id);
  expect(stopOfTarget(s.deps, s.workerThread.id)).toBeNull();
});

test("an archived worker no longer counts toward its thread; an unknown or archived target is not judged", () => {
  const s = setup();
  s.busy.add(s.workerThread.id);
  s.env.features.archive(s.featureId);
  expect(stopOfTarget(s.deps, s.thread.id)).toBe("stopped");
  expect(stopOfTarget(s.deps, "thr_missing")).toBeNull();
  s.env.agentStore.archiveThread(s.thread.id);
  expect(stopOfTarget(s.deps, s.thread.id)).toBeNull();
});
