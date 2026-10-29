import { isRecord } from "@shared/guards";

/** What kind of work a tool does, for the icon its calls are drawn with (the
 *  kind, faint, and no mark for success). */
export type ToolKind =
  | "terminal" | "file" | "edit" | "write" | "image" | "pane" | "memory" | "skill"
  | "plan" | "canvas" | "feature" | "alarm" | "search" | "history" | "link" | "monitor" | "question" | "tool";

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
  update_plan: "plan",
  read_plan: "plan",
  dismiss_work_item: "plan",
  canvas_create: "canvas",
  canvas_publish: "canvas",
  canvas_read: "canvas",
  canvas_update: "canvas",
  canvas_outline: "canvas",
  canvas_remove_section: "canvas",
  feature_message_send: "feature",
  read_feature_thread: "feature",
  get_feature_status: "feature",
  archive_feature: "feature",
  restore_feature: "feature",
  create_feature: "feature",
  list_features: "feature",
  create_project: "feature",
  list_projects: "feature",
  archive_project: "feature",
  end_sweep: "feature",
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
  message_feature: "feature",
  send_to_thread: "feature",
  archive_thread: "feature",
  await_stop: "monitor",
  waiting_on_you: "feature",
  ask_user: "question",
  withdraw_question: "question"
} satisfies Record<string, ToolKind>));

/** A monitor is drawn by what it watches: a pane like the watch it replaced,
 *  a command as a monitor of its own. */
export function toolKind(toolName: string, args?: unknown): ToolKind {
  if (toolName === "monitor") return isRecord(args) && isRecord(args.command) ? "monitor" : "pane";
  return KINDS.get(toolName) ?? "tool";
}
