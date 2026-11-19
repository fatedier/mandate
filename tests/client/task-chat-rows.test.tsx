import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { ChatMessageList } from "@/routes/window/chat/ChatMessageList";
import { userText } from "@/routes/window/chat/row-actions";
import { newThreadState, type AgentMessage } from "@/store/agent-chat";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { useTaskBoardStore } from "@/store/task-board";
import { taskCommentMetadata, taskReminderMetadata } from "@shared/task-board";
import { runCleanups } from "../helpers/cleanup.js";
import { mountAsync } from "../helpers/mount.js";
import { taskDto } from "../helpers/client-builders.js";
import { resetTaskBoardStore } from "../helpers/task-board.js";

// What the personal agent's chat shows of a task's @agent comment and of the
// reminder it gets.

afterEach(() => {
  runCleanups();
  resetTaskBoardStore();
  act(() => { usePersonalAgentStore.setState({ agent: null }); });
});

const A = "tsk_aaaaaaaaaaa";
const at = "2026-11-09T10:00:00.000Z";
const message = (seq: number, source: string, text: string, metadata: Record<string, unknown>): AgentMessage => ({
  id: `m${seq}`, threadId: "thr_g", seq, role: "user", source, sourceThreadId: null, wakeId: null, createdAt: at,
  content: { type: "text", text, metadata }
} as unknown as AgentMessage);

async function transcript(messages: AgentMessage[]) {
  act(() => {
    usePersonalAgentStore.getState().setAgent({ threadId: "thr_g", name: "Jarvis", named: true, unread: false, voiceConfigured: false, lastVisibleSeq: 0, seenSeq: 0, questions: [] });
    useTaskBoardStore.getState().replaceAll([taskDto(A, { title: "Prices from one source", status: "progress" })]);
  });
  const thread = { ...newThreadState(), threadId: "thr_g", loaded: true, messages, oldestSeqLoaded: 1 };
  return (await mountAsync(<ChatMessageList thread={thread} onLoadOlder={async () => {}} onRetryFailed={() => {}} />, { path: "/agent" })).host;
}

test("an @agent comment shows as your words with the task under them", async () => {
  const host = await transcript([
    message(1, "task-comment", `[Task comment] The user commented on "Prices from one source" (${A}) and asked you to act:\n@Jarvis start with dairy\n\n[Task "Prices from one source" (${A})]`, taskCommentMetadata({ taskId: A, text: "@Jarvis start with dairy" }))
  ]);
  const bubble = host.querySelector('[data-slot="user-bubble"]')!;
  expect(bubble.textContent).toBe("@Jarvis start with dairy");
  expect(host.textContent).not.toContain("[Task comment]");
  const under = host.querySelector('[data-slot="relay-label"]')!;
  expect(under.textContent).toBe("Task comment");
  const chip = under.parentElement!.querySelector<HTMLAnchorElement>('[data-slot="task-chip"]');
  expect(chip?.title).toBe("Open the task");
  expect(chip?.querySelector('[data-slot="task-chip-title"]')?.textContent).toBe("Prices from one source");
});

test("the reminder is a faint line naming the task and the thread", async () => {
  const host = await transcript([
    message(1, "task-reminder", `[Task reminder] Thread "Pantry page data source" reported, and the task "Prices from one source" (${A}) has not changed since. Update it if its status, Result or a comment should move.`, taskReminderMetadata({ taskId: A, threadId: "thr_m", threadTitle: "Pantry page data source" }))
  ]);
  expect(host.querySelector('[data-slot="user-bubble"]') === null).toBe(true);
  const line = host.querySelector<HTMLElement>('[data-slot="task-reminder-line"]')!;
  expect(line.textContent).toBe("Reminded Jarvis: Prices from one source has not changed since Pantry page data source reported");
  expect(line.querySelector('[data-slot="task-chip"]')?.getAttribute("data-task-id")).toBe(A);
});

// Copy under the comment copies what it shows.
test("Copy under a task comment copies the owner's words only", () => {
  const m = message(1, "task-comment", `[Task comment] The user commented on "Prices from one source" (${A}) and asked you to act:\n@Jarvis go\n\n[Task …]`, taskCommentMetadata({ taskId: A, text: "@Jarvis go" }));
  expect(userText({ kind: "msg", message: m } as never)).toBe("@Jarvis go");
});
