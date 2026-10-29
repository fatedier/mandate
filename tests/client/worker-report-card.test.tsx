import { expect, test } from "bun:test";
import { act } from "react";
import { WorkerReportCard } from "../../src/client/routes/window/chat/WorkerReportCard.js";
import type { WorkerReport } from "../../src/shared/worker-report.js";
import { mount } from "../helpers/mount.js";

const report: WorkerReport = {
  featureId: "feat-project-1", featureName: "project-1-release", projectId: "p1", projectName: "project-1",
  key: "done", line: "Plan finished: tag v3.21 pushed, release notes drafted."
};

function render(onOpen?: (featureId: string) => void) {
  return mount(<WorkerReportCard report={report} onOpen={onOpen} />).host;
}

test("a report shows who, where, the state and its line", () => {
  const host = render();
  const card = host.querySelector('[data-slot="worker-report"]')!;
  expect(card.getAttribute("data-key")).toBe("done");
  expect(card.textContent).toContain("project-1-release");
  // The worker's name is a title people write: the body font, not mono.
  const name = [...card.querySelectorAll("span")].find((s) => s.textContent === "project-1-release")!;
  expect(name.className.split(/\s+/)).not.toContain("font-mono");
  expect(card.textContent).toContain("project-1");
  expect(card.textContent).toContain("Done");
  expect(card.textContent).toContain("Plan finished: tag v3.21 pushed, release notes drafted.");
});

test("Open in panel opens the reporting worker", () => {
  const opened: string[] = [];
  const host = render((id) => opened.push(id));
  const button = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("Open in panel"));
  expect(button === undefined).toBe(false);
  act(() => button!.click());
  expect(opened).toStrictEqual(["feat-project-1"]);
});

test("without a way to open a worker, the card has no button", () => {
  const host = render();
  expect(host.querySelectorAll("button")).toHaveLength(0);
});

test("a worker that went quiet shows so", () => {
  const host = mount(<WorkerReportCard report={{ ...report, key: "silent", line: "Its turn ended with steps left and nothing set to wake it, and it told you nothing." }} />).host;
  const card = host.querySelector('[data-slot="worker-report"]')!;
  expect(card.getAttribute("data-key")).toBe("silent");
  expect(card.textContent).toContain("Went quiet");
});
