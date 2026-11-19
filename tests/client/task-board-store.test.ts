import { afterEach, expect, test } from "bun:test";
import { SSE_EVENTS } from "@shared/api-contracts";
import { attachSnapshotSseListeners } from "@/lib/snapshot-sse-listeners";
import { detailAutoWidth, TASK_BOARD_STORAGE_KEY, useTaskBoardStore } from "@/store/task-board";
import { resetTaskBoardStore } from "../helpers/task-board.js";
import { runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { taskDto } from "../helpers/client-builders.js";
import { act } from "react";

// The client's copy of the owner's task board: filled and kept by the stream,
// written through the owner's routes.

afterEach(() => {
  runCleanups();
  resetTaskBoardStore();
});

function stream(): EventSource {
  const source = new EventTarget() as EventSource;
  attachSnapshotSseListeners(source, { cancelled: () => false, setConnection() {}, onReconnect() {} });
  return source;
}
const send = (source: EventSource, type: string, data: unknown) => source.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
const ids = () => [...(useTaskBoardStore.getState().tasks?.keys() ?? [])];

test("SSE updates replace, upsert and remove", () => {
  const source = stream();
  expect(useTaskBoardStore.getState().tasks).toBe(null);
  send(source, SSE_EVENTS.taskBoard, { tasks: [taskDto("tsk_a"), taskDto("tsk_b")] });
  expect(ids()).toEqual(["tsk_a", "tsk_b"]);
  send(source, SSE_EVENTS.taskBoardTaskUpdated, { task: taskDto("tsk_a", { title: "Renamed" }) });
  send(source, SSE_EVENTS.taskBoardTaskUpdated, { task: taskDto("tsk_c") });
  expect(useTaskBoardStore.getState().tasks!.get("tsk_a")!.title).toBe("Renamed");
  expect(ids()).toEqual(["tsk_a", "tsk_b", "tsk_c"]);
  // A deleted task leaves the board for Recently deleted.
  send(source, SSE_EVENTS.taskBoardTaskUpdated, { task: taskDto("tsk_b", { deletedAt: "2026-11-09T10:00:00.000Z" }) });
  expect(ids()).toEqual(["tsk_a", "tsk_c"]);
  expect([...useTaskBoardStore.getState().deleted.keys()]).toEqual(["tsk_b"]);
  // Deleted forever: gone from both.
  send(source, SSE_EVENTS.taskBoardTaskRemoved, { id: "tsk_b" });
  expect(useTaskBoardStore.getState().deleted.size).toBe(0);
  send(source, SSE_EVENTS.taskBoardTaskRemoved, { id: "tsk_c" });
  expect(ids()).toEqual(["tsk_a"]);
  // The board sent again on a reconnect replaces what was there.
  send(source, SSE_EVENTS.taskBoard, { tasks: [taskDto("tsk_d")] });
  expect(ids()).toEqual(["tsk_d"]);
});

test("the view, the detail width, the folded statuses and the filters are remembered", () => {
  expect(useTaskBoardStore.getState().view).toBe("board");
  // No width until the owner drags one: the detail sizes itself by the page.
  expect(useTaskBoardStore.getState().detailWidth).toBe(null);
  useTaskBoardStore.getState().setView("due");
  useTaskBoardStore.getState().setDetailWidth(720);
  const kept = JSON.parse(localStorage.getItem(TASK_BOARD_STORAGE_KEY)!) as { state: Record<string, unknown> };
  expect(kept.state).toEqual({ view: "due", detailWidth: 720, folded: { done: true }, boardFolded: {}, filters: { labels: [], due: [] } });
});

test("a board column folded or opened by hand is remembered, apart from the list's folds", () => {
  // The list starts with Done folded; the board with every column left to the pane.
  expect([useTaskBoardStore.getState().folded, useTaskBoardStore.getState().boardFolded]).toEqual([{ done: true }, {}]);
  useTaskBoardStore.getState().setBoardFolded("done", true);
  useTaskBoardStore.getState().setBoardFolded("todo", true);
  useTaskBoardStore.getState().setBoardFolded("todo", false);
  expect(useTaskBoardStore.getState().boardFolded).toEqual({ done: true, todo: false });
  expect(useTaskBoardStore.getState().folded).toEqual({ done: true });
  const kept = JSON.parse(localStorage.getItem(TASK_BOARD_STORAGE_KEY)!) as { state: { boardFolded: unknown } };
  expect(kept.state.boardFolded).toEqual({ done: true, todo: false });
});

test("with no width dragged, the detail takes half the page, between 680 and 960", () => {
  // Unmeasured (0): the narrowest of these.
  expect([0, 1200, 1600, 1761, 2400].map(detailAutoWidth)).toEqual([680, 680, 800, 881, 960]);
});

test("a width of 680 kept before the width could be unset counts as never dragged; any other is kept", async () => {
  const kept = async (state: Record<string, unknown>, version: number) => {
    localStorage.setItem(TASK_BOARD_STORAGE_KEY, JSON.stringify({ state, version }));
    await act(async () => { await useTaskBoardStore.persist.rehydrate(); });
    return useTaskBoardStore.getState().detailWidth;
  };
  expect(await kept({ view: "list", detailWidth: 680 }, 0)).toBe(null);
  expect(await kept({ view: "list", detailWidth: 700 }, 0)).toBe(700);
  // Dragged to 680 since: it is theirs.
  expect(await kept({ view: "list", detailWidth: 680 }, 1)).toBe(680);
  expect(await kept({ view: "list", detailWidth: null }, 1)).toBe(null);
});

test("a failed request surfaces the server's message", async () => {
  mockFetch(() => jsonResponse({ error: "a task needs a title" }, 400));
  let message = "";
  await useTaskBoardStore.getState().create({ title: " " }).catch((err: unknown) => { message = (err as Error).message; });
  expect(message).toBe("a task needs a title");
});
