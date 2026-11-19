import type { Context } from "hono";
import type { MandateModule } from "../module.js";
import { initializeTaskBoardSchema } from "./schema.js";
import { TaskBoardRefusal } from "./task-board-service.js";
import { API_ROUTES } from "../../../shared/api-contracts.js";
import type { CreateTaskBody, PatchTaskBody, TaskBoardDeletedResponse, TaskBoardDto, TaskDetailResponse, TaskEntryResponse, TaskResponse } from "../../../shared/api/task-board.js";
import type { Mention } from "../../../shared/mentions.js";

const body = async (c: Context): Promise<Record<string, unknown>> => {
  const parsed = await c.req.json().catch(() => null) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
};

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const nullableStr = (v: unknown): string | null | undefined => (v === null ? null : typeof v === "string" ? v : undefined);

/** A refusal is the caller's to read; anything else is ours. */
function answer(c: Context, run: () => Response | Promise<Response>): Response | Promise<Response> {
  try {
    return run();
  } catch (err) {
    if (err instanceof TaskBoardRefusal) return c.json({ error: err.message }, err.status);
    throw err;
  }
}

/** The owner's task board: the owner's routes. The personal agent writes
 *  through its tool, never through these. */
export const taskBoardModule: MandateModule = {
  id: "task-board",
  schema: [initializeTaskBoardSchema],
  mountRoutes: (app, { deps }) => {
    const board = deps.taskBoard;
    if (!board) return;
    app.get(API_ROUTES.taskBoardTasks, (c) => c.json({ tasks: board.list({ deleted: c.req.query("deleted") === "1" }) } satisfies TaskBoardDto));
    app.post(API_ROUTES.taskBoardTasks, async (c) => {
      const input = await body(c);
      const create: CreateTaskBody = { title: str(input.title) ?? "", description: str(input.description), dueDate: nullableStr(input.dueDate), dueTime: nullableStr(input.dueTime) };
      return answer(c, () => c.json({ task: board.create(create, "owner") } satisfies TaskResponse, 201));
    });
    app.get(API_ROUTES.taskBoardTask, (c) => answer(c, () => {
      const task = board.detail(c.req.param("id"));
      return task ? c.json({ task } satisfies TaskDetailResponse) : c.json({ error: `no such task: ${c.req.param("id")}` }, 404);
    }));
    // Not the read: a detail reads again in the background; this is the page
    // saying the owner has the task in front of them.
    app.post(API_ROUTES.taskBoardOpened, (c) => {
      const task = board.detail(c.req.param("id"));
      if (!task || task.deletedAt) return c.json({ error: `no such task: ${c.req.param("id")}` }, 404);
      board.opened(task.id);
      return c.json({ ok: true });
    });
    app.patch(API_ROUTES.taskBoardTask, async (c) => {
      const input = await body(c);
      const id = c.req.param("id");
      const patch: PatchTaskBody = { title: str(input.title), description: str(input.description), dueDate: nullableStr(input.dueDate), dueTime: nullableStr(input.dueTime) };
      return answer(c, () => {
        const fields = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
        if (Object.keys(fields).length > 0) board.edit(id, fields);
        if (input.status !== undefined) board.setStatus(id, input.status as never, "owner");
        const task = board.detail(id);
        return task ? c.json({ task } satisfies TaskResponse) : c.json({ error: `no such task: ${id}` }, 404);
      });
    });
    app.delete(API_ROUTES.taskBoardTask, (c) => answer(c, () => {
      board.remove(c.req.param("id"));
      return c.json({ ok: true });
    }));
    app.delete(API_ROUTES.taskBoardForever, (c) => answer(c, () => {
      board.deleteForever(c.req.param("id"));
      return c.json({ ok: true });
    }));
    app.post(API_ROUTES.taskBoardRestore, (c) => answer(c, () => {
      board.restore(c.req.param("id"));
      const task = board.detail(c.req.param("id"));
      return task ? c.json({ task } satisfies TaskResponse) : c.json({ error: `no such task: ${c.req.param("id")}` }, 404);
    }));
    app.post(API_ROUTES.taskBoardComments, async (c) => {
      const input = await body(c);
      const mentions = Array.isArray(input.mentions) ? input.mentions as Mention[] : undefined;
      return answer(c, () => c.json({ entry: board.comment(c.req.param("id"), str(input.text) ?? "", "owner", mentions) } satisfies TaskEntryResponse, 201));
    });
    app.post(API_ROUTES.taskBoardLabels, async (c) => {
      const input = await body(c);
      return answer(c, () => c.json({ task: board.addLabel(c.req.param("id"), str(input.name) ?? "", "owner") } satisfies TaskResponse));
    });
    app.delete(API_ROUTES.taskBoardLabel, (c) => answer(c, () => c.json({ task: board.removeLabel(c.req.param("id"), c.req.param("name")) } satisfies TaskResponse)));
    app.delete(API_ROUTES.taskBoardDone, (c) => c.json({ deleted: board.removeAllDone() } satisfies TaskBoardDeletedResponse));
  }
};
