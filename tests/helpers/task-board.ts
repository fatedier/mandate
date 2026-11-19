import { act } from "react";
import { TASK_BOARD_DEFAULTS, TASK_BOARD_STORAGE_KEY, useTaskBoardStore } from "../../src/client/store/task-board.js";

/** The task board store back to empty and its defaults, and nothing kept. */
export function resetTaskBoardStore(): void {
  act(() => { useTaskBoardStore.setState({ tasks: null, deleted: new Map(), details: new Map(), taskAction: null, ...TASK_BOARD_DEFAULTS }); });
  localStorage.removeItem(TASK_BOARD_STORAGE_KEY);
}
