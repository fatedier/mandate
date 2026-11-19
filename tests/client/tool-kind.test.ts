import { expect, test } from "bun:test";
import { toolKind } from "../../src/client/routes/window/chat/tool-kind.js";

test("each tool is drawn by its kind; an unknown one is a plain tool", () => {
  expect([
    "bash", "send_keys", "read", "read_skill_reference", "edit", "write", "view_image",
    "read_pane", "spawn_pane", "memory_search", "memory_remember", "skill",
    "update_plan", "dismiss_work_item", "canvas", "canvas_create", "canvas_publish",
    "create_worker", "message_worker", "list_projects", "schedule_wake", "cancel_alarm",
    "chat_history_search", "chat_history_read", "web_fetch", "no_such_tool"
  ].map(toolKind)).toEqual([
    "terminal", "terminal", "file", "file", "edit", "write", "image",
    "pane", "pane", "memory", "memory", "skill",
    "plan", "plan", "canvas", "canvas", "canvas",
    "worker", "worker", "worker", "alarm", "alarm",
    "search", "history", "link", "tool"
  ]);
});

test("a retired tool is drawn as a plain tool", () => {
  expect(["watch_window", "task_update", "ui_navigate", "propose_handoff"].map((name) => toolKind(name))).toEqual(["tool", "tool", "tool", "tool"]);
});

test("a name the map does not own is a plain tool, even one every object inherits", () => {
  expect(["constructor", "toString", "__proto__", "hasOwnProperty"].map(toolKind)).toEqual(["tool", "tool", "tool", "tool"]);
});

test("the personal agent's archive of a thread is drawn like the other things done to workers and threads", () => {
  expect(["archive_thread", "archive_worker", "send_to_thread"].map(toolKind)).toEqual(["worker", "worker", "worker"]);
});

test("the personal agent's labels on a thread are drawn as its naming of one is", () => {
  expect(toolKind("label_thread")).toBe(toolKind("name_thread"));
});

test("the manager's thread naming has a kind of its own", () => {
  expect(toolKind("name_thread")).toBe("history");
});

test("a monitor is drawn as a pane when it watches one, and as a monitor when it runs a command", () => {
  expect(toolKind("monitor", { pane: { paneId: "%1" } })).toBe("pane");
  expect(toolKind("monitor", { command: { run: "gh pr checks 1", every: "2m" } })).toBe("monitor");
  // Arguments in a form not read: a pane, as the old watch was.
  expect(toolKind("monitor", "garbled")).toBe("pane");
  expect(["list_my_monitors", "cancel_monitor"].map((name) => toolKind(name))).toEqual(["alarm", "alarm"]);
});

test("asking the user and taking a question back have a kind of their own", () => {
  expect(["ask_user", "withdraw_question"].map((name) => toolKind(name))).toEqual(["question", "question"]);
});

test("schedules, notices and background tasks have a kind each", () => {
  expect([
    "manage_schedule", "list_schedules", "create_schedule", "update_schedule", "pause_schedule", "resume_schedule", "run_schedule_now", "delete_schedule",
    "notify", "subagent", "list_tasks", "stop_task"
  ].map((name) => toolKind(name))).toEqual([
    "schedule", "schedule", "schedule", "schedule", "schedule", "schedule", "schedule", "schedule",
    "notify", "task", "task", "task"
  ]);
});
