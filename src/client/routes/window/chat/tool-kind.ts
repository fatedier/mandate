import { isRecord } from "@shared/guards";

/** What kind of work a tool does, for the icon its calls are drawn with (the
 *  kind, faint, and no mark for success). */
export type ToolKind =
  | "terminal" | "file" | "edit" | "write" | "image" | "pane" | "memory" | "skill"
  | "plan" | "canvas" | "worker" | "alarm" | "search" | "history" | "link" | "monitor" | "question"
  | "schedule" | "notify" | "task" | "note" | "calendar" | "tool";

/** A Map, not an object: a tool name is whatever the model sent, and a name
 *  like `constructor` must not find what every object inherits. */
const KINDS = new Map<string, ToolKind>(Object.entries({
  bash: "terminal",
  send_keys: "terminal",
  read: "file",
  read_skill_reference: "file",
  edit: "edit",
  write: "write",
  view_image: "image",
  read_pane: "pane",
  spawn_pane: "pane",
  kill_pane: "pane",
  set_pane_metadata: "pane",
  pane_status: "pane",
  list_panes: "pane",
  memory_search: "memory",
  memory_remember: "memory",
  memory_update: "memory",
  memory_read: "memory",
  memory_forget: "memory",
  skill: "skill",
  update_skill: "skill",
  manage_skill: "skill",
  request_skill_review: "skill",
  update_plan: "plan",
  read_plan: "plan",
  dismiss_work_item: "plan",
  canvas: "canvas",
  canvas_create: "canvas",
  canvas_publish: "canvas",
  canvas_read: "canvas",
  canvas_update: "canvas",
  canvas_outline: "canvas",
  canvas_remove_section: "canvas",
  message_worker: "worker",
  read_worker_thread: "worker",
  get_worker_status: "worker",
  archive_worker: "worker",
  restore_worker: "worker",
  create_worker: "worker",
  list_workers: "worker",
  create_project: "worker",
  list_projects: "worker",
  archive_project: "worker",
  end_sweep: "worker",
  schedule_wake: "alarm",
  cancel_alarm: "alarm",
  list_my_alarms: "alarm",
  list_my_monitors: "alarm",
  cancel_monitor: "alarm",
  chat_history_search: "search",
  web_search: "search",
  web_fetch: "link",
  chat_history_read: "history",
  name_thread: "history",
  list_threads: "history",
  read_thread: "history",
  send_to_thread: "worker",
  archive_thread: "worker",
  label_thread: "history",
  task_board: "plan",
  sticky_notes: "note",
  calendar: "calendar",
  await_stop: "monitor",
  waiting_on_you: "worker",
  ask_user: "question",
  withdraw_question: "question",
  manage_schedule: "schedule",
  list_schedules: "schedule",
  create_schedule: "schedule",
  update_schedule: "schedule",
  pause_schedule: "schedule",
  resume_schedule: "schedule",
  run_schedule_now: "schedule",
  delete_schedule: "schedule",
  notify: "notify",
  subagent: "task",
  list_tasks: "task",
  stop_task: "task"
} satisfies Record<string, ToolKind>));

/** A monitor is drawn by what it waits on: a pane like a pane read,
 *  a command as a monitor of its own. */
export function toolKind(toolName: string, args?: unknown): ToolKind {
  if (toolName === "monitor") return isRecord(args) && isRecord(args.command) ? "monitor" : "pane";
  return KINDS.get(toolName) ?? "tool";
}
