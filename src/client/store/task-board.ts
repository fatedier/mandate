import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { api } from "@/lib/api-paths";
import type { CommentBody, CreateTaskBody, PatchTaskBody, TaskBoardDeletedResponse, TaskBoardDto, TaskDetailDto, TaskDetailResponse, TaskDto, TaskEntryDto, TaskEntryResponse, TaskResponse, TaskStatus } from "@shared/api/task-board";

export type TaskBoardView = "board" | "list" | "due";
/** The Due filter's choices. */
export type DueFilter = "overdue" | "week" | "none";
/** What the board is narrowed to: labels (any of them) and due (any of them); both must match. */
export interface TaskFilters {
  labels: string[];
  due: DueFilter[];
}

/** The detail's width: at least this, and leaves the view at least
 *  DETAIL_LEAVES beside it. Until the owner drags one it is half the page,
 *  between DETAIL_DEFAULT_WIDTH and DETAIL_AUTO_MAX. */
export const DETAIL_MIN_WIDTH = 420;
export const DETAIL_LEAVES = 320;
export const DETAIL_DEFAULT_WIDTH = 680;
export const DETAIL_AUTO_MAX = 960;
/** The detail's width while none was dragged, in a row this wide (0: not
 *  measured yet). */
export function detailAutoWidth(rowWidth: number): number {
  return Math.min(Math.max(Math.round(rowWidth / 2), DETAIL_DEFAULT_WIDTH), DETAIL_AUTO_MAX);
}
export const TASK_BOARD_STORAGE_KEY = "mandate.task-board.v1";

export interface TaskAction {
  taskId: string;
  kind: "rename" | "ask";
  /** Tells one request from the next for the same task. */
  nonce: number;
}

interface TaskBoardState {
  /** The board as the stream sent it; null until it has. Deleted tasks are
   *  not here but in `deleted`. */
  tasks: Map<string, TaskDto> | null;
  /** Recently deleted, as read and as the stream tells of deletes. */
  deleted: Map<string, TaskDto>;
  /** Each task's stream, by task, as last read. */
  details: Map<string, TaskDetailDto>;
  /** Kept per browser. */
  view: TaskBoardView;
  /** The width the owner dragged the detail to; null until they do. */
  detailWidth: number | null;
  /** The list's statuses folded (true) or opened (false) by hand; one not
   *  here is open, but Backlog (listFolded). */
  folded: Partial<Record<TaskStatus, boolean>>;
  /** The board's columns folded away (true) or kept open (false) by hand; one
   *  not here is left to the pane, which folds an empty one when short of
   *  room, but Backlog, folded until opened (boardFoldedByHand). */
  boardFolded: Partial<Record<TaskStatus, boolean>>;
  /** Kept until cleared. */
  filters: TaskFilters;
  /** A task asked to open ready for something (a card's Rename or Ask): the
   *  task's page does it once, then clears it. Not kept. */
  taskAction: TaskAction | null;
  requestTaskAction(taskId: string, kind: TaskAction["kind"]): void;
  clearTaskAction(nonce: number): void;
  setView(view: TaskBoardView): void;
  toggleFolded(status: TaskStatus): void;
  setBoardFolded(status: TaskStatus, folded: boolean): void;
  toggleLabelFilter(name: string): void;
  /** Ticks exactly these labels (Select all, or none). */
  setLabelFilter(names: string[]): void;
  toggleDueFilter(due: DueFilter): void;
  clearFilters(): void;
  addLabel(id: string, name: string): Promise<TaskDto>;
  removeLabel(id: string, name: string): Promise<TaskDto>;
  setDetailWidth(width: number): void;
  replaceAll(tasks: TaskDto[]): void;
  upsert(task: TaskDto): void;
  remove(id: string): void;
  fetchDeleted(): Promise<void>;
  fetchDetail(id: string): Promise<TaskDetailDto>;
  /** The owner has the task in front of them. */
  opened(id: string): Promise<void>;
  create(body: CreateTaskBody): Promise<TaskDto>;
  patch(id: string, body: PatchTaskBody): Promise<TaskDto>;
  comment(id: string, body: CommentBody): Promise<TaskEntryDto>;
  removeTask(id: string): Promise<void>;
  restore(id: string): Promise<void>;
  /** A task in Recently deleted, gone for good. */
  deleteForever(id: string): Promise<void>;
  removeAllDone(): Promise<number>;
}

/** A request's answer, or the server's own words for a refusal. */
async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init?.body ? { ...init, headers: { "content-type": "application/json", ...init.headers } } : init);
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

/** What a browser keeps, as it starts. */
export const TASK_BOARD_DEFAULTS = {
  view: "board" as TaskBoardView,
  detailWidth: null as number | null,
  folded: { done: true } as Partial<Record<TaskStatus, boolean>>,
  boardFolded: {} as Partial<Record<TaskStatus, boolean>>,
  filters: { labels: [], due: [] } as TaskFilters
};
/** Backlog, what is kept for later, starts folded in the list and on the
 *  board until opened by hand: a default, not a stored fold, so a browser
 *  that kept its folds before Backlog existed folds it too. */
const FOLDED_UNTIL_OPENED: ReadonlySet<TaskStatus> = new Set(["backlog"]);

/** Whether the list shows a status folded. */
export function listFolded(folded: Partial<Record<TaskStatus, boolean>>, status: TaskStatus): boolean {
  return folded[status] ?? FOLDED_UNTIL_OPENED.has(status);
}

/** What the owner said of a board column, Backlog's default included:
 *  true folded, false open, undefined left to the pane. */
export function boardFoldedByHand(folded: Partial<Record<TaskStatus, boolean>>, status: TaskStatus): boolean | undefined {
  return folded[status] ?? (FOLDED_UNTIL_OPENED.has(status) ? true : undefined);
}

/** Each task action request's own number: never reused, so a page that
 *  took one does not take the next for the same one. */
let lastTaskActionNonce = 0;

const toggled = <T,>(list: readonly T[], value: T): T[] => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

/**
 * The owner's task board on this page: filled by the stream (the whole board
 * on every open, then each change), written through the owner's routes. A
 * write's answer is put in at once, so the page does not wait for the
 * stream to show what it did.
 */
export const useTaskBoardStore = create<TaskBoardState>()(persist((set, get) => {
  const put = (task: TaskDto) => set((state) => {
    const tasks = new Map(state.tasks ?? []);
    const deleted = new Map(state.deleted);
    if (task.deletedAt) {
      tasks.delete(task.id);
      deleted.set(task.id, task);
    } else {
      deleted.delete(task.id);
      tasks.set(task.id, task);
    }
    return { tasks, deleted };
  });
  return {
    tasks: null,
    deleted: new Map(),
    details: new Map(),
    ...TASK_BOARD_DEFAULTS,
    taskAction: null,
    requestTaskAction: (taskId, kind) => set({ taskAction: { taskId, kind, nonce: ++lastTaskActionNonce } }),
    clearTaskAction: (nonce) => set((s) => (s.taskAction?.nonce === nonce ? { taskAction: null } : {})),
    setView: (view) => set({ view }),
    toggleFolded: (status) => set((s) => ({ folded: { ...s.folded, [status]: !listFolded(s.folded, status) } })),
    setBoardFolded: (status, folded) => set((s) => ({ boardFolded: { ...s.boardFolded, [status]: folded } })),
    // As the filter matches: without regard to case.
    toggleLabelFilter: (name) => set((s) => {
      const on = s.filters.labels.some((l) => l.toLowerCase() === name.toLowerCase());
      return { filters: { ...s.filters, labels: on ? s.filters.labels.filter((l) => l.toLowerCase() !== name.toLowerCase()) : [...s.filters.labels, name] } };
    }),
    setLabelFilter: (names) => set((s) => ({ filters: { ...s.filters, labels: names } })),
    toggleDueFilter: (due) => set((s) => ({ filters: { ...s.filters, due: toggled(s.filters.due, due) } })),
    clearFilters: () => set({ filters: { labels: [], due: [] } }),
    setDetailWidth: (width) => set({ detailWidth: Math.round(width) }),
    replaceAll: (tasks) => set((state) => {
      const deleted = new Map(state.deleted);
      const live = new Map<string, TaskDto>();
      for (const task of tasks) {
        if (task.deletedAt) {
          deleted.set(task.id, task);
          continue;
        }
        deleted.delete(task.id);
        live.set(task.id, task);
      }
      return { tasks: live, deleted };
    }),
    upsert: put,
    remove: (id) => set((state) => {
      const tasks = state.tasks ? new Map(state.tasks) : null;
      tasks?.delete(id);
      const deleted = new Map(state.deleted);
      deleted.delete(id);
      const details = new Map(state.details);
      details.delete(id);
      return { tasks, deleted, details };
    }),
    fetchDeleted: async () => {
      const { tasks } = await call<TaskBoardDto>(api.taskBoardTasks({ deleted: true }));
      set({ deleted: new Map(tasks.map((task) => [task.id, task])) });
    },
    fetchDetail: async (id) => {
      const { task } = await call<TaskDetailResponse>(api.taskBoardTask(id));
      set((state) => ({ details: new Map(state.details).set(id, task) }));
      return task;
    },
    opened: async (id) => {
      await call<{ ok: boolean }>(api.taskBoardOpened(id), { method: "POST" });
    },
    create: async (body) => {
      const { task } = await call<TaskResponse>(api.taskBoardTasks(), json("POST", body));
      put(task);
      return task;
    },
    patch: async (id, body) => {
      const { task } = await call<TaskResponse>(api.taskBoardTask(id), json("PATCH", body));
      put(task);
      return task;
    },
    comment: async (id, body) => {
      const { entry } = await call<TaskEntryResponse>(api.taskBoardComments(id), json("POST", body));
      return entry;
    },
    removeTask: async (id) => {
      await call<{ ok: boolean }>(api.taskBoardTask(id), { method: "DELETE" });
      const task = get().tasks?.get(id);
      if (task) put({ ...task, deletedAt: new Date().toISOString() });
    },
    restore: async (id) => {
      const { task } = await call<TaskResponse>(api.taskBoardRestore(id), { method: "POST" });
      put(task);
    },
    deleteForever: async (id) => {
      await call<{ ok: boolean }>(api.taskBoardForever(id), { method: "DELETE" });
      get().remove(id);
    },
    addLabel: async (id, name) => {
      const { task } = await call<TaskResponse>(api.taskBoardLabels(id), json("POST", { name }));
      put(task);
      return task;
    },
    removeLabel: async (id, name) => {
      const { task } = await call<TaskResponse>(api.taskBoardLabel(id, name), { method: "DELETE" });
      put(task);
      return task;
    },
    removeAllDone: async () => {
      const { deleted } = await call<TaskBoardDeletedResponse>(api.taskBoardDone, { method: "DELETE" });
      return deleted;
    }
  };
}, {
  name: TASK_BOARD_STORAGE_KEY,
  storage: createJSONStorage(() => localStorage),
  // 1: the detail's width may be unset. Before, the default (680) was kept
  // as if dragged: one kept then counts as never dragged.
  version: 1,
  migrate: (kept, version) => {
    const state = kept as { detailWidth?: number | null };
    return version < 1 && state.detailWidth === DETAIL_DEFAULT_WIDTH ? { ...state, detailWidth: null } : state;
  },
  partialize: (state) => ({ view: state.view, detailWidth: state.detailWidth, folded: state.folded, boardFolded: state.boardFolded, filters: state.filters })
}));
