import { expect, test } from "bun:test";
import { CanvasStore } from "../src/server/modules/canvas/canvas-store.js";
import { LocalMemoryProvider } from "../src/server/modules/memory/local-provider.js";
import { freshStoresEnv } from "./helpers/fixtures.js";

const SHORT_ID = /^[a-z]+_[A-Za-z0-9_-]{11}$/;

test("persistent resources use short prefixed ids", async () => {
  const env = freshStoresEnv("md-short-id-");
  try {
    const projectId = env.projects.insert({
      name: "P",
      workingDir: "/tmp",
      isGit: false,
      gitRemote: null,
      tmuxSessionName: "md-p",
      ownership: "app"
    });
    const featureId = env.features.insert({
      projectId,
      name: "F",
      mode: "shared-cwd",
      branch: null,
      worktreePath: null,
      tmuxWindowName: "f",
      ownership: "app"
    });
    const thread = env.agentStore.getOrCreateThread("worker", featureId);
    const message = env.agentStore.appendMessage({
      threadId: thread.id,
      role: "user",
      source: "user",
      content: { type: "text", text: "hello" }
    });
    const wake = env.agentStore.createWake({
      threadId: thread.id,
      reason: "user",
      triggerMessageId: message.id
    });
    const task = env.agentStore.createTask({
      featureId,
      threadId: thread.id,
      source: "agent",
      channel: "manager",
      title: "Do work",
      message: "Do work"
    });
    const mailbox = env.agentStore.enqueueMailboxMessage({
      threadId: thread.id,
      role: "user",
      source: "manager",
      content: { type: "text", text: "done" }
    });
    const canvas = new CanvasStore(env.store.db, env.dir).create({
      title: "Plan",
      scope: "worker",
      scopeId: featureId,
      threadId: thread.id
    });
    const memory = await new LocalMemoryProvider(env.store.db).remember({
      scope: "feature",
      projectId,
      featureId,
      kind: "semantic",
      content: "Remember short IDs.",
      source: "manual"
    });

    expect(projectId).toMatch(/^proj_/);
    expect(featureId).toMatch(/^feat_/);
    expect(thread.id).toMatch(/^thr_/);
    expect(message.id).toMatch(/^msg_/);
    expect(wake.id).toMatch(/^wake_/);
    expect(task.id).toMatch(/^task_/);
    expect(mailbox.id).toMatch(/^mbx_/);
    expect(canvas.id).toMatch(/^cnv_/);
    expect(memory.id).toMatch(/^mem_/);
    for (const id of [projectId, featureId, thread.id, message.id, wake.id, task.id, mailbox.id, canvas.id, memory.id]) {
      expect(id).toMatch(SHORT_ID);
    }
  } finally {
    env.cleanup();
  }
});
