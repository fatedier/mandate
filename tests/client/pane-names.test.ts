import { expect, test } from "bun:test";
import { paneNamesFrom } from "@/lib/pane-names";
import type { TypedSnapshot } from "@/lib/snapshot-types";

test("pane names come from the panes that have one, across every session", () => {
  const snapshot = {
    sessions: [
      { windows: [{ panes: [
        { paneId: "%133", metadata: { name: "Codex review", description: "", updatedAt: "" } },
        { paneId: "%134" }
      ] }] },
      { windows: [{ panes: [
        { paneId: "%9", metadata: { name: "   ", description: "", updatedAt: "" } },
        { paneId: "%10", metadata: { name: " e2e ", description: "", updatedAt: "" } }
      ] }] }
    ]
  } as unknown as TypedSnapshot;
  expect([...paneNamesFrom(snapshot)]).toEqual([["%133", "Codex review"], ["%10", "e2e"]]);
  expect(paneNamesFrom(null).size).toBe(0);
});
