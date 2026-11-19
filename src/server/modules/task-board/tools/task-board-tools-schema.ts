import { z } from "zod";

/** The statuses in the agent's words (task-text's TASK_STATUS_WORD): backlog,
 *  done and cancelled only on the user's word, which its prompt and the tool's
 *  text say. */
export const AGENT_STATUS_WORDS = ["backlog", "todo", "in progress", "in review", "done", "cancelled"] as const;

/** One tool with an action: a later capability is one more action. Every
 *  field but the action is optional, and a blank counts as not given: a
 *  model fills the fields it does not mean. */
export const taskBoardParams = z.object({
  action: z.enum(["list", "read", "create", "set_status", "write_result", "comment", "link_thread", "unlink_thread", "add_label", "remove_label"]),
  taskId: z.string().nullable().optional(),
  includeClosed: z.boolean().nullable().optional(),
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  dueTime: z.string().nullable().optional(),
  status: z.enum(AGENT_STATUS_WORDS).nullable().optional(),
  note: z.string().nullable().optional(),
  result: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
  threadId: z.string().nullable().optional(),
  label: z.string().nullable().optional()
});
