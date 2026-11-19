import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { ThreadTaskTags } from "@/routes/task-board/ThreadTaskTags";
import { useTaskBoardStore } from "@/store/task-board";
import type { TaskThreadDto } from "@shared/api/task-board";
import { runCleanups } from "../helpers/cleanup.js";
import { mount } from "../helpers/mount.js";
import { taskDto } from "../helpers/client-builders.js";
import { resetTaskBoardStore } from "../helpers/task-board.js";

// A thread linked to tasks shows them beside its title.

afterEach(() => {
  runCleanups();
  resetTaskBoardStore();
});

const linked = (threadId: string): TaskThreadDto => ({ threadId, title: "Pantry page", dot: "working", archived: false, lastReply: null, lastReplyAt: null });

test("a thread's header shows its tasks; a tag opens the task in the agent's panel", async () => {
  act(() => {
    useTaskBoardStore.getState().replaceAll([
      taskDto("tsk_a", { title: "Prices from one source", status: "progress", threads: [linked("thr_1")] }),
      taskDto("tsk_b", { title: "Docs overhaul", status: "done", threads: [linked("thr_1")] }),
      taskDto("tsk_c", { title: "Elsewhere", threads: [linked("thr_2")] })
    ]);
  });
  let at = "";
  function Where() {
    const location = useLocation();
    at = `${location.pathname}${location.search}`;
    return null;
  }
  const host = mount(
    <MemoryRouter initialEntries={["/threads/thr_1"]}>
      <Routes><Route path="*" element={<><ThreadTaskTags threadId="thr_1" /><Where /></>} /></Routes>
    </MemoryRouter>
  ).host;
  const tags = [...host.querySelectorAll<HTMLAnchorElement>('[data-slot="task-chip"]')];
  expect(tags.map((t) => t.textContent)).toEqual(["Prices from one source", "Docs overhaul"]);
  expect(tags.map((t) => t.title)).toEqual(["Open the task", "Open the task"]);
  await act(async () => { tags[0]!.click(); });
  expect(at).toBe("/agent?task=tsk_a");
  // A thread no task names shows nothing.
  const none = mount(<MemoryRouter><ThreadTaskTags threadId="thr_9" /></MemoryRouter>).host;
  expect(none.querySelector('[data-slot="thread-task-tags"]') === null).toBe(true);
});
