import { expect, test } from "bun:test";
import { statusPillFor } from "@/lib/feature-status";
import type { WorkItemDto } from "@shared/api/work-items";

function item(phase: WorkItemDto["phase"], needsUser: WorkItemDto["needsUser"]): WorkItemDto {
  return { id: "wi", featureId: "f", phase, needsUser } as unknown as WorkItemDto;
}

test("attention wins over phase", () => {
  expect(statusPillFor(item("done", "review"))).toEqual({ label: "Needs review", tone: "review" });
  expect(statusPillFor(item("working", "input"))).toEqual({ label: "Needs input", tone: "red" });
});

test("phase pills when nothing is asked of the user", () => {
  expect(statusPillFor(item("done", null))).toEqual({ label: "Done", tone: "green" });
  expect(statusPillFor(item("working", null))).toEqual({ label: "Working", tone: "blue" });
  expect(statusPillFor(item("verifying", null))).toEqual({ label: "Verifying", tone: "cyan" });
  expect(statusPillFor(item("design", null))).toEqual({ label: "Design", tone: "violet" });
});

test("no work item, no pill", () => {
  expect(statusPillFor(null)).toBe(null);
});
