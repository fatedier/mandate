import { afterEach, expect, test } from "bun:test";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { TaskBoardService } from "../src/server/modules/task-board/task-board-service.js";
import { createTaskCommentPoster } from "../src/server/modules/task-board/task-comment.js";
import { mentionModelLines, resolveMentions } from "../src/server/modules/agent/mentions.js";
import { mentionsMetadata, mentionsOf } from "../src/shared/mentions.js";

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

const NOW = Date.parse("2026-11-09T09:00:00.000Z");

function setup(prefix: string) {
  env = freshStoresEnv(prefix);
  const board = new TaskBoardService({ db: env.store.db, agentStore: env.agentStore, sse: { emit: () => {} } as never, threadDots: () => new Map(), now: () => NOW });
  const deps = { agentStore: env.agentStore, taskBoard: board, agentName: () => "Juno", timeZone: () => "UTC", now: () => NOW };
  return { env, board, deps };
}

test("a task mention carries the task to the personal agent, fixed when sent", () => {
  const { env, board, deps } = setup("md-tm-personal-");
  const personal = env.agentStore.getOrCreatePersonalThread();
  const task = board.create({ title: "Research flour suppliers", description: "Four mills." }, "owner");
  board.comment(task.id, "Start with Atlas Mills.", "owner");
  const [mention] = resolveMentions(deps, personal.id, [{ kind: "task", id: task.id, label: "Research flour suppliers" }]);
  expect(mention).toMatchObject({ kind: "task", id: task.id, label: "Research flour suppliers" });
  expect(mention!.text).toStartWith(`[Task "Research flour suppliers" (${task.id})]`);
  // The user's comments are signed "The user": "You" could read as the agent itself.
  expect(mention!.text).toContain("Comments not yet answered:\n- The user, Nov 9 09:00: Start with Atlas Mills.");
  // What the model reads is what was captured, whatever the task says later.
  board.edit(task.id, { description: "Changed since." });
  expect(mentionModelLines([mention!])).toBe(`${mention!.text}\n`);
  // Kept through the message's metadata.
  expect(mentionsOf({ type: "text", text: "x", metadata: mentionsMetadata([mention!]) })).toEqual([mention!]);
});

test("to a manager it carries the latest comment", () => {
  const { env, board, deps } = setup("md-tm-manager-");
  const thread = env.agentStore.createManagerThread("Bakery receipts");
  const task = board.create({ title: "Print receipts" }, "owner");
  board.comment(task.id, "3.21 waits for this.", "owner");
  const [mention] = resolveMentions(deps, thread.id, [{ kind: "task", id: task.id, label: "Print receipts" }]);
  expect(mention!.text).toContain("Latest comment:\n- The user, Nov 9 09:00: 3.21 waits for this.");
  expect(mention!.text).not.toContain("Comments not yet answered:");
});

test("a block past 8,000 characters is cut with the marker", () => {
  const { env, board, deps } = setup("md-tm-cut-");
  const personal = env.agentStore.getOrCreatePersonalThread();
  const task = board.create({ title: "Pasted brief", description: "x".repeat(20_000) }, "owner");
  const [mention] = resolveMentions(deps, personal.id, [{ kind: "task", id: task.id, label: "Pasted brief" }]);
  expect(mention!.text!.length).toBeLessThanOrEqual(8_000);
  expect(mention!.text).toContain("[… cut; read the rest with task_board read]");
  const thread = env.agentStore.createManagerThread("t");
  const [toManager] = resolveMentions(deps, thread.id, [{ kind: "task", id: task.id, label: "Pasted brief" }]);
  expect(toManager!.text).toContain("[… cut]");
});

test("a mention of a deleted or unknown task is dropped", () => {
  const { env, board, deps } = setup("md-tm-deleted-");
  const personal = env.agentStore.getOrCreatePersonalThread();
  const task = board.create({ title: "Gone" }, "owner");
  board.remove(task.id);
  expect(resolveMentions(deps, personal.id, [{ kind: "task", id: task.id, label: "Gone" }, { kind: "task", id: "tsk_nothinghere", label: "x" }])).toEqual([]);
});

test("a comment with @agent wakes the agent once with the comment and the task", () => {
  const { env, board } = setup("md-tm-comment-");
  const posts: Array<Record<string, unknown>> = [];
  let woken = 0;
  board.setAgentMentioned(createTaskCommentPoster({
    inbox: { post: (message) => { posts.push(message as never); return { wake: () => { woken++; } } as never; } },
    agentStore: env.agentStore, agentName: () => "Juno", timeZone: () => "UTC", now: () => NOW
  }));
  const task = board.create({ title: "Research flour suppliers" }, "owner");
  board.comment(task.id, "@Juno start with Atlas Mills", "owner", [{ kind: "agent", id: "personal", label: "Juno" }]);
  expect(posts).toHaveLength(1);
  expect(woken).toBe(1);
  const personal = env.agentStore.getOrCreatePersonalThread();
  expect(posts[0]).toMatchObject({ to: personal.id, key: `task:${task.id}`, kind: "request", source: "task-comment" });
  const text = (posts[0]!.content as { text: string }).text;
  // The chat shows the user's words and the task, not the model's text.
  expect((posts[0]!.content as { metadata?: Record<string, unknown> }).metadata?.taskComment).toEqual({ taskId: task.id, text: "@Juno start with Atlas Mills" });
  expect(text).toStartWith(`[Task comment] The user commented on "Research flour suppliers" (${task.id}) and asked you to act:\n@Juno start with Atlas Mills\n\n[Task "Research flour suppliers" (${task.id})]`);
});

test("a comment without @agent posts nothing", () => {
  const { env, board } = setup("md-tm-quiet-");
  const posts: unknown[] = [];
  board.setAgentMentioned(createTaskCommentPoster({ inbox: { post: (m) => { posts.push(m); return { wake: () => {} } as never; } }, agentStore: env.agentStore, agentName: () => "Juno" }));
  const task = board.create({ title: "x" }, "owner");
  board.comment(task.id, "No rush.", "owner");
  board.comment(task.id, "Mentions a thread only", "owner", [{ kind: "thread", id: "thr_x", label: "t" }]);
  board.comment(task.id, "@Juno from the agent itself", "agent", [{ kind: "agent", id: "personal", label: "Juno" }]);
  expect(posts).toEqual([]);
});

// The Result is cut as well, or a long one would break the limit.
test("a long Result is cut too: the block stays within 8,000 characters", () => {
  const { env, board, deps } = setup("md-tm-result-cut-");
  const personal = env.agentStore.getOrCreatePersonalThread();
  const task = board.create({ title: "Long result", description: "Short brief." }, "owner");
  board.writeResult(task.id, "r".repeat(13_800));
  board.comment(task.id, "Looks right?", "owner");
  const [mention] = resolveMentions(deps, personal.id, [{ kind: "task", id: task.id, label: "Long result" }]);
  expect(mention!.text!.length).toBeLessThanOrEqual(8_000);
  expect(mention!.text).toContain("Description:\nShort brief.");
  expect(mention!.text).toContain("[… cut; read the rest with task_board read]");
});
