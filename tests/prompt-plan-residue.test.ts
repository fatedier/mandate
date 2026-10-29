import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const worker = readFileSync("src/server/modules/agent/prompts/worker.md", "utf8");
const manager = readFileSync("src/server/modules/agent/prompts/manager.md", "utf8");

test("the prompts speak of the plan and reports, not the retired channels", () => {
  for (const gone of [
    "update_my_work_item", "update_feature_digest", "bindToFeature", "bound canvas", "feature digest",
    "feature_task_send", "task_complete", "task_notify_caller", "task_claim", "task_list", "task_update",
    "INCOMING FEATURE EVENTS", "chat_reply", "kind=completion"
  ]) {
    expect(worker).not.toContain(gone);
    expect(manager).not.toContain(gone);
  }
  expect(worker).toContain("## Your plan");
  for (const status of ["`pending`", "`in_progress`", "`done`", "`blocked`"]) expect(worker).toContain(status);
  expect(worker).toContain("update_plan");
  expect(worker).toContain("the manager is told the\n  moment you write one");
  expect(manager).toContain("read_plan");
  expect(manager).toContain("includeHistory");
  expect(manager).toContain("RECENT PASSIVE UPDATES");
  expect(manager).toContain("[Worker report]");
  expect(manager).toContain("## Threads");
  expect(manager).toContain("confirmedByUser");
  expect(manager).toContain("`yours: true`");
  expect(manager).toContain("Never answer\na question that asks the user's permission");
});
