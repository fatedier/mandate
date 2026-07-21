import { describe, expect, test } from "bun:test";
import { paneStatusForFeature } from "@/routes/projects/feature-card-data";

function snap(status: string) {
  return {
    sessions: [
      {
        sessionName: "proj",
        windows: [{ windowName: "feat", aggregate: { status } }]
      }
    ]
  };
}

describe("paneStatusForFeature", () => {
  test.each([
    ["working", "running"],
    ["running_service", "running"],
    ["idle_shell", "idle"],
    ["done", "idle"],
    ["waiting_user", null],
    ["unknown", null]
  ] as const)("maps analyzer status %s to %s", (agg, expected) => {
    expect(paneStatusForFeature("proj", "feat", snap(agg))).toBe(expected);
  });

  test("null snapshot and missing window return null", () => {
    expect(paneStatusForFeature("proj", "feat", null)).toBeNull();
    expect(paneStatusForFeature("other", "feat", snap("working"))).toBeNull();
  });

  test("matches a session that carries no host field at all", () => {
    const snapshot = {
      sessions: [{
        sessionName: "proj",
        windows: [{ windowName: "feat", aggregate: { status: "working" } }]
      }]
    };
    expect(paneStatusForFeature("proj", "feat", snapshot)).toBe("running");
  });
});
